#!/usr/bin/env bash
# Register (once) and run the agent runner.
#
# The runner's identity lives in /home/runner/actions-runner, which is expected
# to be a mounted volume — so a container restart re-attaches the same runner
# instead of registering a new one and leaving an offline ghost behind in the
# repo's runner list.
#
# Env:
#   RUNNER_URL     https://github.com/<owner>/<repo>      (required first run)
#   RUNNER_TOKEN   registration token, expires in ~1h     (required first run)
#   RUNNER_NAME    default: agent-runner-<short hostname>
#   RUNNER_LABELS  default: heron
set -euo pipefail

DIR=/home/runner/actions-runner
cd "$DIR"

if [ ! -f .runner ]; then
  : "${RUNNER_URL:?set RUNNER_URL for the first run}"
  : "${RUNNER_TOKEN:?set RUNNER_TOKEN (gh api -X POST repos/OWNER/REPO/actions/runners/registration-token --jq .token)}"
  ./config.sh \
    --url "$RUNNER_URL" \
    --token "$RUNNER_TOKEN" \
    --name "${RUNNER_NAME:-agent-runner-$(hostname -s)}" \
    --labels "${RUNNER_LABELS:-heron}" \
    --work _work \
    --unattended --replace
fi

# Hand signals to the listener so `docker stop` is a clean deregister-free
# shutdown rather than a kill that leaves the job hanging in GitHub's queue.
term() { kill -INT "$child" 2>/dev/null || true; wait "$child"; }
trap term SIGTERM SIGINT

./run.sh &
child=$!
wait "$child"
