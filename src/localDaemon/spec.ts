/**
 * Local daemon: constants, the thin Claude layer, and every `container` argv
 * builder. Pure: no I/O, no Node built-ins at module scope (the plugin bundle
 * also loads on mobile). Design: docs/local-daemon-design.md sections 4.3-4.4.
 *
 * Nothing under `src/localDaemon/` may be imported by the core closure
 * (`core-files.json`); a unit test pins that.
 */

import { DEFAULT_VM_CPUS, DEFAULT_VM_MEMORY } from '../containerCli';

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
/** Where the vault appears inside the daemon container (and where `/vault` sits for the agent). */
export const VAULT_GUEST_PATH = '/vault';
/** Config directories masked read-only inside the vault mount: a writable copy would be code execution on the Mac. */
export const MASKED_VAULT_DIRS: readonly string[] = ['.geode', '.obsidian'];
export const DAEMON_UID = 10001;
/** Where the `with-claude` layer puts the CLI (outside every VOLUME path). */
export const CLAUDE_BINARY_IN_IMAGE = '/opt/claude/.local/bin/claude';

/** Name of the control token this plugin mints inside the daemon. */
export const LOCAL_TOKEN_NAME = 'geode-local';
/**
 * Name of the admin token behind `creds.push` (the only admin command). It never leaves the container: it is
 * saved as `cli-token` in the data directory, which `agent-threads creds push` reads by itself.
 */
export const CREDS_TOKEN_NAME = 'geode-creds';
export const CLI_TOKEN_FILE = `${DATA_MOUNT}/cli-token`;
/** Where the plugin copies skill plugin directories (guest paths go in the session spec; the daemon validates them). */
export const SKILLS_DIR = `${DATA_MOUNT}/skills`;
/** The daemon user's home (HOME in the image): the CLI reads `~/.claude`, the AWS SDK `~/.aws`. */
export const HOME_DIR = `${DATA_MOUNT}/home`;
export const CLAUDE_HOME_DIR = `${HOME_DIR}/.claude`;
export const AWS_HOME_DIR = `${HOME_DIR}/.aws`;
/** Credential kinds holding a session's environment: `sessenv-<project id>`; the session spec carries only the name. */
export const SESSION_ENV_KIND_PREFIX = 'sessenv-';
/** The environment is read when a session (re)starts, which can be long after it was pushed; refreshed on every send. */
export const SESSION_ENV_TTL_SEC = 24 * 60 * 60;
export function sessionEnvKind(projectId: string | undefined): string {
  const id = (projectId ?? 'none').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '').slice(0, 48) || 'none';
  return `${SESSION_ENV_KIND_PREFIX}${id}`;
}

/** `creds.push` kind and field the daemon reads GitHub access from (daemon/repos.ts). */
export const GITHUB_CREDS_KIND = 'github';
export const GITHUB_TOKEN_FIELD = 'GH_TOKEN';
/** A pushed GitHub token is honoured this long, so a quit Geode cannot leave one behind for long. */
export const GITHUB_CREDS_TTL_SEC = 15 * 60;
/** The daemon user's global git config (HOME lives in the data volume, so it survives container recreation). */
export const GITCONFIG_FILE = `${DATA_MOUNT}/home/.gitconfig`;
export const LOCAL_DAEMON_ID = 'this-mac-container';
export const LOCAL_DAEMON_NAME = 'This Mac (container)';

export const LOCAL_DAEMON_MEMORY = DEFAULT_VM_MEMORY;
export const LOCAL_DAEMON_CPUS = DEFAULT_VM_CPUS;
export const MAX_DAEMON_CPUS = 64;

const MEMORY_PATTERN = /^\d+[MG]$/i;

/**
 * Validates a memory limit before it reaches the `container run` argv: `<digits>M|G` with a non-zero amount (Apple's
 * 1 GiB default OOM-kills pnpm/tsc/tests once the agent is resident); anything else falls back to the default.
 */
