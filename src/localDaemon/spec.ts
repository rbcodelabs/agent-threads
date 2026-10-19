/**
 * Local daemon: constants, the thin Claude layer, and every `container` argv
 * builder. Pure: no I/O, no Node built-ins at module scope (the plugin bundle
 * also loads on mobile). Design: docs/local-daemon-design.md sections 4.3-4.4.
 *
 * Nothing under `src/localDaemon/` may be imported by the core closure
 * (`core-files.json`); a unit test pins that.
 */

import { buildImagePullArgs } from '../sandboxImage';
import { DEFAULT_VM_CPUS, DEFAULT_VM_MEMORY } from '../sandboxVm';

// ── Names, labels, ports ─────────────────────────────────────────────────────

export const DAEMON_IMAGE_REPOSITORY = 'ghcr.io/rbcodelabs/agent-threads-daemon';
export const LOCAL_IMAGE_REPOSITORY = 'agent-threads-daemon-local';

export const LABEL_OWNER = 'com.rbcodelabs.agent-threads.local-daemon';
export const LABEL_VERSION = 'com.rbcodelabs.agent-threads.local-daemon.version';
export const LABEL_SPEC = 'com.rbcodelabs.agent-threads.local-daemon.spec';
export const LABEL_VAULT = 'com.rbcodelabs.agent-threads.local-daemon.vault';
/** Stamped on the locally built image so it can be identified. */
export const LABEL_IMAGE_VERSION = 'com.rbcodelabs.agent-threads.local-daemon.image-version';

/** The port the daemon listens on inside the container (the image default). */
export const DAEMON_INTERNAL_PORT = 7433;
export const DEFAULT_HOST_PORT = 7433;
/** Search window for a free host port when the preferred one is taken. */
export const HOST_PORT_SEARCH_LIMIT = 20;

export const DATA_MOUNT = '/var/lib/agent-threads';
export const WORKSPACES_MOUNT = '/srv/workspaces';
export const CREDENTIALS_DIR = `${DATA_MOUNT}/creds`;
export const CREDENTIAL_FILE = `${CREDENTIALS_DIR}/claude-token`;
/** Where the vault appears inside the daemon container (same convention as the per-thread sandbox). */
export const VAULT_GUEST_PATH = '/vault';
/** Config directories masked read-only inside the vault mount: a writable copy would be code execution on the Mac. */
export const MASKED_VAULT_DIRS: readonly string[] = ['.geode', '.obsidian'];
export const DAEMON_UID = 10001;
/** Where the `with-claude` layer puts the CLI (outside every VOLUME path). */
export const CLAUDE_BINARY_IN_IMAGE = '/opt/claude/.local/bin/claude';
/** Where the `with-harnesses` layer puts the Codex and OpenCode CLIs (outside every VOLUME path). */
export const HARNESS_BIN_DIR = '/opt/harnesses/bin';
export const CODEX_BINARY_IN_IMAGE = `${HARNESS_BIN_DIR}/codex`;
export const OPENCODE_BINARY_IN_IMAGE = `${HARNESS_BIN_DIR}/opencode`;
/** The daemon user's HOME inside the container: in the data volume, so logins survive restarts and updates. */
export const DAEMON_HOME = `${DATA_MOUNT}/home`;
/** Where `codex login` and `opencode auth login` leave their credentials (inside {@link DAEMON_HOME}). */
export const CODEX_AUTH_FILE = `${DAEMON_HOME}/.codex/auth.json`;
export const OPENCODE_AUTH_FILE = `${DAEMON_HOME}/.local/share/opencode/auth.json`;

// ── Harnesses ────────────────────────────────────────────────────────────────

export type LocalHarness = 'claude' | 'codex' | 'opencode';
/** Canonical order: also the order of the daemon's allowed set and of the image tag. */
export const LOCAL_HARNESSES: readonly LocalHarness[] = ['claude', 'codex', 'opencode'];
export const DEFAULT_LOCAL_HARNESSES: readonly LocalHarness[] = ['claude'];
export const HARNESS_LABEL: Record<LocalHarness, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

