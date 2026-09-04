
# Pre-configured coding environment for sandboxed agent tasks.
# Runs as its own lightweight Linux VM via Apple `container` on macOS 26+.
#
# Design rules:
#   - NO secrets baked in. Credentials are injected per-run at container start.
#   - Runs as a non-root user by default (defense in depth inside the VM).
#   - Everything an agent needs to build/test should be present at image build
#     time, so a task can run with egress disabled.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Toolchain. build-essential + python3 are required by node-gyp for any
# dependency with native bindings; omitting them is the most common cause of
# "works on host, fails in sandbox".
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        wget \
        ripgrep \
        jq \
        less \
        openssh-client \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. UID 1000 already exists as `node` in this base image.
USER node
WORKDIR /work

# Keep npm's cache inside the writable workspace so a read-only rootfs stays
# possible later.
ENV NPM_CONFIG_CACHE=/work/.npm-cache \
    GIT_TERMINAL_PROMPT=0

CMD ["bash"]
