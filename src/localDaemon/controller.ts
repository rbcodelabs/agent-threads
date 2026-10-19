/**
 * Local daemon: the controller. Owns observe-then-reconcile, the single-flight
 * operation lock, and the user-facing operations (set up, start, stop,
 * restart, update, reset, remove, sign in, ensure-running for a thread).
 *
 * Every collaborator is injected ({@link LocalDaemonDeps}), so the whole state
 * machine runs in unit tests against a fake `container` binary with no macOS 26,
 * no network and no Geode. Design: docs/local-daemon-design.md section 5.
 */

import type { LocalDaemonSettings, RemoteDaemonConfig } from '../types';
import type { ProbeResult } from '../remote/DaemonClient';
import { CONTAINER_AUTH_TOKEN_SECRET, type ContainerSignInResult } from '../claudeContainerAuthCli';
import type { HarnessLoginResult } from './harnessLogin';
import type { VmCommandRunner } from '../sandboxVm';
import {
  assess,
  assessDaemonVersion,
  type Assessment,
  type Desired,
  type Observed,
  type PlanAction,
} from './assess';
import {
  LocalDaemonAbortedError,
  LocalDaemonError,
  buildThinImage,
  createContainer,
  createVolumes,
  credentialFilePresent,
  imagePresent,
  inspectOurContainer,
  logTail,
  mintControlToken,
  prepareVolumes,
  probeHarnesses,
  pullDaemonImage,
  removeContainer,
  removeImage,
  removeVolumes,
  startContainer,
  stopContainer,
  verifyThinImage,
  volumesPresent,
  waitHealthy,
  type StepDeps,
} from './provision';
import { buildRegistration, isRegistrationCurrent, localDaemonUrl, LOCAL_DAEMON_TOKEN_SECRET } from './registration';
import { installRuntime, readRuntime, startRuntimeService, type RuntimeApi } from './runtime';
import {
  DEFAULT_HOST_PORT,
  HOST_PORT_SEARCH_LIMIT,
  LOCAL_DAEMON_CPUS,
  LOCAL_DAEMON_ID,
  LOCAL_DAEMON_MEMORY,
  LABEL_SPEC,
  LABEL_VERSION,
  MASKED_VAULT_DIRS,
  SIGN_IN_CONTAINER_BINARY,
  VAULT_GUEST_PATH,
  containerNameFor,
  localImageRef,
  mountsFor,
  specSignature,
  normalizeHarnesses,
  manualLoginCommand,
  assertMountablePath,
  type LocalHarness,
  SpecError,
  type LocalDaemonSpec,
} from './spec';

// ── Injected collaborators ───────────────────────────────────────────────────

export interface SignInHandlers {
  onProgress: (text: string) => void;
  onUrl: (url: string) => void;
  onCodePrompt: () => Promise<string | null>;
}

export interface LocalDaemonDeps {
  /** Absolute vault path, or null where there is none (mobile, non-filesystem adapter). */
  vaultPath(): string | null;
  /** The plugin's version: also the daemon image tag. */
  pluginVersion: string;
  isDirectory(path: string): boolean;
  runtime: RuntimeApi;
  /** Built lazily, after the runtime is installed, so it finds the managed binary. */
  createRunner(): VmCommandRunner;
  /** One `GET /healthz` on 127.0.0.1:port. */
  healthz(port: number): Promise<boolean>;
  /** Connects once with the token and reports `welcome` (or why it could not). */
  probeDaemon(url: string, token: string): Promise<ProbeResult>;
  /** True when nothing accepts connections on 127.0.0.1:port. */
  portFree(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  secrets: { get(name: string): string | undefined; set(name: string, value: string): void };
  loadSettings(): LocalDaemonSettings | undefined;
  saveSettings(next: LocalDaemonSettings): Promise<void>;
  getRegistered(): RemoteDaemonConfig | undefined;
  register(config: RemoteDaemonConfig): Promise<void>;
  unregister(): Promise<void>;
  /** Runs the in-container `claude setup-token` flow. Absent where it cannot run (the sign-in then reports so). */
  signInRunner?(opts: { containerName: string; containerBinaryPath: string } & SignInHandlers): Promise<ContainerSignInResult>;
  /** Runs `codex login --device-auth` in the container. Absent where it cannot run (the panel then shows the manual command). */
  harnessSignInRunner?(opts: { harness: 'codex'; containerName: string; onProgress: (text: string) => void; onUrl: (url: string) => void }): Promise<HarnessLoginResult>;
  /** State changed: a UI should re-read {@link LocalDaemonController.getBusy} / take a new snapshot. */
  onChange?(): void;
  log?(message: string): void;
  /** Health poll tuning; tests shrink it. */
  healthAttempts?: number;
  healthDelayMs?: number;
}

// ── Public types ─────────────────────────────────────────────────────────────

export type LocalDaemonOpKind = 'setup' | 'start' | 'stop' | 'restart' | 'update' | 'reset' | 'remove' | 'sign-in';

export interface LocalDaemonProgress {
  kind: LocalDaemonOpKind;
  label: string;
  percent?: number;
  line?: string;
}

export interface LocalDaemonSnapshot {
  assessment: Assessment;
  observed: Observed;
  /** Version of the daemon that exists (container label / welcome), if any. */
  daemonVersion?: string;
  pluginVersion: string;
  port?: number;
  vaultPath?: string;
  /** For disclosure text: what is mounted, and how. */
  mounts: Array<{ host: string; guest: string; readOnly: boolean }>;
  /** The harnesses the user turned on (Claude is the default). */
  harnesses: LocalHarness[];
  /** The daemon container's name and the managed `container` CLI, for the exact manual commands the panel shows. */
  containerName?: string;
  containerBinary?: string;
  busy: LocalDaemonProgress | null;
  lastError: { code: string; message: string } | null;
}

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (p: LocalDaemonProgress) => void;
}