/** The enabled set from settings: known names only, canonical order, never empty (Claude, the default). */
export function normalizeHarnesses(raw: readonly string[] | undefined): LocalHarness[] {
  const picked = LOCAL_HARNESSES.filter((h) => (raw ?? []).includes(h));
  return picked.length > 0 ? picked : [...DEFAULT_LOCAL_HARNESSES];
}

export function isDefaultHarnessSet(harnesses: readonly string[] | undefined): boolean {
  const n = normalizeHarnesses(harnesses);
  return n.length === 1 && n[0] === 'claude';
}

/** Name of the control token this plugin mints inside the daemon. */
export const LOCAL_TOKEN_NAME = 'geode-local';
export const LOCAL_DAEMON_ID = 'this-mac-container';
export const LOCAL_DAEMON_NAME = 'This Mac (container)';

export const LOCAL_DAEMON_MEMORY = DEFAULT_VM_MEMORY;
export const LOCAL_DAEMON_CPUS = DEFAULT_VM_CPUS;

/**
 * Oldest daemon this plugin will keep talking to. Bump ONLY when the plugin
 * starts requiring a newer daemon (design section 8).
 */
export const MIN_LOCAL_DAEMON_VERSION = '0.64.0';

/** Pull/build are far longer than the 120 s lifecycle cap; same budgets as the sandbox image pipeline. */
export const PULL_TIMEOUT_MS = 30 * 60_000;
export const BUILD_TIMEOUT_MS = 20 * 60_000;
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// ── Hashing (not security: names and drift detection only) ───────────────────

/** cyrb53 with two seeds: 106 bits, deterministic, no `crypto` import. */
function hashHex(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 2246822519);
    h4 = Math.imul(h4 ^ ch, 3266489917);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h4 ^ (h4 >>> 13), 3266489909);
  h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  return [h1, h2, h3, h4].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}

/** 8 hex chars identifying a vault path: one daemon, volumes and token per vault. */
export function vaultHash(vaultPath: string): string {
  return hashHex(vaultPath.replace(/\/+$/, '')).slice(0, 8);
}

export function containerNameFor(vaultPath: string): string {
  return `agent-threads-local-${vaultHash(vaultPath)}`;
}
export function dataVolumeFor(vaultPath: string): string {
  return `${containerNameFor(vaultPath)}-data`;
}
export function workspacesVolumeFor(vaultPath: string): string {
  return `${containerNameFor(vaultPath)}-workspaces`;
}

export function publishedImageRef(version: string): string {
  return `${DAEMON_IMAGE_REPOSITORY}:${version}`;
}
/**
 * The locally built image. Claude-only (the default) keeps the plain `<version>` tag it always had; any other set
 * gets its own tag (`<version>-claude-codex`), so changing the toggles builds a new layer and never reuses a stale one.
 */
export function localImageRef(version: string, harnesses?: readonly string[]): string {
  return isDefaultHarnessSet(harnesses)
    ? `${LOCAL_IMAGE_REPOSITORY}:${version}`
    : `${LOCAL_IMAGE_REPOSITORY}:${version}-${normalizeHarnesses(harnesses).join('-')}`;
}

// ── The thin Claude layer ────────────────────────────────────────────────────

/**
 * Body of the `with-claude` stage of `sandbox/Dockerfile.daemon`, verbatim
 * (everything after its `FROM` line). A unit test asserts it equals the real
 * file, the same drift guard as `HARNESS_DOCKERFILE`. The full file cannot be
 * built from a plugin install: its `builder` stage copies `src/` and `daemon/`.
 */
export const WITH_CLAUDE_STAGE_BODY = `USER root
# The Claude CLI goes OUTSIDE every VOLUME path. Under /var/lib/agent-threads/home it would be copied into a named
# volume once and then frozen there across image upgrades (or hidden entirely by a bind mount). The login and the
# sessions still live in the persisted HOME; only the program itself is part of the image.
RUN install -d -o agentthreads -g agentthreads -m 0755 /opt/claude
USER agentthreads
RUN curl -fsSL https://claude.ai/install.sh | HOME=/opt/claude bash
ENV PATH="/opt/claude/.local/bin:\${PATH}" \\
    DISABLE_AUTOUPDATER=1
`;

