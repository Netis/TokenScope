# Production deploy

Production runs **releases**. Publishing a tag is what ships it: `deploy-prod`
fires on `release: published`, installs the published artifact on the prod host,
and gates on health plus a read-path smoke, rolling back on failure.

## Chain

```
ci(main) → deploy-staging → { staging-soak (tara), ebpf-soak }
   │  both stamp commit statuses
   ▼
tag v* → release.yml
   ├─ gate: refuses to build unless the tagged commit is
   │        `staging-soaked` ✅ AND `ebpf-soaked` ✅
   └─ builds + publishes the multi-arch binaries
        │
        ▼  release: published
deploy-prod.yml
   ├─ runs on the `prod-deploy` self-hosted runner ON the prod host
   └─ deploy-prod.sh <tag>
          ├─ resolve the asset for this machine's arch
          ├─ download it + SHA256SUMS, verify the checksum
          ├─ `heron --version` must agree with the tag
          ├─ snapshot the current binary (for rollback)
          ├─ sudo install + sudo systemctl restart heron.service
          ├─ gate: /api/health ready + capturing (≤120s), THEN smoke-api.py
          └─ rollback to the snapshot + restart if the gate fails
```

Nothing is installed until the download verifies, so a bad fetch leaves prod
untouched. `heron.service` grants capture caps via `AmbientCapabilities`, so no
`setcap` is ever needed.

## Why the release artifact, not a source build

Prod used to `git checkout` a soaked commit and build it in a container on the
host. Installing the published tarball instead means prod runs the exact bytes
the release gate validated, verified by checksum — no compiler, no bundler and
no crates.io fetch in the deploy path, each of which is a way for prod to end up
subtly different from the release, or for a deploy to stall on whatever the
host's network is doing that day.

The trade-off is real and worth stating: **prod gets whatever features the
release matrix builds.** That is `--features console` today — the pcap capture
engine, not the eBPF one. The plaintext HTTP a co-located inference server
serves is covered by pcap; a host that needs on-host TLS uprobe capture has to
build the binary itself. `Dockerfile.ebpf-build` in this directory is that
recipe — an Ubuntu-22.04 image with the nightly + `bpf-linker` toolchain, which
produces a glibc-2.35 binary with `h-capture/ebpf` compiled in:

```bash
docker build -t heron-ebpf-builder:22.04 -f scripts/prod/Dockerfile.ebpf-build scripts/prod
docker run --rm --ulimit nofile=1048576:1048576 -v "$PWD":/src:ro -v /tmp/out:/out \
  heron-ebpf-builder:22.04 bash -euo pipefail -c '
    git config --global --add safe.directory "*"
    mkdir -p /build/heron && git -C /src archive HEAD | tar -x -C /build/heron
    cp -r /src/console/dist /build/heron/console/dist
    cd /build/heron/server
    cargo build --release --bin heron --features "console h-capture/ebpf"
    install -m0755 target/release/heron /out/heron'
```

Install that binary at `HERON_PROD_BIN` and the unit also needs `CAP_BPF
CAP_PERFMON CAP_SYS_ADMIN` (the uprobe `perf_event_open` is gated on
`CAP_SYS_ADMIN` specifically). Note that a subsequent `deploy-prod` run will
overwrite it with the release build.

## Why no manual approval

There is one, and it is cutting the tag. `release.yml` will not build a tag
whose commit lacks both soak statuses, so a release cannot exist without the
evidence a reviewer used to check by hand. A second approval between "someone
deliberately published v1.2.3" and "v1.2.3 is running" only adds a window in
which the release notes are true and the production host is not.

## The `prod-deploy` runner

A self-hosted runner on the prod host (systemd service, runs as the deploy
user). It is **only** used by `deploy-prod.yml`, whose triggers — `release:
published` and `workflow_dispatch` — cannot be raised by a fork or a PR. Its
label is not shared with PR CI, so untrusted code never executes on the prod
host.

## Config (no machine-specifics in source)

`deploy-prod.sh` reads, all optional:

| Env | Default | |
|---|---|---|
| `HERON_PROD_BIN` | `/opt/heron/heron` | installed binary path |
| `HERON_PROD_SERVICE` | `heron.service` | systemd unit to restart |
| `HERON_PROD_PORT` | `4500` | API port the gate polls |
| `HEALTH_TIMEOUT_SECS` | `120` | gate budget |
| `GH_TOKEN` | — | release API auth (the workflow passes `GITHUB_TOKEN`) |

Set the first three as repo Variables if the host differs from the defaults.

Unlike staging (which ships `scripts/staging/{config.toml,heron.service}`), the
**prod config and systemd unit are provisioned on the host, not in this repo** —
they hold host-specific interfaces, ports and secrets. `deploy-prod.sh` only
swaps the binary and restarts the existing unit; it never templates either file.
The unit must grant capture caps via `AmbientCapabilities=CAP_NET_RAW
CAP_NET_ADMIN` and set `Restart=on-failure`.

**The config's directory has to be writable by the service user**, not just the
file. The Settings UI rewrites the config by writing a temp file beside it and
renaming (so a partial write can never be observed), and both of those need the
directory. Provision it with `sudo mkdir` and the file will look correct —
owned by the service user, mode 0600 — while Save & restart fails with
`config write failed: write config file: Permission denied (os error 13)`.
Give the whole directory to the service user; 0700 is right when it also holds
credentials.

## The gate is two checks, not one

`/api/health` answers whether the process came up and the capture pipeline is
running. It cannot fail for a binary whose storage backend answers 500 to every
query — the pipeline writes, the port is open, and every page of the console is
broken. So the gate also runs `smoke-api.py`, which sends one request to every
endpoint the console calls (lists, their page 2, aggregates, topology, filter
dropdowns, and one detail lookup per entity) and fails the deploy on any
non-200. An instance with no traffic answers all of them with empty results, so
this is safe on a quiet host.

```bash
scripts/prod/smoke-api.py http://127.0.0.1:4500 [--window-secs 3600]
```

## Manual deploy / dispatch

```bash
# On the prod host — latest release, or a specific tag:
scripts/prod/deploy-prod.sh
scripts/prod/deploy-prod.sh v0.7.1

# Or from anywhere, through the workflow:
gh workflow run deploy-prod.yml --repo Netis/heron -f tag=v0.7.1
```

Pinning prod to an earlier release is the same command with the older tag — the
script installs whatever tag it is given, so backing out a bad release is a
dispatch, not a rebuild.
