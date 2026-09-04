/**
 * sandboxVm.ts — sandboxed VM execution backed by Apple's `container` CLI.
 *
 * ## What this is for
 *
 * The agent's Read/Write/Edit/Bash tools run on the HOST. A sandbox that also
 * moved file editing inside the guest would break every one of them. So the
 * split is deliberate:
 *
 *   - Files stay on the host and are bind-mounted into the guest at `/work`.
 *   - Only COMMANDS run inside the guest, via `vm_exec`.
 *
 * On macOS 26+ / Apple silicon, `container` runs each Linux container as its
 * own lightweight VM: a real separate kernel, an ephemeral root filesystem,
 * and no visibility of the host filesystem beyond the explicit bind mount.
 * That is a far stronger boundary than a plain subprocess, while a warm start
 * still costs well under a second.
 *
 * ## Network modes
 *
 * `default` is FULL EGRESS by explicit product decision — `npm install`, git
 * remotes and web access all have to work out of the box, and a sandbox nobody
 * can build in is a sandbox nobody uses. The tighter modes stay first-class:
 *
 *   - `default`  — no `--network` flag; the CLI's own default bridge, full egress.
 *   - `internal` — a named network created with `--internal`: no internet, but
 *                  the host gateway is still reachable.
 *   - `none`     — `--network none`: no route at all.
 *
 * ## Node builtins are required lazily
 *
 * This plugin loads on Obsidian desktop AND mobile, where `require()` returns
 * null for Node built-ins. Following the same convention as `worktreePaths.ts`
 * and `pathUtils.ts`, `child_process` is `require`d inside the runner closure —
 * never at module scope. Importing this module is therefore always safe; only
 * *calling* into the CLI needs a Node environment, and every entry point
 * degrades to a non-throwing `{ success: false, error }` when it is missing.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Network isolation modes exposed by `enter_vm`. */
export type VmNetworkMode = 'default' | 'internal' | 'none';

export const VM_NETWORK_MODES: readonly VmNetworkMode[] = ['default', 'internal', 'none'];

/** Image built from `sandbox/Dockerfile`. Overridable per call and in settings. */
export const DEFAULT_VM_IMAGE = 'claude-threads-coding:1';

/** Where the thread's working directory is bind-mounted, and the guest cwd. */
export const VM_WORKDIR = '/work';

/** The shared `--internal` network, created on demand the first time it is asked for. */
export const VM_INTERNAL_NETWORK_NAME = 'claude-threads-internal';

/** Prefix for every container this plugin creates, so strays are identifiable. */
export const VM_CONTAINER_NAME_PREFIX = 'claude-threads-vm-';

/** Byte cap applied independently to stdout and stderr in `vm_exec` results. */
export const VM_OUTPUT_LIMIT_BYTES = 100_000;

export const DEFAULT_VM_EXEC_TIMEOUT_SECONDS = 300;
export const MIN_VM_EXEC_TIMEOUT_SECONDS = 1;
export const MAX_VM_EXEC_TIMEOUT_SECONDS = 3600;

/** Longest any lifecycle command (run/exec-probe/stop/rm/network) may take. */
export const VM_LIFECYCLE_TIMEOUT_MS = 120_000;

/** The binary. Not configurable: the whole design is specific to this CLI's semantics. */
export const VM_BINARY = 'container';

/**
 * Shown whenever the CLI cannot be found or reached. Names the two setup steps
 * people actually miss — installing it, and starting the system service — so a
 * failed call is self-diagnosing instead of a bare ENOENT.
 */
export const VM_UNAVAILABLE_HINT =
  `The \`${VM_BINARY}\` CLI is unavailable. Sandboxed VMs need Apple's container runtime `
  + '(macOS 26+ on Apple silicon): install it with `brew install container`, then run '
  + '`container system start`. Sandbox VM tools are desktop-only and are not available on mobile.';

// ── Command execution seam ───────────────────────────────────────────────────

export interface VmCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Minimal seam over `child_process.execFile`, mirroring `GitDiffExecFile` in
 * GitDiffService: injected so tests exercise real command construction and
 * state transitions without a macOS 26 runtime (CI has none).
 *
 * Implementations must RESOLVE with a non-zero `exitCode` for a command that
 * ran and failed, and REJECT only when the binary itself could not be run.
 */
export type VmCommandRunner = (
  args: string[],
  opts: { timeoutMs: number },
) => Promise<VmCommandResult>;

/** Thrown by the default runner when the CLI binary cannot be spawned at all. */
export class VmUnavailableError extends Error {
  constructor(detail?: string) {
    super(detail ? `${VM_UNAVAILABLE_HINT} (${detail})` : VM_UNAVAILABLE_HINT);
    this.name = 'VmUnavailableError';
  }
}