/**
 * Body of the `with-harnesses` stage of `sandbox/Dockerfile.daemon`, verbatim (everything after its `FROM` line, up to
 * the next stage). Pinned to the real file by a unit test, like {@link WITH_CLAUDE_STAGE_BODY}. It installs nothing
 * unless `INSTALL_CODEX` / `INSTALL_OPENCODE` are `1`, which {@link buildThinImageArgs} passes.
 */
export const WITH_HARNESSES_STAGE_BODY = `ARG INSTALL_CODEX=0
ARG INSTALL_OPENCODE=0
ARG CODEX_VERSION=latest
ARG OPENCODE_VERSION=1.18.32
USER root
RUN install -d -o agentthreads -g agentthreads -m 0755 /opt/harnesses
USER agentthreads
# opencode-ai fetches/links its platform binary in a postinstall script. npm 11 blocks dependency install scripts by
# default (a silent skip leaves a launcher with no binary), so that one package is explicitly allowed; older npm
# ignores the flag. The \`--version\` calls fail the build if either CLI did not end up runnable.
RUN set -eu; \\
    pkgs=""; \\
    if [ "$INSTALL_CODEX" = "1" ]; then pkgs="$pkgs @openai/codex@\${CODEX_VERSION}"; fi; \\
    if [ "$INSTALL_OPENCODE" = "1" ]; then pkgs="$pkgs opencode-ai@\${OPENCODE_VERSION}"; fi; \\
    if [ -n "$pkgs" ]; then npm install --global --no-audit --no-fund --allow-scripts=opencode-ai --prefix /opt/harnesses $pkgs; fi; \\
    if [ "$INSTALL_CODEX" = "1" ]; then /opt/harnesses/bin/codex --version; fi; \\
    if [ "$INSTALL_OPENCODE" = "1" ]; then /opt/harnesses/bin/opencode --version; fi
ENV PATH="/opt/harnesses/bin:\${PATH}"
`;

/**
 * The thin layer for an enabled set: the published base, then the Codex/OpenCode CLIs if either is on, then the
 * Claude CLI if it is on. Claude-only is byte for byte what it was before harness toggles existed.
 */
export function thinDockerfileFor(harnesses?: readonly string[]): string {
  const set = normalizeHarnesses(harnesses);
  const names = set.map((h) => HARNESS_LABEL[h]).join(', ');
  const others = set.includes('codex') || set.includes('opencode');
  if (!others) {
    return `# agent-threads local daemon: adds the Claude Code CLI on top of the published daemon image.
# Generated by the plugin from the \`with-claude\` stage of sandbox/Dockerfile.daemon.
ARG BASE_IMAGE
FROM \${BASE_IMAGE}
${WITH_CLAUDE_STAGE_BODY}`;
  }
  return `# agent-threads local daemon: adds the ${names} CLI${set.length > 1 ? 's' : ''} on top of the published daemon image.
# Generated by the plugin from the \`with-harnesses\` and \`with-claude\` stages of sandbox/Dockerfile.daemon.
ARG BASE_IMAGE
FROM \${BASE_IMAGE}
${WITH_HARNESSES_STAGE_BODY}${set.includes('claude') ? WITH_CLAUDE_STAGE_BODY : ''}`;
}

export const THIN_DOCKERFILE = thinDockerfileFor(DEFAULT_LOCAL_HARNESSES);

// ── Container spec ───────────────────────────────────────────────────────────

export interface LocalDaemonSpec {
  vaultPath: string;
  version: string;
  hostPort: number;
  /** Host-side config directories that exist and are masked read-only (see {@link MASKED_VAULT_DIRS}). */
  maskedDirs: readonly string[];
  memory: string;
  cpus: number;
  /** Enabled harnesses; absent = Claude only. */
  harnesses?: readonly LocalHarness[];
}

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecError';
  }
}