export function resolveDaemonMemory(value?: string | null): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!MEMORY_PATTERN.test(v) || Number.parseInt(v, 10) <= 0) return LOCAL_DAEMON_MEMORY;
  return v.toUpperCase();
}

/** A whole number in [1, 64]; invalid values fall back to the default, large ones clamp. */
export function resolveDaemonCpus(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return LOCAL_DAEMON_CPUS;
  return Math.min(value, MAX_DAEMON_CPUS);
}

/**
 * Oldest daemon this plugin will keep talking to. Bump ONLY when the plugin
 * starts requiring a newer daemon (design section 8).
 */
export const MIN_LOCAL_DAEMON_VERSION = '0.64.0';

/** Pull/build are far longer than the 120 s lifecycle cap; image pulls and builds are slow. */
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
export function localImageRef(version: string): string {
  return `${LOCAL_IMAGE_REPOSITORY}:${version}`;
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

export const THIN_DOCKERFILE = `# agent-threads local daemon: adds the Claude Code CLI on top of the published daemon image.
# Generated by the plugin from the \`with-claude\` stage of sandbox/Dockerfile.daemon.
ARG BASE_IMAGE
FROM \${BASE_IMAGE}
${WITH_CLAUDE_STAGE_BODY}`;

// ── Container spec ───────────────────────────────────────────────────────────

export interface LocalDaemonSpec {
  vaultPath: string;
  version: string;
  hostPort: number;
  /** Host-side config directories that exist and are masked read-only (see {@link MASKED_VAULT_DIRS}). */
  maskedDirs: readonly string[];
  /** Vetted Geode external roots, mounted READ-ONLY at `/ext/<name>` and offered as read-only workspaces. */
  externalRoots?: ReadonlyArray<ExternalRootMount>;
  /** Vetted host folders the user shared read-write, mounted at `/work/<name>` and offered as workspaces. */
  workFolders?: ReadonlyArray<ExternalRootMount>;
  memory: string;
  cpus: number;
}

/** One vetted external root: an existing absolute host directory and its unique path segment under /ext. */
export interface ExternalRootMount { host: string; name: string }

/** Parent of the read-write bind mounts for the folders the user shares with the daemon. */
export const WORK_GUEST_ROOT = '/work';

/** Parent of the read-only bind mounts for connected Geode external roots (same convention as the old sandbox VM). */
export const EXTERNAL_GUEST_ROOT = '/ext';

/** A Geode external root as reported by the host's `externalRoots.listMountRoots()`. */
export interface ExternalRootInput { rootId?: string; label?: string; path?: string; projectId?: string }

/** Like a container name but keeps case and `.`/`_`/`-`; never '.', '..' or empty. */
export function sanitizeMountLabel(raw: string): string {
  const cleaned = (raw ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  return cleaned || 'root';
}

/**
 * Vets the user's shared folders (settings): absolute existing directories, no ':' / NUL / '..', not '/', and not the
 * vault or a folder containing it (the vault is mounted already). Same naming and ordering as external roots.
 */
export function resolveWorkFolders(
  folders: readonly string[] | undefined,
  opts: { vaultPath: string; isDirectory: (hostPath: string) => boolean },
): ExternalRootMount[] {
  const entries = (folders ?? []).filter((p) => typeof p === 'string' && p.trim() !== '' && p.trim() !== '/').map((p) => ({ path: p.trim(), label: p.trim().split('/').filter(Boolean).pop() ?? '' }));
  return resolveExternalRoots(entries, opts);
}

/**
 * Turns host-reported external roots into vetted read-only mounts. The host is treated as untrusted-ish input: an
 * entry whose path is not absolute, contains ':', NUL or '..', is not an existing directory, or equals or lies inside
 * the vault (already mounted) is dropped, as are duplicate paths. Colliding labels get -2, -3 suffixes. Sorted by
 * path so the same set always gives the same spec signature.
 */
export function resolveExternalRoots(
  entries: readonly ExternalRootInput[] | null | undefined,
  opts: { vaultPath: string; isDirectory: (hostPath: string) => boolean },
): ExternalRootMount[] {
  if (!Array.isArray(entries)) return [];
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const vault = trim(opts.vaultPath);
  const usedNames = new Set<string>();
  const usedPaths = new Set<string>();
  const out: ExternalRootMount[] = [];
  const sorted = [...entries].sort((a, b) => String(a?.path ?? '').localeCompare(String(b?.path ?? '')));
  for (const entry of sorted) {
    const raw = entry?.path;
    if (typeof raw !== 'string' || !raw.startsWith('/')) continue;
    if (raw.includes(':') || /[\0\n\r]/.test(raw) || raw.split('/').includes('..')) continue;
    const host = trim(raw);
    if (host === vault || host.startsWith(`${vault}/`) || vault.startsWith(`${host}/`)) continue;
    if (usedPaths.has(host)) continue;
    let isDir = false;
    try { isDir = opts.isDirectory(host); } catch { isDir = false; }
    if (!isDir) continue;
    const base = sanitizeMountLabel(typeof entry.label === 'string' ? entry.label : '');
    let name = base;
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    usedNames.add(name.toLowerCase());
    usedPaths.add(host);
    out.push({ host, name });
  }
  return out;
}

/**
 * External roots (read-only at /ext) that are the same folder as, inside, or around a shared folder (read-write at
 * /work). Mounting one host folder twice with different modes makes the share fail for writes (virtiofs), so the
 * shared folder, which the user asked for explicitly, wins and the root is dropped; it is still reachable at /work.
 */
export function dropOverlappingRoots(roots: readonly ExternalRootMount[], work: readonly ExternalRootMount[]): ExternalRootMount[] {
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  return roots.filter((r) => !work.some((w) => overlaps(r.host, w.host)));
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
export function mountsFor(spec: Pick<LocalDaemonSpec, 'vaultPath' | 'maskedDirs' | 'externalRoots' | 'workFolders'>): Array<{ host: string; guest: string; readOnly: boolean }> {
  const root = spec.vaultPath.replace(/\/+$/, '');
  return [
    { host: root, guest: VAULT_GUEST_PATH, readOnly: false },
    ...spec.maskedDirs.map((d) => ({ host: `${root}/${d}`, guest: `${VAULT_GUEST_PATH}/${d}`, readOnly: true })),
    ...(spec.workFolders ?? []).map((r) => ({ host: r.host, guest: `${WORK_GUEST_ROOT}/${r.name}`, readOnly: false })),
    ...(spec.externalRoots ?? []).map((r) => ({ host: r.host, guest: `${EXTERNAL_GUEST_ROOT}/${r.name}`, readOnly: true })),
  ];
}

/** Hash of everything fixed at `run`. A container whose label differs needs recreating to apply a change. */
export function specSignature(spec: LocalDaemonSpec): string {
  return hashHex(JSON.stringify({
    image: localImageRef(spec.version),
    port: spec.hostPort,
    mounts: mountsFor(spec),
    memory: spec.memory,
    cpus: spec.cpus,
    command: serveCommand(spec),
  })).slice(0, 16);
}

/** The replaced `CMD`. It must repeat the image defaults (`--listen 0.0.0.0 --i-know-this-is-open`). */
export function serveCommand(spec: Pick<LocalDaemonSpec, 'externalRoots' | 'workFolders'> = {}): string[] {
  return [
    '--listen', '0.0.0.0', '--i-know-this-is-open', '--workspace', WORKSPACES_MOUNT, '--workspace', VAULT_GUEST_PATH,
    ...(spec.workFolders ?? []).flatMap((r) => ['--workspace', `${WORK_GUEST_ROOT}/${r.name}`]),
    // Read-only workspaces: a session may start there but the harness cannot edit (the daemon denies the edit tools).
    ...(spec.externalRoots ?? []).flatMap((r) => ['--readonly-workspace', `${EXTERNAL_GUEST_ROOT}/${r.name}`]),
  ];
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
  // Pinned: a bare pull of a multi-platform tag unpacks every platform (observed on 1.3.1).
  return ['image', 'pull', '--platform', 'linux/arm64', publishedImageRef(version)];
}

export function buildThinImageArgs(opts: { version: string; dockerfilePath: string; contextDir: string }): string[] {
  return [
    'build',
    '--tag', localImageRef(opts.version),
    '--build-arg', `BASE_IMAGE=${publishedImageRef(opts.version)}`,
    '--label', `${LABEL_IMAGE_VERSION}=${opts.version}`,
    '--progress', 'plain',
    '-f', opts.dockerfilePath,
    opts.contextDir,
  ];
}

/** Runs the built image and asserts the tools the daemon needs exist; prints OK on success. */
export function verifyImageArgs(version: string): string[] {
  return ['run', '--rm', '--entrypoint', 'sh', localImageRef(version), '-c',
    'command -v claude && command -v agent-threads && command -v git && echo LOCAL_DAEMON_IMAGE_OK'];
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

export function prepareArgs(opts: { vaultPath: string; version: string; withCredential: boolean }): string[] {
  return [
    'run', '--rm', ...(opts.withCredential ? ['-i'] : []),
    '-u', '0', '--entrypoint', 'sh',
    '--volume', `${dataVolumeFor(opts.vaultPath)}:${DATA_MOUNT}`,
    '--volume', `${workspacesVolumeFor(opts.vaultPath)}:${WORKSPACES_MOUNT}`,
    localImageRef(opts.version),
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
    localImageRef(spec.version),
    ...serveCommand(spec),
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
/** Exit 0 iff the saved admin token for `creds push` exists and is non-empty inside the running container. */
export function cliTokenPresentArgs(name: string): string[] {
  return ['exec', '--user', String(DAEMON_UID), name, 'test', '-s', CLI_TOKEN_FILE];
}
/** Mints the admin token and saves it (not printed) as `cli-token`; `token create --save --json` prints only its path. */
export function cliTokenCreateArgs(name: string): string[] {
  return [...EXEC_AS_DAEMON(name), 'token', 'create', '--name', CREDS_TOKEN_NAME, '--scope', 'admin', '--save', '--json', '--data-dir', DATA_MOUNT];
}
const CREDS_PUSH_BASE = (name: string, kind: string): string[] => [
  'exec', '-i', '--user', String(DAEMON_UID), name, 'agent-threads', 'creds', 'push', kind,
  '--url', `ws://127.0.0.1:${DAEMON_INTERNAL_PORT}`, '--data-dir', DATA_MOUNT,
];
/** Pushes a credential kind from a JSON object of NAME -> value on stdin, so no secret is ever in argv. */
export function credsPushArgs(name: string, kind: string, ttlSec: number): string[] {
  return [...CREDS_PUSH_BASE(name, kind), '--stdin', '--ttl', String(ttlSec)];
}
/** Deletes a pushed credential kind. */
export function credsRemoveArgs(name: string, kind: string): string[] {
  return [...CREDS_PUSH_BASE(name, kind), '--remove'];
}
/** Sets one key in the daemon user's global git config (a repository's own config still wins). */
export function gitConfigSetArgs(name: string, key: string, value: string): string[] {
  return ['exec', '--user', String(DAEMON_UID), name, 'git', 'config', '--file', GITCONFIG_FILE, key, value];
}

/** Exit 0 iff the credential file exists and is non-empty inside the running container. */
export function credentialPresentArgs(name: string): string[] {
  return ['exec', '--user', String(DAEMON_UID), name, 'test', '-s', CREDENTIAL_FILE];
}

/** The Claude sign-in runs `setup-token` in the daemon container as the daemon user. */
export const SIGN_IN_CONTAINER_BINARY = CLAUDE_BINARY_IN_IMAGE;
