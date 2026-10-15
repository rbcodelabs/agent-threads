#!/usr/bin/env bash
# Install the agent-threads daemon for the current user on Linux, from a published release.
#
#   curl -fsSL https://raw.githubusercontent.com/rbcodelabs/agent-threads/main/deploy/install.sh | bash
#   AGENT_THREADS_VERSION=0.63.0 bash deploy/install.sh        # a specific release
#   bash deploy/install.sh --no-start                           # install, but do not start the service
#
# What it does (and nothing else): checks Node 22+, downloads dist/agent-threads.cjs and its SHA-256 from the
# GitHub release, verifies the checksum, puts the bundle under ~/.local/share/agent-threads/, links
# ~/.local/bin/agent-threads, then runs `agent-threads install`, which sets up the systemd USER service
# (idempotent; see docs/remote-daemon.md). It does not need root, creates no tokens and installs no Claude CLI.
set -euo pipefail

REPO="${AGENT_THREADS_REPO:-rbcodelabs/agent-threads}"
VERSION="${AGENT_THREADS_VERSION:-latest}"
PREFIX="${AGENT_THREADS_PREFIX:-$HOME/.local/share/agent-threads}"
BIN_DIR="${AGENT_THREADS_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required (https://nodejs.org)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading agent-threads ($VERSION) from $REPO ..."
curl -fsSL --retry 3 -o "$tmp/agent-threads.cjs" "$base/agent-threads.cjs" \
  || die "could not download agent-threads.cjs from $base (does that release include the daemon bundle?)"
curl -fsSL --retry 3 -o "$tmp/agent-threads.cjs.sha256" "$base/agent-threads.cjs.sha256" \
  || die "could not download the checksum file; refusing to install an unverified bundle"
(cd "$tmp" && sha256sum --check --status agent-threads.cjs.sha256) \
  || die "checksum mismatch: the download is corrupt or has been tampered with; not installing"

mkdir -p "$PREFIX/dist" "$PREFIX/bin" "$BIN_DIR"
install -m 0644 "$tmp/agent-threads.cjs" "$PREFIX/dist/agent-threads.cjs"
cat > "$PREFIX/bin/agent-threads" <<'LAUNCHER'
#!/usr/bin/env node
require('../dist/agent-threads.cjs');
LAUNCHER
chmod 0755 "$PREFIX/bin/agent-threads"
ln -sfn "$PREFIX/bin/agent-threads" "$BIN_DIR/agent-threads"
say "Installed $("$BIN_DIR/agent-threads" --version) to $PREFIX (linked at $BIN_DIR/agent-threads)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Note: $BIN_DIR is not on your PATH; add it, or call $BIN_DIR/agent-threads directly." ;;
esac

if [ "$(uname -s)" != Linux ]; then
  say "Not Linux: skipping the systemd setup. Run \`agent-threads serve\` yourself, or use Docker (docs/remote-daemon.md)."
  exit 0
fi
exec "$BIN_DIR/agent-threads" install "$@"