/** Throws {@link SpecError} when the vault path cannot be bind-mounted safely. */
export function assertMountablePath(path: string): void {
  if (!path.startsWith('/')) throw new SpecError('The vault path must be absolute.');
  if (path.includes(':')) throw new SpecError('The vault path contains ":", which the container runtime treats as a mount delimiter. Move the vault to a path without a colon.');
  if (/[\0\n\r]/.test(path) || path.split('/').includes('..')) throw new SpecError('The vault path contains characters a mount cannot have.');
}

/** The mounts, in `run` order: the vault read-write, then each existing config directory read-only on top. */
export function mountsFor(spec: Pick<LocalDaemonSpec, 'vaultPath' | 'maskedDirs'>): Array<{ host: string; guest: string; readOnly: boolean }> {
  const root = spec.vaultPath.replace(/\/+$/, '');
  return [
    { host: root, guest: VAULT_GUEST_PATH, readOnly: false },
    ...spec.maskedDirs.map((d) => ({ host: `${root}/${d}`, guest: `${VAULT_GUEST_PATH}/${d}`, readOnly: true })),
  ];
}

/** Hash of everything fixed at `run`. A container whose label differs needs recreating to apply a change. */
export function specSignature(spec: LocalDaemonSpec): string {
  return hashHex(JSON.stringify({
    image: localImageRef(spec.version, spec.harnesses),
    port: spec.hostPort,
    mounts: mountsFor(spec),
    memory: spec.memory,
    cpus: spec.cpus,
    command: serveCommand(),
    // Only a non-default set is hashed, so a Claude-only container made before harness toggles existed does not
    // read as drifted after an upgrade.
    ...(isDefaultHarnessSet(spec.harnesses) ? {} : { harnesses: normalizeHarnesses(spec.harnesses) }),
  })).slice(0, 16);
}

/** The replaced `CMD`. It must repeat the image defaults (`--listen 0.0.0.0 --i-know-this-is-open`). */
export function serveCommand(): string[] {
  return ['--listen', '0.0.0.0', '--i-know-this-is-open', '--workspace', WORKSPACES_MOUNT, '--workspace', VAULT_GUEST_PATH];
}

export function labelsFor(spec: LocalDaemonSpec): Record<string, string> {
  return {
    [LABEL_OWNER]: '1',
    [LABEL_VERSION]: spec.version,
    [LABEL_SPEC]: specSignature(spec),
    [LABEL_VAULT]: vaultHash(spec.vaultPath),
  };
}

// ── argv builders ────────────────────────────────────────────────────────────

export function pullArgs(version: string): string[] {
  return buildImagePullArgs(publishedImageRef(version));
}

export function buildThinImageArgs(opts: { version: string; dockerfilePath: string; contextDir: string; harnesses?: readonly string[] }): string[] {
  const set = normalizeHarnesses(opts.harnesses);
  return [
    'build',
    '--tag', localImageRef(opts.version, set),
    '--build-arg', `BASE_IMAGE=${publishedImageRef(opts.version)}`,
    ...(set.includes('codex') ? ['--build-arg', 'INSTALL_CODEX=1'] : []),
    ...(set.includes('opencode') ? ['--build-arg', 'INSTALL_OPENCODE=1'] : []),
    '--label', `${LABEL_IMAGE_VERSION}=${opts.version}`,
    '--progress', 'plain',
    '-f', opts.dockerfilePath,
    opts.contextDir,
  ];
}

/** Runs the built image and asserts the tools the daemon needs exist; prints OK on success. */
export function verifyImageArgs(version: string, harnesses?: readonly string[]): string[] {
  const set = normalizeHarnesses(harnesses);
  const checks = [...set.map((h) => `command -v ${h}`), 'command -v agent-threads', 'command -v git'];
  return ['run', '--rm', '--entrypoint', 'sh', localImageRef(version, set), '-c', `${checks.join(' && ')} && echo LOCAL_DAEMON_IMAGE_OK`];
}
export const VERIFY_OK_MARKER = 'LOCAL_DAEMON_IMAGE_OK';

