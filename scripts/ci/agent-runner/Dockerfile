# Self-hosted GitHub Actions runner for heron's agent workflows.
#
# Serves the `heron` label: pr-review, pr-revise, issue-triage, issue-implement
# and pr-review-probe. Those jobs check out PR-branch code and run this repo's
# `just build all && just test all`, so they need a full toolchain — and they
# must not run on the production host, which is why this is a container.
#
# Build:
#   docker build -t heron-agent-runner scripts/ci/agent-runner
#   # optional, on a network where crates.io is slow:
#   docker build --build-arg CARGO_MIRROR_URL=<sparse-index-url> ...
#
# Run: see README.md in this directory.

# The toolchain comes from the official image rather than from `rustup` against
# static.rust-lang.org (or a mirror of it). On a slow link that download is the
# single longest step in this file by an order of magnitude — hours, presenting
# as a build that prints "downloading 3 components" and never says anything
# again — while the same bits arrive as image layers in a couple of minutes.
# Only rustfmt and clippy are fetched, and they are small enough not to matter.
FROM rust:1-bookworm AS toolchain
ARG RUST_MIRROR_URL=""
RUN echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf \
    && if [ -n "$RUST_MIRROR_URL" ]; then \
         export RUSTUP_DIST_SERVER="$RUST_MIRROR_URL" \
                RUSTUP_UPDATE_ROOT="$RUST_MIRROR_URL/rustup"; \
       fi \
    && rustup component add rustfmt clippy

FROM ubuntu:24.04

ARG NODE_MAJOR=22
ARG JUST_VERSION=1.36.0
ARG RUNNER_VERSION=2.336.0
# Empty by default: the image stays generic. Pass a sparse index URL to build on
# a network where the default crates.io index is unusably slow.
ARG CARGO_MIRROR_URL=""
# Ubuntu archive mirror root, e.g. http://<mirror>/ubuntu. Use http, not https:
# the base image has no ca-certificates yet at this point, and apt authenticates
# by signature rather than by transport anyway.
ARG APT_MIRROR_URL=""

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# Prefer IPv4. Built with `--network host` (see README), the build inherits the
# host's IPv6 addresses; where those have no route to the internet, every
# resolver that returns AAAA first produces a different-looking symptom — apt
# says "Network is unreachable", rustup silently crawls at tens of KB/s, and
# curl to github.com just hangs — none of which names the address family. One
# precedence rule fixes all of them, so no per-tool flag has to.
RUN echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf \
    && if [ -n "$APT_MIRROR_URL" ]; then \
         sed -i -e "s|http://archive.ubuntu.com/ubuntu|$APT_MIRROR_URL|g" \
                -e "s|http://security.ubuntu.com/ubuntu|$APT_MIRROR_URL|g" \
                /etc/apt/sources.list.d/ubuntu.sources; \
       fi

# `envsubst` is gettext-base; the review workflow templates its prompts with it.
# libpcap-dev is not optional even for crates that never capture — h-storage
# pulls h-capture in transitively, so the link fails without it.
# libicu / libkrb5 / zlib are what the runner's own bin/installdependencies.sh
# installs for its bundled .NET; without them the listener refuses to start and
# says only "Libicu's dependencies is missing", in a restart loop.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget git jq unzip zip xz-utils sudo \
        python3 python3-venv gettext-base \
        build-essential pkg-config libssl-dev libpcap-dev \
        libicu74 libkrb5-3 zlib1g \
        tzdata locales \
    && rm -rf /var/lib/apt/lists/*

# gh CLI — the agent workflows drive PRs, issues and labels through it.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Node — for the Claude Code CLI, and because `bun run build` shells out to
# tsc through its `#!/usr/bin/env node` shebang. Ubuntu's own node is far too
# old for either.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) j=x86_64-unknown-linux-musl ;; \
         arm64) j=aarch64-unknown-linux-musl ;; \
         *) echo "unsupported arch $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-${j}.tar.gz" \
        | tar -xz -C /usr/local/bin just

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
COPY --from=toolchain /usr/local/rustup /usr/local/rustup
COPY --from=toolchain /usr/local/cargo /usr/local/cargo

RUN useradd -m -s /bin/bash runner \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner \
    && chown -R runner:runner /usr/local/cargo /usr/local/rustup

# Host-local registry mirror, if one was supplied. Kept out of the repo and out
# of the default image: it is a property of the network the image runs on, and
# baking someone else's mirror into a committed Dockerfile is how a build starts
# resolving crates from a host nobody remembers choosing.
RUN if [ -n "$CARGO_MIRROR_URL" ]; then \
      printf '%s\n' \
        '[source.crates-io]' \
        'replace-with = "mirror"' \
        '' \
        '[source.mirror]' \
        "registry = \"$CARGO_MIRROR_URL\"" \
        > "$CARGO_HOME/config.toml" \
      && chown runner:runner "$CARGO_HOME/config.toml"; \
    fi

USER runner
WORKDIR /home/runner

ENV PATH=/usr/local/cargo/bin:/home/runner/.bun/bin:$PATH

RUN curl -fsSL https://bun.sh/install | bash

RUN mkdir -p /home/runner/actions-runner && cd /home/runner/actions-runner \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in amd64) r=x64 ;; arm64) r=arm64 ;; esac \
    && curl -fsSL -o runner.tar.gz \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${r}-${RUNNER_VERSION}.tar.gz" \
    && tar xzf runner.tar.gz && rm runner.tar.gz

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
RUN chmod +x /home/runner/entrypoint.sh

ENTRYPOINT ["/home/runner/entrypoint.sh"]
