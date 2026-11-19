#!/usr/bin/env bash
# Build the committed pin and exercise it without host data or outside network.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
engine="${CONTAINER_ENGINE:-docker}"
version="$(node scripts/codex-harness-version.mjs --print-pin)"
image="localhost/agent-threads-codex-candidate:smoke-$$"
trap '"$engine" image rm "$image" >/dev/null 2>&1 || true' EXIT

"$engine" build --target with-harnesses --file sandbox/Dockerfile.daemon \
  --build-arg INSTALL_CODEX=1 --build-arg "CODEX_VERSION=$version" --tag "$image" .
"$engine" run --rm --network=none --entrypoint node \
  --mount "type=bind,source=$PWD/scripts/codex-candidate-smoke.mjs,target=/codex-candidate-smoke.mjs,readonly" \
  "$image" /codex-candidate-smoke.mjs "$version"