export function imageInspectArgs(ref: string): string[] {
  return ['image', 'inspect', ref];
}
export function imageRemoveArgs(ref: string): string[] {
  return ['image', 'rm', ref];
}
export function volumeCreateArgs(name: string): string[] {
  return ['volume', 'create', name];
}
export function volumeInspectArgs(name: string): string[] {
  return ['volume', 'inspect', name];
}
export function volumeRemoveArgs(name: string): string[] {
  return ['volume', 'delete', name];
}

/**
 * One-shot that fixes volume ownership (named volumes are root-owned) and, optionally, writes the Claude
 * credential from STDIN into the data volume. The credential never appears in argv, env, or `inspect`.
 * `chown` is non-recursive on purpose: it must never walk a large workspace volume.
 */
export function prepareScript(withCredential: boolean): string {
  const lines = [
    'set -eu',
    'umask 077',
    `install -d -o ${DAEMON_UID} -g ${DAEMON_UID} -m 0700 ${DATA_MOUNT} ${DATA_MOUNT}/home ${CREDENTIALS_DIR}`,
    `chown ${DAEMON_UID}:${DAEMON_UID} ${WORKSPACES_MOUNT}`,
  ];
  if (withCredential) {
    lines.push(
      `cat > ${CREDENTIAL_FILE}.tmp`,
      `[ -s ${CREDENTIAL_FILE}.tmp ] || { echo "credential was not received on stdin" >&2; exit 3; }`,
      `chown ${DAEMON_UID}:${DAEMON_UID} ${CREDENTIAL_FILE}.tmp`,
      `mv ${CREDENTIAL_FILE}.tmp ${CREDENTIAL_FILE}`,
    );
  }
  return lines.join('\n');
}

export function prepareArgs(opts: { vaultPath: string; version: string; withCredential: boolean; harnesses?: readonly string[] }): string[] {
  return [
    'run', '--rm', ...(opts.withCredential ? ['-i'] : []),
    '-u', '0', '--entrypoint', 'sh',
    '--volume', `${dataVolumeFor(opts.vaultPath)}:${DATA_MOUNT}`,
    '--volume', `${workspacesVolumeFor(opts.vaultPath)}:${WORKSPACES_MOUNT}`,
    localImageRef(opts.version, opts.harnesses),
    '-c', prepareScript(opts.withCredential),
  ];
}

export function runArgs(spec: LocalDaemonSpec): string[] {
  assertMountablePath(spec.vaultPath);
  if (!Number.isInteger(spec.hostPort) || spec.hostPort < 1 || spec.hostPort > 65535) throw new SpecError('Invalid host port.');
  const labels = Object.entries(labelsFor(spec)).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  const mounts = mountsFor(spec).flatMap((m) => ['--volume', `${m.host}:${m.guest}${m.readOnly ? ':ro' : ''}`]);
  return [
    'run', '--detach',
    '--name', containerNameFor(spec.vaultPath),
    ...labels,
    // Loopback only: the daemon binds 0.0.0.0 INSIDE the VM, so the publish address is the only boundary.
    '-p', `127.0.0.1:${spec.hostPort}:${DAEMON_INTERNAL_PORT}`,
    '--volume', `${dataVolumeFor(spec.vaultPath)}:${DATA_MOUNT}`,
    '--volume', `${workspacesVolumeFor(spec.vaultPath)}:${WORKSPACES_MOUNT}`,
    ...mounts,
    '--memory', spec.memory,
    '--cpus', String(spec.cpus),
    // A path, not a secret: where the daemon looks for `claude-token` (read once, at start).
    '--env', `CREDENTIALS_DIRECTORY=${CREDENTIALS_DIR}`,
    // The daemon's allowed set follows the toggles: a session for a harness that is off is refused at the door.
    '--env', `AGENT_THREADS_HARNESSES=${normalizeHarnesses(spec.harnesses).join(',')}`,
    localImageRef(spec.version, spec.harnesses),
    ...serveCommand(),
  ];
}

