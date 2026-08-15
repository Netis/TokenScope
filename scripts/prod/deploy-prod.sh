#!/usr/bin/env bash
# Install a published Heron RELEASE on the production host and gate on health,
# rolling back to the previous binary on failure.
#
# Runs on the `prod-deploy` self-hosted runner ON the prod host, so the deploy
# is LOCAL (download + systemctl restart) — no SSH/VM hop, no toolchain.
#
# Why the release artifact and not a source build. The published tarball is the
# exact, checksummed thing the release gate validated; rebuilding on the host
# reintroduces a compiler, a container, a console bundler and a crates.io fetch
# into the deploy path, each of which can make prod differ from the release or
# stall the deploy for as long as the host's network feels like it. The cost is
# that prod runs whatever features the release matrix builds — today
# `--features console`, i.e. the pcap capture engine but not the eBPF one.
#
# Safety:
#   - downloads and verifies the checksum BEFORE touching the running service,
#     so a bad download leaves prod untouched;
#   - snapshots the current binary first and rolls back + restarts if the
#     post-restart gate fails;
#   - the gate is health AND a read-path smoke, so a build that comes up but
#     answers 500 to the console does not count as a successful deploy;
#   - heron.service grants capture caps via AmbientCapabilities, so no setcap.
#
# Usage:
#   deploy-prod.sh [<tag>]        (default: the repository's latest release)
#
# Env:
#   GH_TOKEN             GitHub token for the release API (required for a
#                        private repo; also lifts the anonymous rate limit)
#   GITHUB_REPOSITORY    owner/repo               (default: Netis/heron)
#   HERON_PROD_BIN       installed binary path    (default: /opt/heron/heron)
#   HERON_PROD_SERVICE   systemd unit             (default: heron.service)
#   HERON_PROD_PORT      heron API port           (default: 4500)
#   HEALTH_TIMEOUT_SECS  health-gate budget secs  (default: 120)
#
# Exit: 0 = deployed + healthy; non-zero = failed (rolled back if possible).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TAG="${1:-}"
REPO_SLUG="${GITHUB_REPOSITORY:-Netis/heron}"
API="${GITHUB_API_URL:-https://api.github.com}"
BIN="${HERON_PROD_BIN:-/opt/heron/heron}"
SERVICE="${HERON_PROD_SERVICE:-heron.service}"
PORT="${HERON_PROD_PORT:-4500}"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-120}"
BAK="$BIN.rollback"

for c in curl tar sha256sum python3; do
  command -v "$c" >/dev/null 2>&1 || { echo "::error::$c not found on the prod host" >&2; exit 1; }
done

auth=()
[ -n "${GH_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GH_TOKEN")

api() {
  curl -fsSL "${auth[@]}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

# ---------------------------------------------------------------- resolve tag
if [ -z "$TAG" ]; then
  TAG="$(api "$API/repos/$REPO_SLUG/releases/latest" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
  echo "==> latest release resolves to $TAG"
fi
echo "==> deploying $REPO_SLUG $TAG"

case "$(uname -m)" in
  x86_64|amd64)  TARGET=x86_64-unknown-linux-musl ;;
  aarch64|arm64) TARGET=aarch64-unknown-linux-musl ;;
  *) echo "::error::no release build for machine $(uname -m)" >&2; exit 1 ;;
esac
ASSET="heron-${TAG}-${TARGET}.tar.gz"

# ------------------------------------------------------------------- download
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Assets are fetched through the API's asset endpoint rather than
# browser_download_url so the same code path works for a private repo.
echo "==> fetching $ASSET + SHA256SUMS"
rel_json="$WORK/release.json"
api "$API/repos/$REPO_SLUG/releases/tags/$TAG" -o "$rel_json"

asset_id() {
  python3 -c '
import json, sys
name, path = sys.argv[1], sys.argv[2]
for a in json.load(open(path)).get("assets", []):
    if a["name"] == name:
        print(a["id"])
        break
else:
    sys.exit("no asset named " + name + " on this release")
' "$1" "$rel_json"
}