/**
 * PATH additions for locating a Homebrew-installed binary.
 *
 * Obsidian is launched from the GUI, so its PATH is the bare launchd default
 * and does not include Homebrew — exactly the reason a `container` that works
 * in Terminal appears missing to the plugin.
 */
function runnerEnv(): Record<string, string | undefined> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin'];
  return { ...env, PATH: `${extraPath.join(':')}:${env.PATH ?? ''}` };
}

/**
 * Real runner. `child_process` is required inside the returned closure so that
 * building a runner — which happens for every session, on every platform — is
 * inert until a VM tool is actually called.
 */
export function createDefaultVmCommandRunner(binary: string = VM_BINARY): VmCommandRunner {
  return (args, opts) =>
    new Promise<VmCommandResult>((resolve, reject) => {
      let execFile: typeof import('child_process').execFile | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        execFile = (require('child_process') as typeof import('child_process'))?.execFile;
      } catch (err) {
        reject(new VmUnavailableError(err instanceof Error ? err.message : String(err)));
        return;
      }
      if (typeof execFile !== 'function') {
        reject(new VmUnavailableError('child_process is not available on this platform'));
        return;
      }

      execFile(
        binary,
        args,
        {
          timeout: opts.timeoutMs,
          env: runnerEnv() as NodeJS.ProcessEnv,
          maxBuffer: VM_OUTPUT_LIMIT_BYTES * 4,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          // ENOENT means the binary itself is missing — a setup problem, not a
          // command failure, so it must not be reported as "exit code 1".
          if (code === 'ENOENT' || code === 'EACCES') {
            reject(new VmUnavailableError(String(code)));
            return;
          }
          const exitCode = typeof (error as { code?: unknown }).code === 'number'
            ? (error as unknown as { code: number }).code
            : 1;
          resolve({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    });
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Reduces an arbitrary identifier to something a container ID accepts:
 * lowercase alphanumerics and dashes, starting with an alphanumeric.
 *
 * Thread IDs are normally UUIDs and pass through untouched; this exists so a
 * hand-set or legacy ID with slashes, spaces or unicode cannot produce an
 * unusable — or worse, argument-injecting — name.
 */
export function sanitizeContainerName(raw: string): string {
  const cleaned = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return 'session';
  // Leading character must be alphanumeric; the strip above guarantees that,
  // but a purely numeric-leading name is fine for this CLI.
  return cleaned.slice(0, 48);
}

/** Deterministic container name for a thread — see `SandboxVmManager` for why it matters. */
export function containerNameForThread(threadId: string): string {
  return `${VM_CONTAINER_NAME_PREFIX}${sanitizeContainerName(threadId)}`;
}

export function isVmNetworkMode(value: unknown): value is VmNetworkMode {
  return typeof value === 'string' && (VM_NETWORK_MODES as readonly string[]).includes(value);
}

/**
 * Picks the network mode: explicit argument wins, then the configured default,
 * then `'default'` (full egress). An unrecognised setting value falls back
 * rather than failing the call — a bad setting should not make the tool unusable.
 */
export function resolveVmNetwork(
  requested?: string | null,
  configuredDefault?: string | null,
): VmNetworkMode {
  if (isVmNetworkMode(requested)) return requested;
  if (isVmNetworkMode(configuredDefault)) return configuredDefault;
  return 'default';
}

/** Trims a blank image setting down to the built-in default. */
export function resolveVmImage(requested?: string | null, configuredDefault?: string | null): string {
  return requested?.trim() || configuredDefault?.trim() || DEFAULT_VM_IMAGE;
}

/** Clamps a caller-supplied timeout into a sane band and defaults it. */
export function resolveExecTimeoutSeconds(requested?: number | null): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return DEFAULT_VM_EXEC_TIMEOUT_SECONDS;
  }
  return Math.min(MAX_VM_EXEC_TIMEOUT_SECONDS, Math.max(MIN_VM_EXEC_TIMEOUT_SECONDS, Math.floor(requested)));
}

/** The `--network` argument pair for a mode, or `[]` for the CLI's own default. */
export function networkArgsFor(network: VmNetworkMode): string[] {
  if (network === 'none') return ['--network', 'none'];
  if (network === 'internal') return ['--network', VM_INTERNAL_NETWORK_NAME];
  return [];
}

export function buildRunArgs(opts: {
  containerName: string;
  image: string;
  mountPath: string;
  network: VmNetworkMode;
  workdir?: string;
}): string[] {
  const workdir = opts.workdir ?? VM_WORKDIR;
  return [
    'run',
    '--detach',
    '--name', opts.containerName,
    '--volume', `${opts.mountPath}:${workdir}`,
    '--workdir', workdir,
    ...networkArgsFor(opts.network),
    opts.image,
    // The container only has to stay alive so `container exec` has somewhere to
    // land; the image's own CMD (an interactive bash) would exit immediately
    // with no TTY attached.
    'sleep', 'infinity',
  ];
}

export function buildExecArgs(opts: {
  containerName: string;
  command: string;
  workdir?: string;
}): string[] {
  // `bash -lc` (not a shell string passed to a shell) — the command is a single
  // argv element, so nothing here re-splits or re-expands it on the host side.
  return ['exec', '--workdir', opts.workdir ?? VM_WORKDIR, opts.containerName, 'bash', '-lc', opts.command];
}

export function buildStopArgs(containerName: string): string[] {
  return ['stop', containerName];
}

export function buildRemoveArgs(opts: { containerName: string; force?: boolean }): string[] {
  return ['rm', ...(opts.force ? ['--force'] : []), opts.containerName];
}

export function buildInspectArgs(containerName: string): string[] {
  return ['inspect', containerName];
}

export function buildNetworkListArgs(): string[] {
  return ['network', 'list', '--quiet'];
}

export function buildNetworkCreateArgs(name: string): string[] {
  return ['network', 'create', '--internal', name];
}

/**
 * Caps a stream at {@link VM_OUTPUT_LIMIT_BYTES}, keeping the HEAD.
 *
 * Head rather than tail because a long build's first error is what explains the
 * failure; the tail is usually a summary the model can re-derive. The marker is
 * explicit so a truncated result is never mistaken for a complete one.
 */
export function truncateOutput(text: string, limit: number = VM_OUTPUT_LIMIT_BYTES): string {
  if (typeof text !== 'string' || text.length <= limit) return text ?? '';
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n\n[... truncated ${omitted} of ${text.length} characters — output exceeded the ${limit}-character cap ...]`;
}

// ── Manager ──────────────────────────────────────────────────────────────────

export interface SandboxVmState {
  containerName: string;
  image: string;
  mountedFrom: string;
  network: VmNetworkMode;
}

export type EnterVmResult =
  | { success: true; containerName: string; image: string; mountedFrom: string; network: VmNetworkMode }
  | { success: false; error: string };

export type VmExecResult =
  | { success: true; exitCode: number; stdout: string; stderr: string }
  | { success: false; error: string };

export type ExitVmResult =
  | { success: true; removedContainer: string }
  | { success: false; error: string };

export interface SandboxVmManagerDeps {
  /** Deterministic container name for the owning thread. Read lazily so a late threadId still applies. */
  containerName: () => string;
  /** Command seam. Defaults to the real CLI runner. */
  run?: VmCommandRunner;
}

/**
 * Per-session lifecycle for one thread's sandbox VM.
 *
 * ## Why there is no `Thread` field for this
 *
 * A detached container outlives a plugin reload, but the session state that
 * tracks it does not — so naively holding the name in memory would orphan
 * containers on every reload. Instead the name is *derived deterministically
 * from the thread ID*, which means a fresh session can still find, adopt, and
 * remove the container a previous session started. That gets persistence across
 * reloads without adding a `Thread` field, without a new serializer branch in
 * `main.ts`, and without a schema migration for something that is fundamentally
 * ephemeral OS state rather than thread content.
 */
export class SandboxVmManager {
  private readonly deps: SandboxVmManagerDeps;
  private readonly runner: VmCommandRunner;
  private active: SandboxVmState | null = null;

  constructor(deps: SandboxVmManagerDeps) {
    this.deps = deps;
    this.runner = deps.run ?? createDefaultVmCommandRunner();
  }

  /** Currently tracked container for this session, if `enter_vm` has run. */
  getActive(): SandboxVmState | null {
    return this.active;
  }

  private async exec(args: string[], timeoutMs = VM_LIFECYCLE_TIMEOUT_MS): Promise<VmCommandResult> {
    return this.runner(args, { timeoutMs });
  }

  /** True when a container with this name exists (running or stopped). */
  private async containerExists(containerName: string): Promise<boolean> {
    const result = await this.exec(buildInspectArgs(containerName));
    return result.exitCode === 0;
  }

  /**
   * Creates the shared `--internal` network if it is missing.
   *
   * List-then-create rather than create-and-ignore-errors, so a genuine
   * creation failure is still reported instead of being swallowed as
   * "probably already exists".
   */
  private async ensureInternalNetwork(): Promise<string | null> {
    const listed = await this.exec(buildNetworkListArgs());
    if (listed.exitCode === 0) {
      const names = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      if (names.includes(VM_INTERNAL_NETWORK_NAME)) return null;
    }
    const created = await this.exec(buildNetworkCreateArgs(VM_INTERNAL_NETWORK_NAME));
    if (created.exitCode === 0) return null;
    // Lost a race with a concurrent create: the network is there, which is all
    // the caller needs.
    if (await this.networkExists(VM_INTERNAL_NETWORK_NAME)) return null;
    return `Could not create the internal network "${VM_INTERNAL_NETWORK_NAME}": ${firstLine(created.stderr) || `exit code ${created.exitCode}`}`;
  }

  private async networkExists(name: string): Promise<boolean> {
    const listed = await this.exec(buildNetworkListArgs());
    if (listed.exitCode !== 0) return false;
    return listed.stdout.split('\n').map((l) => l.trim()).includes(name);
  }

  /** `container --version`, used as the availability probe. */
  async probe(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const result = await this.exec(['--version'], 15_000);
      if (result.exitCode !== 0) {
        return { available: false, error: `${VM_UNAVAILABLE_HINT} (${firstLine(result.stderr) || `exit code ${result.exitCode}`})` };
      }
      return { available: true, version: firstLine(result.stdout) };
    } catch (err) {
      return { available: false, error: errorMessage(err) };
    }
  }

  async enter(params: {
    image: string;
    mountPath: string;
    network: VmNetworkMode;
  }): Promise<EnterVmResult> {
    try {
      const containerName = this.deps.containerName();

      if (this.active) {
        return {
          success: false,
          error: `A sandbox VM is already running for this thread (${this.active.containerName}, mounted from ${this.active.mountedFrom}). Call exit_vm before starting another one.`,
        };
      }

      const probe = await this.probe();
      if (!probe.available) return { success: false, error: probe.error ?? VM_UNAVAILABLE_HINT };

      // An untracked container under this thread's name is a leftover from an
      // earlier session. Adopting it would silently ignore the image/network/
      // mount just requested, so report it and let exit_vm clear it instead.
      if (await this.containerExists(containerName)) {
        return {
          success: false,
          error: `A container named ${containerName} already exists from an earlier session. Call exit_vm to remove it, then enter_vm again.`,
        };
      }

      if (params.network === 'internal') {
        const networkError = await this.ensureInternalNetwork();
        if (networkError) return { success: false, error: networkError };
      }

      const result = await this.exec(
        buildRunArgs({ containerName, image: params.image, mountPath: params.mountPath, network: params.network }),
      );
      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to start sandbox VM: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.exitCode}`}`,
        };
      }

      this.active = {
        containerName,
        image: params.image,
        mountedFrom: params.mountPath,
        network: params.network,
      };
      return { success: true, ...this.active };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  }

  async execCommand(params: { command: string; timeoutSeconds: number }): Promise<VmExecResult> {
    try {
      const containerName = this.active?.containerName ?? this.deps.containerName();

      if (!this.active) {
        const probe = await this.probe();
        if (!probe.available) return { success: false, error: probe.error ?? VM_UNAVAILABLE_HINT };
        // Session state was lost (plugin reload) but the container it started is
        // still running — adopt it rather than making the user tear down and
        // rebuild an environment that is right there.
        if (!(await this.containerExists(containerName))) {
          return {
            success: false,
            error: 'No sandbox VM is running for this thread. Call enter_vm first.',
          };
        }
        this.active = {
          containerName,
          image: 'unknown (adopted an existing container after a reload)',
          mountedFrom: 'unknown (adopted an existing container after a reload)',
          network: 'default',
        };
      }

      const result = await this.exec(
        buildExecArgs({ containerName, command: params.command }),
        params.timeoutSeconds * 1000,
      );
      return {
        success: true,
        exitCode: result.exitCode,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr),
      };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  }

  async exit(params: { force?: boolean } = {}): Promise<ExitVmResult> {
    try {
      const containerName = this.active?.containerName ?? this.deps.containerName();

      if (!this.active) {
        const probe = await this.probe();
        if (!probe.available) return { success: false, error: probe.error ?? VM_UNAVAILABLE_HINT };
        if (!(await this.containerExists(containerName))) {
          return { success: false, error: 'No sandbox VM is running for this thread.' };
        }
      }

      // Graceful stop first so an in-flight write inside the guest is not cut
      // mid-syscall against the host bind mount. `force` skips straight to the
      // kill, and a stop failure is not fatal — `rm --force` still finishes it.
      if (!params.force) {
        await this.exec(buildStopArgs(containerName));
      }

      const removed = await this.exec(buildRemoveArgs({ containerName, force: true }));
      if (removed.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to remove ${containerName}: ${firstLine(removed.stderr) || `exit code ${removed.exitCode}`}`,
        };
      }

      this.active = null;
      return { success: true, removedContainer: containerName };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  }
}

// ── Local utilities ──────────────────────────────────────────────────────────

function firstLine(text: string | undefined): string {
  return (text ?? '').trim().split('\n')[0]?.trim() ?? '';
}

function errorMessage(err: unknown): string {
  if (err instanceof VmUnavailableError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