export function inspectContainerArgs(name: string): string[] {
  return ['inspect', name];
}
export function startContainerArgs(name: string): string[] {
  return ['start', name];
}
export function stopContainerArgs(name: string): string[] {
  return ['stop', name];
}
export function removeContainerArgs(name: string): string[] {
  return ['rm', '--force', name];
}
export function logsArgs(name: string): string[] {
  return ['logs', name];
}

const EXEC_AS_DAEMON = (name: string): string[] => ['exec', '--user', String(DAEMON_UID), name, 'agent-threads'];

export function tokenCreateArgs(name: string): string[] {
  return [...EXEC_AS_DAEMON(name), 'token', 'create', '--name', LOCAL_TOKEN_NAME, '--scope', 'control', '--json', '--data-dir', DATA_MOUNT];
}
export function tokenListArgs(name: string): string[] {
  return [...EXEC_AS_DAEMON(name), 'token', 'list', '--json', '--data-dir', DATA_MOUNT];
}
export function tokenRevokeArgs(name: string, tokenId: string): string[] {
  return [...EXEC_AS_DAEMON(name), 'token', 'revoke', tokenId, '--data-dir', DATA_MOUNT];
}
/** Exit 0 iff the credential file exists and is non-empty inside the running container. */
export function credentialPresentArgs(name: string): string[] {
  return ['exec', '--user', String(DAEMON_UID), name, 'test', '-s', CREDENTIAL_FILE];
}

/** The Claude sign-in runs `setup-token` in the daemon container as the daemon user. */
export const SIGN_IN_CONTAINER_BINARY = CLAUDE_BINARY_IN_IMAGE;

// ── Per-harness CLI and sign-in state ────────────────────────────────────────

const AS_DAEMON = (name: string): string[] => ['exec', '--user', String(DAEMON_UID), name];

/**
 * One `exec` in the running container that prints `<harness>.cli=0|1` (is the CLI in the image) and
 * `codex.auth=0|1` / `opencode.auth=0|1` (did a login leave a non-empty credential file in the persisted HOME).
 * Claude's sign-in is the existing credential file / keychain token, not probed here. Reads file SIZES only: the
 * credentials are never printed.
 */
export const HARNESS_PROBE_SCRIPT = [
  `for p in claude:${CLAUDE_BINARY_IN_IMAGE} codex:${CODEX_BINARY_IN_IMAGE} opencode:${OPENCODE_BINARY_IN_IMAGE}; do`,
  '  n="${p%%:*}"; f="${p#*:}"',
  '  if [ -x "$f" ]; then echo "$n.cli=1"; else echo "$n.cli=0"; fi',
  'done',
  `if [ -s ${CODEX_AUTH_FILE} ]; then echo codex.auth=1; else echo codex.auth=0; fi`,
  `if [ -s ${OPENCODE_AUTH_FILE} ]; then echo opencode.auth=1; else echo opencode.auth=0; fi`,
].join('\n');

export function harnessProbeArgs(name: string): string[] {
  return [...AS_DAEMON(name), 'sh', '-c', HARNESS_PROBE_SCRIPT];
}

/** `codex login --device-auth`: prints a URL and a one-time code, then waits until the page is approved. No pasting back. */
export function codexLoginArgs(name: string): string[] {
  return [...AS_DAEMON(name), CODEX_BINARY_IN_IMAGE, 'login', '--device-auth'];
}

/**
 * The exact line to run by hand for a login that cannot be driven from Settings (OpenCode's `auth login` is an
 * interactive provider picker). `containerBinary` is the managed `container` CLI, which is not on PATH.
 */
export function manualLoginCommand(harness: Exclude<LocalHarness, 'claude'>, containerName: string, containerBinary = 'container'): string {
  const bin = /[^A-Za-z0-9_./-]/.test(containerBinary) ? `'${containerBinary.replace(/'/g, `'\\''`)}'` : containerBinary;
  const cli = harness === 'codex' ? `${CODEX_BINARY_IN_IMAGE} login --device-auth` : `${OPENCODE_BINARY_IN_IMAGE} auth login`;
  return `${bin} exec -it --user ${DAEMON_UID} ${containerName} ${cli}`;
}