const OP_LABEL: Record<LocalDaemonOpKind, string> = {
  setup: 'Setting up the local daemon',
  start: 'Starting the local daemon',
  stop: 'Stopping the local daemon',
  restart: 'Restarting the local daemon',
  update: 'Updating the local daemon',
  reset: 'Resetting the local daemon',
  remove: 'Removing the local daemon',
  'sign-in': 'Signing in to Claude',
};

const ACTION_LABEL: Partial<Record<PlanAction, string>> = {
  'install-runtime': 'Installing the container runtime',
  'start-runtime': 'Starting the container runtime',
  'pull-image': 'Downloading the daemon image',
  'build-image': 'Adding the agent CLIs to the image',
  'create-volumes': 'Creating storage',
  'prepare-volumes': 'Preparing storage',
  'remove-container': 'Replacing the container',
  'create-container': 'Starting the daemon',
  'start-container': 'Starting the daemon',
  'restart-container': 'Restarting the daemon',
  'apply-credential': 'Applying the Claude sign-in',
  'mint-token': 'Creating an access token',
  register: 'Adding it to Remote daemons',
};

const MAX_RECONCILE_PASSES = 6;

interface ActiveOp {
  kind: LocalDaemonOpKind;
  promise: Promise<unknown>;
  controller: AbortController;
  listeners: Set<(p: LocalDaemonProgress) => void>;
  last: LocalDaemonProgress;
}

// ── Controller ───────────────────────────────────────────────────────────────

export class LocalDaemonController {
  private op: ActiveOp | null = null;
  private lastError: { code: string; message: string } | null = null;

  constructor(private readonly deps: LocalDaemonDeps) {}

  // ── single-flight ──────────────────────────────────────────────────────────

  private readonly listeners = new Set<() => void>();