for f in "$ASSET" SHA256SUMS; do
  id="$(asset_id "$f")"
  curl -fsSL "${auth[@]}" -H "Accept: application/octet-stream" \
    "$API/repos/$REPO_SLUG/releases/assets/$id" -o "$WORK/$f"
done

echo "==> verifying checksum"
( cd "$WORK" && grep -F " $ASSET" SHA256SUMS > want.sha256 \
  && [ -s want.sha256 ] \
  && sha256sum -c want.sha256 ) \
  || { echo "::error::checksum mismatch, or $ASSET is absent from SHA256SUMS — refusing to install" >&2; exit 1; }

tar -C "$WORK" -xzf "$WORK/$ASSET"
NEW="$WORK/heron-${TAG}-${TARGET}/heron"
[ -x "$NEW" ] || { echo "::error::release tarball has no executable heron at $NEW" >&2; exit 1; }

echo "==> smoke: heron --version"
got="$("$NEW" --version)"
echo "    $got"
# The tag is the release identity; the binary embeds VERSION. A mismatch means
# the tag and the VERSION file disagreed at release time, which turns every
# later "which build is prod running" answer into a guess.
case "$got" in
  *"${TAG#v}"*) ;;
  *) echo "::error::binary reports '$got' but the tag is $TAG — refusing to install a mislabelled build" >&2; exit 1 ;;
esac

# -------------------------------------------------------------------- install
if [ -x "$BIN" ]; then
  echo "==> snapshotting current binary → $(basename "$BAK")"
  sudo cp -fp "$BIN" "$BAK"
  HAVE_BAK=1
else
  echo "    (no existing binary to back up — first deploy)"
  sudo mkdir -p "$(dirname "$BIN")"
  HAVE_BAK=0
fi

sudo install -m0755 "$NEW" "$BIN"

# A binary that refuses to start crash-loops under `Restart=on-failure` for the
# length of the health gate, which can trip systemd's start-rate limit and leave
# the unit `failed`. From there `systemctl restart` answers "start request
# repeated too quickly" — the rollback would fail exactly when it is needed.
# Clear the counter before every restart so it cannot.
restart_service() {
  sudo systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
  sudo systemctl restart "$SERVICE"
}

echo "==> restarting $SERVICE"
restart_service

# ------------------------------------------------------------------- the gate
gate() {
  local deadline res
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # status must be ready, and IF a capture pipeline is configured it must be
    # running. Empty `pipelines` (API-only / maintenance) → treat as healthy
    # rather than IndexError-crashing into a false rollback of a healthy deploy.
    res="$(curl -s -m 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null \
          | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)["data"]; pl=d.get("pipelines") or []
    print(d["status"]+"|"+str(pl[0]["running"] if pl else True).lower())
except Exception: print("|")' 2>/dev/null || echo "|")"
    if [ "${res%%|*}" = "ready" ] && [ "${res##*|}" = "true" ]; then
      echo "    health: ready + capturing"
      # Liveness says the process came up; it says nothing about whether the
      # storage backend can answer. Give every console read path one request.
      python3 "$SCRIPT_DIR/smoke-api.py" "http://127.0.0.1:${PORT}" || return 1
      return 0
    fi
    sleep 5
  done
  echo "::error::health gate timed out after ${HEALTH_TIMEOUT_SECS}s" >&2
  return 1
}

if gate; then
  echo "==> OK prod heron $TAG healthy on :${PORT}"
  sudo rm -f "$BAK"
  exit 0
fi

echo "::error::post-deploy gate FAILED" >&2
if [ "$HAVE_BAK" = 1 ]; then
  echo "==> rolling back to the previous binary + restarting"
  sudo cp -fp "$BAK" "$BIN"
  restart_service
  sleep 5
  rb="$(curl -s -m 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["data"]["status"])
except Exception: print("?")' 2>/dev/null || echo "?")"
  echo "    rollback health: status=$rb"
  sudo rm -f "$BAK"
else
  echo "::error::no rollback binary available (first deploy)" >&2
fi
exit 1