  /** Subscribe to progress and state changes (a settings panel). Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    this.deps.onChange?.();
    for (const l of [...this.listeners]) {
      try { l(); } catch { /* a UI callback must not break the run */ }
    }
  }

  getBusy(): LocalDaemonProgress | null {
    return this.op?.last ?? null;
  }

  /** Aborts the running operation, if any. */
  cancel(): void {
    this.op?.controller.abort();
  }

  /**
   * Runs `fn` as the one operation in flight. The same kind joins the running one (a double click is safe);
   * a different kind is refused with a `busy` error rather than queued behind something the user may not expect.
   */
  private runOp<T>(kind: LocalDaemonOpKind, opts: RunOptions, fn: (ctx: OpContext) => Promise<T>): Promise<T> {
    if (this.op) {
      if (this.op.kind !== kind) {
        return Promise.reject(new LocalDaemonError('busy', `${OP_LABEL[this.op.kind]} is still running. Wait for it to finish, or cancel it.`));
      }
      return this.attach(this.op, opts) as Promise<T>;
    }
    const controller = new AbortController();
    const op: ActiveOp = {
      kind, controller, listeners: new Set(), last: { kind, label: OP_LABEL[kind] },
      promise: Promise.resolve(),
    };
    const emit = (p: Partial<Omit<LocalDaemonProgress, 'kind'>>) => {
      op.last = { kind, label: p.label ?? op.last.label, ...(p.percent !== undefined ? { percent: p.percent } : {}), ...(p.line !== undefined ? { line: p.line } : {}) };
      for (const l of [...op.listeners]) {
        try { l(op.last); } catch { /* a UI callback must not break the run */ }
      }
      this.notify();
    };
    this.op = op;
    op.promise = (async () => {
      try {
        const result = await fn({ signal: controller.signal, emit });
        this.lastError = null;
        return result;
      } catch (err) {
        if (!(err instanceof LocalDaemonAbortedError)) {
          this.lastError = err instanceof LocalDaemonError
            ? { code: err.code, message: err.message }
            : { code: 'unavailable', message: err instanceof Error ? err.message : String(err) };
        }
        throw err;
      } finally {
        if (this.op === op) this.op = null;
        this.notify();
      }
    })();
    op.promise.catch(() => undefined);
    this.notify();
    return this.attach(op, opts) as Promise<T>;
  }

  private attach(op: ActiveOp, opts: RunOptions): Promise<unknown> {
    const listener = opts.onProgress;
    if (listener) {
      op.listeners.add(listener);
      listener(op.last);
    }
    if (opts.signal) {
      if (opts.signal.aborted) op.controller.abort();
      else opts.signal.addEventListener('abort', () => op.controller.abort(), { once: true });
    }
    return op.promise.finally(() => { if (listener) op.listeners.delete(listener); });
  }

  // ── observation ────────────────────────────────────────────────────────────

  private settings(): LocalDaemonSettings {
    return this.deps.loadSettings() ?? { enabled: false, port: DEFAULT_HOST_PORT };
  }

  private maskedDirs(vaultPath: string): string[] {
    return MASKED_VAULT_DIRS.filter((d) => this.deps.isDirectory(`${vaultPath.replace(/\/+$/, '')}/${d}`));
  }

  private harnesses(): LocalHarness[] {
    return normalizeHarnesses(this.settings().harnesses);
  }

  private specFor(vaultPath: string, version: string, port: number): LocalDaemonSpec {
    return { vaultPath, version, hostPort: port, maskedDirs: this.maskedDirs(vaultPath), memory: LOCAL_DAEMON_MEMORY, cpus: LOCAL_DAEMON_CPUS, harnesses: this.harnesses() };
  }

  private emptyObserved(partial: Partial<Observed>): Observed {
    return {
      supported: true, runtimeInstalled: false, runtimeRunning: false, imageReady: false, volumesPresent: false,
      container: 'absent', health: 'na', tokenInKeychain: false, tokenAccepted: 'unknown',
      credentialInKeychain: false, credentialInVolume: false, registered: false, harnesses: this.harnesses(), ...partial,
    };
  }

  /** Read-only: facts about the world plus the assessment. Never mutates anything. */
  async observe(signal?: AbortSignal): Promise<{ observed: Observed; desired: Desired; assessment: Assessment; version: string; port: number; vaultPath: string | null; daemonVersion?: string }> {
    const vaultPath = this.deps.vaultPath();
    const settings = this.settings();
    const port = settings.port || DEFAULT_HOST_PORT;
    const pluginVersion = this.deps.pluginVersion;
    const finish = (observed: Observed, version: string, daemonVersion?: string) => {
      const sig = vaultPath ? safeSignature(() => specSignature(this.specFor(vaultPath, version, port))) : '';
      const desired: Desired = { enabled: settings.enabled, pluginVersion, specSignature: sig };
      return { observed, desired, assessment: assess(observed, desired), version, port, vaultPath, ...(daemonVersion ? { daemonVersion } : {}) };
    };

    if (!vaultPath) {
      return finish(this.emptyObserved({ supported: false, unsupportedReason: 'The local daemon needs a vault on this computer\'s disk.' }), pluginVersion);
    }
    try { assertMountablePath(vaultPath); } catch (err) {
      return finish(this.emptyObserved({ supported: false, unsupportedReason: err instanceof Error ? err.message : String(err) }), pluginVersion);
    }
    const rt = await readRuntime(this.deps.runtime);
    if (!rt.supported) return finish(this.emptyObserved({ supported: false, ...(rt.reason ? { unsupportedReason: rt.reason } : {}) }), pluginVersion);
    const credentialInKeychain = !!this.deps.secrets.get(CONTAINER_AUTH_TOKEN_SECRET);
    if (!rt.installed || !rt.running) {
      return finish(this.emptyObserved({
        runtimeInstalled: rt.installed, runtimeRunning: false, credentialInKeychain,
        credentialInVolume: settings.credentialWritten === true,
        tokenInKeychain: !!this.deps.secrets.get(LOCAL_DAEMON_TOKEN_SECRET),
        registered: isRegistrationCurrent(this.deps.getRegistered(), vaultPath, port),
      }), pluginVersion);
    }

    const d: StepDeps = { runner: this.deps.createRunner(), signal };
    const ours = await inspectOurContainer(d, vaultPath);
    const containerVersion = typeof ours === 'object' ? ours.labels[LABEL_VERSION] : undefined;
    const containerSpec = typeof ours === 'object' ? ours.labels[LABEL_SPEC] : undefined;
    // An existing container keeps its version (updates are prompt-only) unless its version alone is incompatible.
    const keepVersion = containerVersion !== undefined && assessDaemonVersion(pluginVersion, containerVersion) !== 'required';
    const version = keepVersion ? containerVersion : pluginVersion;
    const running = typeof ours === 'object' && ours.state === 'running';
    const token = this.deps.secrets.get(LOCAL_DAEMON_TOKEN_SECRET);

    let health: Observed['health'] = 'na';
    let welcome: Observed['welcome'];
    let tokenAccepted: Observed['tokenAccepted'] = 'unknown';
    if (running) {
      health = (await this.deps.healthz(port)) ? 'ok' : 'down';
      if (health === 'ok' && token) {
        const probe = await this.deps.probeDaemon(localDaemonUrl(port), token);
        if (probe.ok) {
          welcome = { daemonVersion: probe.info.daemonVersion, protocol: probe.info.protocol, minClientVersion: probe.info.minClientVersion };
          tokenAccepted = 'yes';
        } else if (probe.status === 'unauthorized') {
          tokenAccepted = 'no';
        } else if (probe.status === 'incompatible' && probe.info) {
          welcome = { daemonVersion: probe.info.daemonVersion, protocol: probe.info.protocol, minClientVersion: probe.info.minClientVersion };
        }
      }
    }
    const credentialInVolume = running ? await credentialFilePresent(d, vaultPath) : settings.credentialWritten === true;
    const harnesses = this.harnesses();
    const harnessProbe = running && health === 'ok' ? await probeHarnesses(d, vaultPath) : null;
    const observed: Observed = {
      supported: true,
      runtimeInstalled: true,
      runtimeRunning: true,
      imageReady: await imagePresent(d, localImageRef(version, harnesses)),
      volumesPresent: await volumesPresent(d, vaultPath),
      container: ours === 'absent' ? 'absent' : ours === 'foreign' ? 'foreign' : running ? 'running' : 'stopped',
      ...(containerVersion ? { containerVersion } : {}),
      ...(containerSpec ? { containerSpec } : {}),
      health,
      ...(welcome ? { welcome } : {}),
      tokenInKeychain: !!token,
      tokenAccepted,
      credentialInKeychain,
      credentialInVolume,
      registered: isRegistrationCurrent(this.deps.getRegistered(), vaultPath, port),
      harnesses,
      ...(harnessProbe ? { harnessProbe } : {}),
    };
    return finish(observed, version, welcome?.daemonVersion ?? containerVersion);
  }

  /** What a UI renders. Cheap enough to call when a panel opens; never mutates. */
  async snapshot(): Promise<LocalDaemonSnapshot> {
    const o = await this.observe();
    const binary = o.observed.supported ? (await readRuntime(this.deps.runtime)).binary : undefined;
    return {
      assessment: o.assessment,
      observed: o.observed,
      ...(o.daemonVersion ? { daemonVersion: o.daemonVersion } : {}),
      pluginVersion: this.deps.pluginVersion,
      port: o.port,
      ...(o.vaultPath ? { vaultPath: o.vaultPath } : {}),
      mounts: o.vaultPath ? mountsFor({ vaultPath: o.vaultPath, maskedDirs: this.maskedDirs(o.vaultPath) }) : [],
      harnesses: this.harnesses(),
      ...(o.vaultPath ? { containerName: containerNameFor(o.vaultPath) } : {}),
      ...(binary ? { containerBinary: binary } : {}),
      busy: this.getBusy(),
      lastError: this.lastError,
    };
  }

  // ── reconcile ──────────────────────────────────────────────────────────────

  /**
   * Repeats observe -> assess -> run the plan until the plan is empty. Each action is idempotent, so a crash at any
   * point resumes from the real state. Throws {@link LocalDaemonError} when it cannot make progress.
   */
  private async reconcile(ctx: OpContext): Promise<Assessment> {
    let last: Assessment | undefined;
    for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass++) {
      if (ctx.signal.aborted) throw new LocalDaemonAbortedError();
      const o = await this.observe(ctx.signal);
      last = o.assessment;
      this.guardStatus(o.assessment, o.observed);
      if (o.assessment.plan.length === 0) return o.assessment;
      await this.execute(o.assessment.plan, o, ctx);
    }
    throw new LocalDaemonError('start', `The local daemon did not settle after ${MAX_RECONCILE_PASSES} attempts (last status: ${last?.status ?? 'unknown'}). Try Retry, or Reset daemon data.`);
  }

  private guardStatus(a: Assessment, o: Observed): void {
    if (a.status === 'unsupported') throw new LocalDaemonError('unsupported', o.unsupportedReason ?? 'This Mac cannot run the local daemon.');
    if (a.status === 'conflict') {
      throw new LocalDaemonError('name-conflict', 'A container with the daemon\'s name already exists but was not created by Agent Threads. It was left alone; remove or rename it, then try again.');
    }
  }

  private async execute(
    plan: readonly PlanAction[],
    o: Awaited<ReturnType<LocalDaemonController['observe']>>,
    ctx: OpContext,
  ): Promise<void> {
    const vaultPath = o.vaultPath;
    if (!vaultPath) throw new LocalDaemonError('unsupported', 'No vault path.');
    let binary = (await readRuntime(this.deps.runtime)).binary;
    let runner: VmCommandRunner | null = null;
    const step = (): StepDeps => {
      runner = runner ?? this.deps.createRunner();
      return { runner, signal: ctx.signal, report: (line) => ctx.emit({ line, ...percentOf(line) }) };
    };
    let port = o.port;

    for (const action of plan) {
      if (ctx.signal.aborted) throw new LocalDaemonAbortedError();
      const label = ACTION_LABEL[action];
      if (label) ctx.emit({ label, line: '' });
      switch (action) {
        case 'install-runtime':
          binary = await installRuntime(this.deps.runtime, { signal: ctx.signal, report: (line) => ctx.emit({ line }) });
          runner = null;
          break;
        case 'start-runtime': {
          if (!binary) binary = (await readRuntime(this.deps.runtime)).binary;
          if (!binary) throw new LocalDaemonError('runtime', 'Could not find the container command to start.');
          await startRuntimeService(this.deps.runtime, binary, { signal: ctx.signal, report: (line) => ctx.emit({ line }) });
          runner = null;
          break;
        }
        case 'pull-image':
          await pullDaemonImage(step(), o.version);
          break;
        case 'build-image':
          await buildThinImage(step(), o.version, this.harnesses());
          await verifyThinImage(step(), o.version, this.harnesses());
          break;
        case 'create-volumes':
          await createVolumes(step(), vaultPath);
          break;
        case 'prepare-volumes': {
          const credential = this.deps.secrets.get(CONTAINER_AUTH_TOKEN_SECRET);
          await prepareVolumes(step(), { vaultPath, version: o.version, harnesses: this.harnesses(), ...(credential ? { credential } : {}) });
          await this.patchSettings({ credentialWritten: !!credential });
          break;
        }
        case 'remove-container':
          await removeContainer(step(), vaultPath);
          break;
        case 'create-container': {
          port = await this.choosePort(o.port);
          await this.patchSettings({ port });
          await this.runAndAwaitHealthy(step(), vaultPath, () => createContainer(step(), this.specFor(vaultPath, o.version, port)), port, ctx);
          break;
        }
        case 'start-container':
          await this.runAndAwaitHealthy(step(), vaultPath, () => startContainer(step(), vaultPath), port, ctx);
          break;
        case 'restart-container':
          await stopContainer(step(), vaultPath);
          await this.runAndAwaitHealthy(step(), vaultPath, () => startContainer(step(), vaultPath), port, ctx);
          break;
        case 'apply-credential': {
          const credential = this.deps.secrets.get(CONTAINER_AUTH_TOKEN_SECRET);
          if (!credential) throw new LocalDaemonError('credential', 'There is no Claude sign-in to apply.');
          await stopContainer(step(), vaultPath);
          await prepareVolumes(step(), { vaultPath, version: o.version, harnesses: this.harnesses(), credential });
          await this.patchSettings({ credentialWritten: true });
          await this.runAndAwaitHealthy(step(), vaultPath, () => startContainer(step(), vaultPath), port, ctx);
          break;
        }
        case 'mint-token': {
          // Mint only runs when the keychain token is missing, rejected, or the volume is new, so any existing
          // geode-local token is stale or orphaned and is revoked first.
          const minted = await mintControlToken(step(), {
            vaultPath,
            store: (token) => this.deps.secrets.set(LOCAL_DAEMON_TOKEN_SECRET, token),
          });
          await this.patchSettings({ tokenId: minted.id });
          break;
        }
        case 'register':
          await this.deps.register(buildRegistration(vaultPath, this.settings().port || port, this.deps.getRegistered()));
          break;
      }
    }
  }

  private async runAndAwaitHealthy(d: StepDeps, vaultPath: string, start: () => Promise<void>, port: number, ctx: OpContext): Promise<void> {
    await start();
    ctx.emit({ line: 'Waiting for the daemon to answer' });
    const ok = await waitHealthy({
      probe: () => this.deps.healthz(port),
      sleep: this.deps.sleep,
      attempts: this.deps.healthAttempts,
      delayMs: this.deps.healthDelayMs,
      signal: ctx.signal,
    });
    if (!ok) {
      const log = await logTail(d, vaultPath);
      const eacces = /EACCES|permission denied/i.test(log);
      throw new LocalDaemonError(
        'health',
        eacces
          ? `The daemon cannot write its data folder.\n${log}`
          : `The daemon started but never answered on 127.0.0.1:${port}.\n${log}`,
        log,
      );
    }
  }

  private async choosePort(preferred: number): Promise<number> {
    for (let p = preferred; p < preferred + HOST_PORT_SEARCH_LIMIT && p <= 65535; p++) {
      if (await this.deps.portFree(p)) return p;
    }
    throw new LocalDaemonError('port-in-use', `Ports ${preferred}-${preferred + HOST_PORT_SEARCH_LIMIT - 1} on this Mac are all in use.`);
  }

  private async patchSettings(patch: Partial<LocalDaemonSettings>): Promise<void> {
    await this.deps.saveSettings({ ...this.settings(), ...patch });
  }

  // ── operations ─────────────────────────────────────────────────────────────

  /** Install what is missing, create the daemon, mint its token, register it. Idempotent; safe to re-run after a failure. */
  setUp(opts: RunOptions = {}): Promise<Assessment> {
    return this.runOp('setup', opts, async (ctx) => {
      await this.patchSettings({ enabled: true });
      return this.reconcile(ctx);
    });
  }

  /** Start (and repair, if needed) the daemon. Requires Set up to have run. */
  start(opts: RunOptions = {}): Promise<Assessment> {
    return this.runOp('start', opts, async (ctx) => {
      this.requireEnabled();
      return this.reconcile(ctx);
    });
  }

  /**
   * Called before a thread runs on the local daemon. Fast path: already healthy with a token. Otherwise start it.
   * Throws a typed error (`not-set-up`, `needs-sign-in`, `incompatible`, ...) the caller shows verbatim.
   */
  async ensureRunning(opts: RunOptions = {}): Promise<void> {
    const settings = this.settings();
    // Only Claude has a credential this plugin manages; with Claude off there is nothing to wait for here.
    const signedIn = !this.harnesses().includes('claude') || settings.credentialWritten === true || !!this.deps.secrets.get(CONTAINER_AUTH_TOKEN_SECRET);
    if (settings.enabled && signedIn && !this.op && this.deps.secrets.get(LOCAL_DAEMON_TOKEN_SECRET) && await this.deps.healthz(settings.port || DEFAULT_HOST_PORT)) return;
    const a = await this.start(opts);
    if (a.status === 'needs-sign-in' || a.needsSignIn) {
      throw new LocalDaemonError('needs-sign-in', 'The local daemon has no Claude sign-in yet. Open Settings, Remote, Local daemon and choose "Sign in to Claude".');
    }
    if (a.status === 'degraded' && a.degraded === 'incompatible') {
      throw new LocalDaemonError('incompatible', 'The local daemon is not compatible with this version of Agent Threads. Open Settings, Remote, Local daemon and choose Update.');
    }
  }

  stop(opts: RunOptions = {}): Promise<void> {
    return this.runOp('stop', opts, async (ctx) => {
      const vaultPath = this.requireVault();
      await stopContainer({ runner: this.deps.createRunner(), signal: ctx.signal }, vaultPath);
    });
  }

  restart(opts: RunOptions = {}): Promise<Assessment> {
    return this.runOp('restart', opts, async (ctx) => {
      this.requireEnabled();
      const vaultPath = this.requireVault();
      await stopContainer({ runner: this.deps.createRunner(), signal: ctx.signal }, vaultPath);
      return this.reconcile(ctx);
    });
  }

  /**
   * Prompt-only update (never automatic): pull the plugin's version, rebuild the Claude layer, replace the container
   * keeping the volumes (so the token, sessions and journals survive), and confirm the new daemon's version.
   */
  update(opts: RunOptions = {}): Promise<Assessment> {
    return this.runOp('update', opts, async (ctx) => {
      this.requireEnabled();
      const vaultPath = this.requireVault();
      const version = this.deps.pluginVersion;
      const before = await this.observe(ctx.signal);
      this.guardStatus(before.assessment, before.observed);
      if (!before.observed.runtimeRunning) await this.reconcileRuntimeOnly(ctx);
      const d: StepDeps = { runner: this.deps.createRunner(), signal: ctx.signal, report: (line) => ctx.emit({ line, ...percentOf(line) }) };
      ctx.emit({ label: ACTION_LABEL['pull-image'] });
      const harnesses = this.harnesses();
      if (!(await imagePresent(d, localImageRef(version, harnesses)))) {
        await pullDaemonImage(d, version);
        ctx.emit({ label: ACTION_LABEL['build-image'] });
        await buildThinImage(d, version, harnesses);
        await verifyThinImage(d, version, harnesses);
      }
      ctx.emit({ label: 'Replacing the daemon' });
      const oldVersion = before.observed.containerVersion;
      await stopContainer(d, vaultPath);
      await removeContainer(d, vaultPath);
      await createVolumes(d, vaultPath);
      const credential = this.deps.secrets.get(CONTAINER_AUTH_TOKEN_SECRET);
      await prepareVolumes(d, { vaultPath, version, harnesses, ...(credential ? { credential } : {}) });
      await this.patchSettings({ credentialWritten: credential ? true : this.settings().credentialWritten === true });
      const port = await this.choosePort(this.settings().port || DEFAULT_HOST_PORT);
      await this.patchSettings({ port });
      await this.runAndAwaitHealthy(d, vaultPath, () => createContainer(d, this.specFor(vaultPath, version, port)), port, ctx);
      const result = await this.reconcile(ctx);
      if (result.update !== 'none' && result.status !== 'degraded') {
        throw new LocalDaemonError('incompatible', `The daemon still reports a different version than v${version} after updating.`);
      }
      if (oldVersion && oldVersion !== version) await removeImage(d, oldVersion, harnesses);
      return result;
    });
  }

  /** Wipe the daemon's data (sessions, journals, token, workspaces volume) and set it up again from scratch. */
  reset(opts: RunOptions = {}): Promise<Assessment> {
    return this.runOp('reset', opts, async (ctx) => {
      this.requireEnabled();
      const vaultPath = this.requireVault();
      const d: StepDeps = { runner: this.deps.createRunner(), signal: ctx.signal };
      ctx.emit({ label: 'Removing the daemon and its data' });
      const state = await inspectOurContainer(d, vaultPath);
      if (state === 'foreign') throw new LocalDaemonError('name-conflict', 'A container with the daemon\'s name exists but was not created by Agent Threads. It was left alone.');
      if (state !== 'absent') {
        await stopContainer(d, vaultPath);
        await removeContainer(d, vaultPath);
      }
      await removeVolumes(d, vaultPath);
      await this.patchSettings({ credentialWritten: false, tokenId: undefined });
      return this.reconcile(ctx);
    });
  }

  /** Stop and delete the daemon; optionally its data and images. Never touches the shared Claude sign-in. */
  remove(opts: RunOptions & { removeData?: boolean } = {}): Promise<void> {
    return this.runOp('remove', opts, async (ctx) => {
      const vaultPath = this.requireVault();
      const rt = await readRuntime(this.deps.runtime);
      if (rt.installed && rt.running) {
        const d: StepDeps = { runner: this.deps.createRunner(), signal: ctx.signal };
        const state = await inspectOurContainer(d, vaultPath);
        if (state !== 'absent' && state !== 'foreign') {
          await stopContainer(d, vaultPath);
          await removeContainer(d, vaultPath);
          const v = state.labels[LABEL_VERSION];
          if (v) await removeImage(d, v, this.harnesses());
        }
        if (opts.removeData !== false) await removeVolumes(d, vaultPath);
      }
      this.deps.secrets.set(LOCAL_DAEMON_TOKEN_SECRET, '');
      await this.deps.unregister();
      await this.deps.saveSettings({ enabled: false, port: this.settings().port || DEFAULT_HOST_PORT });
    });
  }

  /**
   * Claude sign-in for the daemon. Reuses an existing container sign-in (no prompt) when the keychain has one;
   * otherwise runs the in-container `claude setup-token` flow once, stores the token, and writes it to the daemon.
   */
  signIn(handlers: SignInHandlers, opts: RunOptions = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.runOp('sign-in', opts, async (ctx) => {
      this.requireEnabled();
      if (!this.harnesses().includes('claude')) return { ok: false as const, error: 'Claude is turned off for the local daemon. Turn it on first.' };
      if (this.deps.secrets.get(CONTAINER_AUTH_TOKEN_SECRET)) {
        await this.reconcile(ctx);
        return { ok: true as const };
      }
      if (!this.deps.signInRunner) return { ok: false as const, error: 'Signing in is not available on this platform.' };
      const vaultPath = this.requireVault();
      // The sign-in runs inside the daemon container, which starts fine without a credential.
      await this.reconcile(ctx);
      const result = await this.deps.signInRunner({ containerName: containerNameFor(vaultPath), containerBinaryPath: SIGN_IN_CONTAINER_BINARY, ...handlers });
      if (!result.ok) return { ok: false as const, error: result.error };
      try {
        this.deps.secrets.set(CONTAINER_AUTH_TOKEN_SECRET, result.token);
      } catch (err) {
        return { ok: false as const, error: `Signed in, but saving the token failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      ctx.emit({ label: ACTION_LABEL['apply-credential'] });
      await this.reconcile(ctx);
      return { ok: true as const };
    });
  }

  /**
   * Turn harnesses on or off. Stored in settings only: the container and image are changed by the next Start /
   * Apply changes (the spec signature differs, so the daemon shows the change as pending until then). Never empty.
   */
  async setHarnesses(next: readonly string[]): Promise<LocalHarness[]> {
    if (this.op) throw new LocalDaemonError('busy', `${OP_LABEL[this.op.kind]} is still running. Wait for it to finish before changing harnesses.`);
    const normalized = normalizeHarnesses(next);
    await this.patchSettings({ harnesses: normalized });
    this.notify();
    return normalized;
  }

  /**
   * Codex sign-in for the daemon: `codex login --device-auth` inside the container (URL + one-time code, nothing to
   * paste back). The credential is created by the CLI in the daemon's data volume; this plugin never sees or stores it.
   * OpenCode has no non-interactive login, so it is refused here with the exact command to run (`manualLoginCommand`).
   */
  signInHarness(harness: Exclude<LocalHarness, 'claude'>, handlers: Pick<SignInHandlers, 'onProgress' | 'onUrl'>, opts: RunOptions = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.runOp('sign-in', opts, async (ctx) => {
      this.requireEnabled();
      const vaultPath = this.requireVault();
      const manual = async (): Promise<string> => manualLoginCommand(harness, containerNameFor(vaultPath), (await readRuntime(this.deps.runtime)).binary ?? undefined);
      if (!this.harnesses().includes(harness)) return { ok: false as const, error: `${harness} is turned off for the local daemon. Turn it on and apply the change first.` };
      if (harness !== 'codex' || !this.deps.harnessSignInRunner) {
        return { ok: false as const, error: `${harness} cannot be signed in from Settings. Run this in a terminal:\n${await manual()}` };
      }
      ctx.emit({ label: 'Signing in to Codex' });
      await this.reconcile(ctx);
      const d: StepDeps = { runner: this.deps.createRunner(), signal: ctx.signal };
      const before = await probeHarnesses(d, vaultPath);
      if (before && before.codex?.cli === false) {
        return { ok: false as const, error: 'The Codex CLI is not in the daemon image. Apply the harness change (Update) so the image is rebuilt with it.' };
      }
      const result = await this.deps.harnessSignInRunner({ harness: 'codex', containerName: containerNameFor(vaultPath), ...handlers });
      if (!result.ok) return { ok: false as const, error: `${result.error}\nOr run this in a terminal:\n${await manual()}` };
      const after = await probeHarnesses(d, vaultPath);
      if (after && after.codex?.signedIn === false) {
        return { ok: false as const, error: `Codex reported success but no login was found in the daemon. Run this in a terminal:\n${await manual()}` };
      }
      return { ok: true as const };
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async reconcileRuntimeOnly(ctx: OpContext): Promise<void> {
    const rt = await readRuntime(this.deps.runtime);
    let binary = rt.binary;
    if (!rt.installed) binary = await installRuntime(this.deps.runtime, { signal: ctx.signal, report: (line) => ctx.emit({ line }) });
    if (!rt.running && binary) await startRuntimeService(this.deps.runtime, binary, { signal: ctx.signal, report: (line) => ctx.emit({ line }) });
  }

  private requireEnabled(): void {
    if (!this.settings().enabled) {
      throw new LocalDaemonError('not-set-up', 'The local daemon is not set up. Open Settings, Remote, Local daemon and choose Set up.');
    }
  }

  private requireVault(): string {
    const v = this.deps.vaultPath();
    if (!v) throw new LocalDaemonError('unsupported', 'The local daemon needs a vault on this computer\'s disk.');
    return v;
  }

  /** The id the entry is registered under. */
  static readonly daemonId = LOCAL_DAEMON_ID;
  static readonly vaultGuestPath = VAULT_GUEST_PATH;
}

interface OpContext {
  signal: AbortSignal;
  emit(p: Partial<Omit<LocalDaemonProgress, 'kind'>>): void;
}

function percentOf(line: string): { percent?: number } {
  const m = /(\d{1,3})%/.exec(line);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? { percent: n } : {};
}

function safeSignature(fn: () => string): string {
  try { return fn(); } catch (err) {
    if (err instanceof SpecError) return '';
    throw err;
  }
}
