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
import { compareVersions, type ProbeResult } from '../remote/DaemonClient';
import { randomHex } from '../remote/randomId';
import { CONTAINER_AUTH_TOKEN_SECRET, type ContainerSignInResult } from '../claudeContainerAuthCli';
import type { HarnessLoginResult } from './harnessLogin';
import type { VmCommandRunner } from '../containerCli';
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
  imageDigest,
  imagePresent,
  forceStopContainer,
  inspectOurContainer,
  lastRunExit,
  logTail,
  mintControlToken,
  prepareVolumes,
  probeHarnesses,
  pullDaemonImage,
  removeContainer,
  removeImage,
  pruneStaleDaemonImages,
  removeVolumes,
  startContainer,
  stopContainer,
  verifyThinImage,
  volumesPresent,
  waitHealthy,
  type StepDeps,
} from './provision';
import { looksOutOfMemory } from './parse';
import { LocalDaemonWatchdog, type WatchdogConfig, type WatchdogState } from './watchdog';
import { buildRegistration, isRegistrationCurrent, localDaemonUrl, LOCAL_DAEMON_TOKEN_SECRET } from './registration';
import { installRuntime, readRuntime, startRuntimeService, type RuntimeApi } from './runtime';
import {
  CODEX_VERSION,
  DEFAULT_HOST_PORT,
  HOST_PORT_SEARCH_LIMIT,
  LOCAL_DAEMON_ID,
  resolveDaemonCpus,
  resolveDaemonMemory,
  LABEL_SPEC,
  LABEL_VERSION,
  HARNESS_LABEL,
  MASKED_VAULT_DIRS,
  SIGN_IN_CONTAINER_BINARY,
  VAULT_GUEST_PATH,
  containerNameFor,
  localImageRef,
  mountsFor,
  specSignature,
  normalizeHarnesses,
  manualLoginCommand,
  dropOverlappingRoots,
  resolveExternalRoots,
  resolveWorkFolders,
  sharedFolderList,
  type ExternalRootInput,
  type ExternalRootMount,
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
  harnessMaintenance?(port: number, token: string, method: 'GET' | 'POST' | 'DELETE', id?: string): Promise<HarnessMaintenanceAvailability>;
  /** True when nothing accepts connections on 127.0.0.1:port. */
  portFree(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  secrets: { get(name: string): string | undefined; set(name: string, value: string): void };
  loadSettings(): LocalDaemonSettings | undefined;
  saveSettings(next: LocalDaemonSettings): Promise<void>;
  getRegistered(): RemoteDaemonConfig | undefined;
  register(config: RemoteDaemonConfig): Promise<void>;
  unregister(): Promise<void>;
  /** Working folders of the user's Projects (absolute paths); shared read-write when `shareProjectFolders` is on. */
  projectFolders?(): string[];
  /** Geode's connected external roots (`externalRoots.listMountRoots()`), mounted read-only; absent on Obsidian / older Geode. */
  externalRoots?(): Promise<ExternalRootInput[] | null | undefined>;
  /** Runs the in-container `claude setup-token` flow. Absent where it cannot run (the sign-in then reports so). */
  signInRunner?(opts: { containerName: string; containerBinaryPath: string } & SignInHandlers): Promise<ContainerSignInResult>;
  /** Runs `codex login --device-auth` or `agy acp --login` in the container. Absent where it cannot run (the panel then shows the manual command). */
  harnessSignInRunner?(opts: {
    harness: 'codex' | 'antigravity';
    containerName: string;
    onProgress: (text: string) => void;
    onUrl: (url: string) => void;
    onCodePrompt?: () => Promise<string | null>;
  }): Promise<HarnessLoginResult>;
  /**
   * Ends the container's VM helper process (`container-runtime-linux`) on the host: the last resort when a wedged VM
   * ignores `container stop` and `container kill`. Absent where it cannot run.
   */
  killVmHelper?(containerName: string): Promise<void>;
  /**
   * Managed policy (docs/managed-policy.md): why the local daemon must not be created, started or updated, or
   * undefined. Read FRESH by the operations that would create or start the container; never applied to stop/remove,
   * and an existing container is left exactly as it is (policy is a gate, not a mutation).
   */
  policyDenial?(): Promise<string | undefined> | string | undefined;
  /** State changed: a UI should re-read {@link LocalDaemonController.getBusy} / take a new snapshot. */
  onChange?(): void;
  log?(message: string): void;
  /** Health poll tuning; tests shrink it. */
  healthAttempts?: number;
  healthDelayMs?: number;
}

// ── Public types ─────────────────────────────────────────────────────────────

/** Operations that create or start the container: refused while managed policy forbids the local daemon. */
const POLICY_GATED_OPS: ReadonlySet<string> = new Set(['setup', 'start', 'restart', 'update', 'update-harnesses', 'reset', 'sign-in']);

export type LocalDaemonOpKind = 'setup' | 'start' | 'stop' | 'restart' | 'kill' | 'update' | 'update-harnesses' | 'reset' | 'remove' | 'sign-in';

export interface LocalDaemonProgress {
  kind: LocalDaemonOpKind;
  label: string;
  percent?: number;
  line?: string;
  cancellable?: boolean;
}

export type HarnessMaintenanceAvailability = 'idle' | 'busy' | 'unsupported' | 'unknown';

export interface CodexUpdatePreview {
  from: string;
  to: string;
  availability: HarnessMaintenanceAvailability;
}

export interface LocalDaemonSnapshot {
  assessment: Assessment;
  observed: Observed;
  codexUpdate?: CodexUpdatePreview;
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
  /** Present once the watchdog has been started. */
  watchdog?: WatchdogState;
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
  kill: 'Force-stopping the local daemon',
  update: 'Updating the local daemon',
  'update-harnesses': 'Updating the Codex harness',
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

/** Keep a refreshed image when recreating the same daemon version and harness set for mount/settings changes. */
function retainedCodexImage(reference: string | undefined, version: string, harnesses: readonly string[]): string | undefined {
  const family = `${localImageRef(version, harnesses)}-codex-refresh-`;
  return reference?.split('/').pop()?.startsWith(family) ? reference : undefined;
}

export class LocalDaemonController {
  private op: ActiveOp | null = null;
  private lastError: { code: string; message: string } | null = null;
  /** This session stopped or killed the container (a SIGKILL exit is then ours, not an out-of-memory kill). */
  private stoppedByUs = false;
  private watchdog: LocalDaemonWatchdog | null = null;
  private opsStarted = 0;

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

  /** Operations started so far; the watchdog compares it to tell the user's actions from its own. */
  operationCount(): number {
    return this.opsStarted;
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
      const cancellable = p.cancellable ?? op.last.cancellable;
      op.last = {
        kind, label: p.label ?? op.last.label,
        ...(p.percent !== undefined ? { percent: p.percent } : {}),
        ...(p.line !== undefined ? { line: p.line } : {}),
        ...(cancellable !== undefined ? { cancellable } : {}),
      };
      for (const l of [...op.listeners]) {
        try { l(op.last); } catch { /* a UI callback must not break the run */ }
      }
      this.notify();
    };
    this.op = op;
    this.opsStarted++;
    op.promise = (async () => {
      try {
        if (POLICY_GATED_OPS.has(kind)) await this.assertPolicyAllows();
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

  /** Vetted external roots as of the last {@link refreshExternalRoots}. */
  private extRoots: ExternalRootMount[] = [];
  private workFolders: ExternalRootMount[] = [];
  private extRootsLoaded = false;
  private extRootsLoading = false;

  private async refreshExternalRoots(vaultPath: string | null): Promise<void> {
    this.workFolders = vaultPath ? resolveWorkFolders(sharedFolderList(this.settings(), this.deps.projectFolders), { vaultPath, isDirectory: (p) => this.deps.isDirectory(p) }) : [];
    if (!vaultPath || !this.deps.externalRoots) { this.extRoots = []; return; }
    try {
      this.extRoots = dropOverlappingRoots(resolveExternalRoots(await this.deps.externalRoots(), { vaultPath, isDirectory: (p) => this.deps.isDirectory(p) }), this.workFolders);
    } catch {
      this.extRoots = []; // an unreadable host answer means no extra mounts, never a failed operation
    } finally {
      this.extRootsLoaded = true;
      this.extRootsLoading = false;
    }
  }

  private specFor(vaultPath: string, version: string, port: number): LocalDaemonSpec {
    return { vaultPath, version, hostPort: port, maskedDirs: this.maskedDirs(vaultPath), externalRoots: this.extRoots, workFolders: this.workFolders, memory: resolveDaemonMemory(this.settings().memory), cpus: resolveDaemonCpus(this.settings().cpus), harnesses: this.harnesses(), ...(this.settings().allowSyncedStdio ? { allowSyncedStdio: true } : {}) };
  }

  private emptyObserved(partial: Partial<Observed>): Observed {
    return {
      supported: true, runtimeInstalled: false, runtimeRunning: false, imageReady: false, volumesPresent: false,
      container: 'absent', health: 'na', tokenInKeychain: false, tokenAccepted: 'unknown',
      credentialInKeychain: false, credentialInVolume: false, registered: false, harnesses: this.harnesses(), ...partial,
    };
  }

  /** Read-only: facts about the world plus the assessment. Never mutates anything. */
  async observe(signal?: AbortSignal, opts: { quick?: boolean } = {}): Promise<{ observed: Observed; desired: Desired; assessment: Assessment; version: string; port: number; vaultPath: string | null; daemonVersion?: string }> {
    const vaultPath = this.deps.vaultPath();
    await this.refreshExternalRoots(vaultPath);
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
    const containerImage = typeof ours === 'object' ? ours.image?.reference : undefined;
    // An existing container keeps its version (updates are prompt-only) unless its version alone is incompatible.
    const keepVersion = containerVersion !== undefined && assessDaemonVersion(pluginVersion, containerVersion) !== 'required';
    const version = keepVersion ? containerVersion : pluginVersion;
    const running = typeof ours === 'object' && ours.state === 'running';
    // `inspect` carries no exit facts on Apple `container`, so read the boot log. A stop or kill WE ran also ends in
    // SIGKILL (137), so only an exit we did not cause counts as out of memory.
    const lastExit = typeof ours === 'object' && ours.state === 'stopped' && !this.stoppedByUs ? await lastRunExit(d, vaultPath) : null;
    const stoppedOutOfMemory = lastExit !== null && looksOutOfMemory(lastExit);
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
    // `exec` probes need a live VM: skip them when healthz is down (a wedged VM would burn their timeouts) and in a
    // quick observation. The container exists, so its image and volumes do too; the last known credential state stands.
    const skipSlow = opts.quick === true || (running && health === 'down');
    const credentialInVolume = running && !skipSlow ? await credentialFilePresent(d, vaultPath) : settings.credentialWritten === true;
    const harnesses = this.harnesses();
    const harnessProbe = running && health === 'ok' && !skipSlow ? await probeHarnesses(d, vaultPath) : null;
    const assumeProvisioned = skipSlow && typeof ours === 'object';
    const plannedImage = retainedCodexImage(containerImage, version, harnesses) ?? localImageRef(version, harnesses);
    const observed: Observed = {
      supported: true,
      runtimeInstalled: true,
      runtimeRunning: true,
      imageReady: assumeProvisioned || await imagePresent(d, plannedImage),
      volumesPresent: assumeProvisioned || await volumesPresent(d, vaultPath),
      container: ours === 'absent' ? 'absent' : ours === 'foreign' ? 'foreign' : running ? 'running' : 'stopped',
      ...(containerVersion ? { containerVersion } : {}),
      ...(containerSpec ? { containerSpec } : {}),
      ...(containerImage ? { containerImage } : {}),
      ...(stoppedOutOfMemory ? { stoppedOutOfMemory: true } : {}),
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

  /**
   * The mounts the daemon is (or will next be) created with. Synchronous so a session prompt can use it, and it does
   * not depend on `observe()` having run: shared (work) folders are recomputed from settings each call, and external
   * roots come from the cache, with a one-time background refresh when it has never been filled. Empty without a vault.
   */
  currentMounts(): Array<{ host: string; guest: string; readOnly: boolean }> {
    const vaultPath = this.deps.vaultPath();
    if (!vaultPath) return [];
    const workFolders = resolveWorkFolders(sharedFolderList(this.settings(), this.deps.projectFolders), { vaultPath, isDirectory: (p) => this.deps.isDirectory(p) });
    if (!this.extRootsLoaded && !this.extRootsLoading && this.deps.externalRoots) {
      this.extRootsLoading = true;
      void this.refreshExternalRoots(vaultPath).catch(() => { /* refreshExternalRoots already swallows host errors */ });
    }
    return mountsFor({ vaultPath, maskedDirs: this.maskedDirs(vaultPath), externalRoots: dropOverlappingRoots(this.extRoots, workFolders), workFolders });
  }

  /** What a UI renders. Cheap enough to call when a panel opens; never mutates. */
  async snapshot(opts: { quick?: boolean } = {}): Promise<LocalDaemonSnapshot> {
    const o = await this.observe(undefined, opts);
    const binary = o.observed.supported ? (await readRuntime(this.deps.runtime)).binary : undefined;
    const current = !this.op && this.codexUpdateFrom(o);
    const token = current ? this.deps.secrets.get(LOCAL_DAEMON_TOKEN_SECRET) : undefined;
    const availability = token && this.deps.harnessMaintenance
      ? await this.deps.harnessMaintenance(o.port, token, 'GET') : 'unknown';
    return {
      assessment: o.assessment,
      observed: o.observed,
      ...(current ? { codexUpdate: { from: current, to: CODEX_VERSION, availability } } : {}),
      ...(o.daemonVersion ? { daemonVersion: o.daemonVersion } : {}),
      pluginVersion: this.deps.pluginVersion,
      port: o.port,
      ...(o.vaultPath ? { vaultPath: o.vaultPath } : {}),
      mounts: o.vaultPath ? this.currentMounts() : [],
      harnesses: this.harnesses(),
      ...(o.vaultPath ? { containerName: containerNameFor(o.vaultPath) } : {}),
      ...(binary ? { containerBinary: binary } : {}),
      busy: this.getBusy(),
      lastError: this.lastError,
      ...(this.watchdog ? { watchdog: this.watchdog.getState() } : {}),
    };
  }

  // ── watchdog ───────────────────────────────────────────────────────────────

  /**
   * Starts the health watchdog (idempotent). It polls with a quick snapshot and force-restarts a daemon that is
   * supposed to be running but stops answering. A timer is used because a wedged VM emits no event to react to.
   */
  startWatchdog(config: Partial<WatchdogConfig> = {}): void {
    if (this.watchdog) return;
    this.watchdog = new LocalDaemonWatchdog({
      target: this,
      isEnabled: () => { const s = this.settings(); return s.enabled && s.watchdog !== false; },
      onChange: () => this.notify(),
      ...(this.deps.log ? { log: this.deps.log } : {}),
      ...config,
    });
    this.watchdog.start();
  }

  /** Stops the watchdog's timer (plugin unload). Safe to call when it never started. */
  stopWatchdog(): void {
    this.watchdog?.stop();
    this.watchdog = null;
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
    const image = !plan.includes('build-image')
      ? retainedCodexImage(o.observed.containerImage, o.version, this.harnesses()) : undefined;

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
          await prepareVolumes(step(), { vaultPath, version: o.version, harnesses: this.harnesses(), ...(image ? { image } : {}), ...(credential ? { credential } : {}) });
          await this.patchSettings({ credentialWritten: !!credential });
          break;
        }
        case 'remove-container':
          await removeContainer(step(), vaultPath);
          break;
        case 'create-container': {
          port = await this.choosePort(o.port);
          await this.patchSettings({ port });
          await this.runAndAwaitHealthy(step(), vaultPath, () => createContainer(step(), { ...this.specFor(vaultPath, o.version, port), ...(image ? { image } : {}) }), port, ctx);
          break;
        }
        case 'start-container':
          await this.runAndAwaitHealthy(step(), vaultPath, () => startContainer(step(), vaultPath), port, ctx);
          break;
        case 'restart-container':
          await this.forceStop(step(), vaultPath);
          await this.runAndAwaitHealthy(step(), vaultPath, () => startContainer(step(), vaultPath), port, ctx);
          break;
        case 'apply-credential': {
          const credential = this.deps.secrets.get(CONTAINER_AUTH_TOKEN_SECRET);
          if (!credential) throw new LocalDaemonError('credential', 'There is no Claude sign-in to apply.');
          await stopContainer(step(), vaultPath);
          await prepareVolumes(step(), { vaultPath, version: o.version, harnesses: this.harnesses(), credential, ...(image ? { image } : {}) });
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
    this.stoppedByUs = false;
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

  private async assertPolicyAllows(): Promise<void> {
    const denied = await this.deps.policyDenial?.();
    if (denied) throw new LocalDaemonError('policy', denied);
  }

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
    // Before the "already healthy" fast path: an existing container is not attached to when policy forbids the target.
    await this.assertPolicyAllows();
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
      this.stoppedByUs = true;
      await stopContainer({ runner: this.deps.createRunner(), signal: ctx.signal }, vaultPath);
    });
  }

  private forceStop(d: StepDeps, vaultPath: string, skipGraceful = false): Promise<void> {
    this.stoppedByUs = true;
    return forceStopContainer(d, vaultPath, { skipGraceful, ...(this.deps.killVmHelper ? { killVmHelper: (n: string) => this.deps.killVmHelper!(n) } : {}) });
  }

  /** Force-stop for a wedged daemon: skips the graceful stop, then kill, then the VM helper process. Data is kept. */
  kill(opts: RunOptions = {}): Promise<void> {
    return this.runOp('kill', opts, async (ctx) => {
      const vaultPath = this.requireVault();
      await this.forceStop({ runner: this.deps.createRunner(), signal: ctx.signal }, vaultPath, true);
    });
  }

  restart(opts: RunOptions = {}): Promise<Assessment> {
    return this.runOp('restart', opts, async (ctx) => {
      this.requireEnabled();
      const vaultPath = this.requireVault();
      await this.forceStop({ runner: this.deps.createRunner(), signal: ctx.signal }, vaultPath);
      return this.reconcile(ctx);
    });
  }

  private codexUpdateFrom({ observed, assessment }: Awaited<ReturnType<LocalDaemonController['observe']>>): string | undefined {
    if (!this.harnesses().includes('codex') || observed.container !== 'running' || observed.tokenAccepted !== 'yes'
      || assessment.drift || (assessment.status !== 'running' && assessment.status !== 'needs-sign-in')) return undefined;
    const installed = observed.harnessProbe?.codex?.version;
    if (!installed) return undefined;
    const ordering = compareVersions(installed.split(/[-+]/, 1)[0], CODEX_VERSION);
    return ordering < 0 || (ordering === 0 && installed.split('+', 1)[0].includes('-')) ? installed : undefined;
  }

  /** Installs the reviewed Codex pin on the currently installed image. Never changes the daemon's base version. */
  updateHarnesses(preview: CodexUpdatePreview, opts: RunOptions = {}): Promise<void> {
    return this.runOp('update-harnesses', opts, async (ctx) => {
      this.requireEnabled();
      const vaultPath = this.requireVault();
      const before = await this.observe(ctx.signal);
      this.guardStatus(before.assessment, before.observed);
      const from = this.codexUpdateFrom(before);
      if (!from || preview.from !== from || preview.to !== CODEX_VERSION) {
        throw new LocalDaemonError('unavailable', 'The Codex version or daemon settings changed. Check the update again.');
      }
      const token = this.deps.secrets.get(LOCAL_DAEMON_TOKEN_SECRET);
      const maintenance = this.deps.harnessMaintenance;
      if (!token || !maintenance) throw new LocalDaemonError('unavailable', 'Could not verify that the local daemon is idle.');
      const check = (method: 'GET' | 'POST' | 'DELETE', id?: string) => maintenance(before.port, token, method, id);
      this.requireHarnessIdle(await check('GET'));

      const runner = this.deps.createRunner();
      const d: StepDeps = { runner, signal: ctx.signal, report: (line) => ctx.emit({ line, ...percentOf(line) }) };
      const spec = this.specFor(vaultPath, before.version, before.port);
      const current = await inspectOurContainer(d, vaultPath);
      const previousImage = typeof current === 'object' ? current.image : undefined;
      if (!previousImage || typeof current !== 'object' || current.state !== 'running'
        || current.labels[LABEL_SPEC] !== specSignature(spec)
        || await imageDigest(d, previousImage.reference) !== previousImage.digest) {
        throw new LocalDaemonError('unavailable', 'Could not verify the running daemon’s image for rollback.');
      }
      const image = `${localImageRef(spec.version, spec.harnesses)}-codex-refresh-${CODEX_VERSION}-${previousImage.digest.slice(7, 19)}`;
      ctx.emit({ label: `Building the Codex ${CODEX_VERSION} image` });
      await buildThinImage(d, spec.version, spec.harnesses, { previousImage: previousImage.reference, image });
      await verifyThinImage(d, spec.version, spec.harnesses, image);
      const candidate = await imageDigest(d, image);
      if (!candidate || candidate === previousImage.digest) throw new LocalDaemonError('verify', 'Could not verify the replacement daemon image.');

      const id = randomHex(16);
      let replacementVerified = false;
      try {
        this.requireHarnessIdle(await check('POST', id));
        // A turn arriving during the build wins. Once the lease is acquired, no new work can start on either image.
        const latest = await inspectOurContainer(d, vaultPath);
        if (typeof latest !== 'object' || latest.state !== 'running' || latest.image?.digest !== previousImage.digest
          || latest.labels[LABEL_SPEC] !== specSignature(this.specFor(vaultPath, before.version, before.port))
          || await imageDigest(d, previousImage.reference) !== previousImage.digest
          || (await probeHarnesses(d, vaultPath))?.codex?.version !== from) {
          throw new LocalDaemonError('unavailable', 'The daemon changed while the image was building. Check the update again.');
        }
        if (ctx.signal.aborted) throw new LocalDaemonAbortedError();

        // After stopping the old container, finish cutover or restore the old image even if the panel closes.
        const swap: OpContext = { signal: new AbortController().signal, emit: (p) => ctx.emit({ ...p, cancellable: false }) };
        const steps: StepDeps = { runner, signal: swap.signal };
        swap.emit({ label: 'Replacing the idle daemon' });
        try {
          await stopContainer(steps, vaultPath);
          await removeContainer(steps, vaultPath);
          await this.runAndAwaitHealthy(steps, vaultPath, () => createContainer(steps, { ...spec, image }), spec.hostPort, swap);
          const observed = await this.deps.probeDaemon(localDaemonUrl(spec.hostPort), token);
          const installed = (await probeHarnesses(steps, vaultPath))?.codex?.version;
          if (!observed.ok || observed.info.daemonVersion !== spec.version || installed !== CODEX_VERSION) {
            throw new LocalDaemonError('verify', `The replacement daemon did not answer with Codex ${CODEX_VERSION}.`);
          }
          replacementVerified = true;
        } catch (err) {
          swap.emit({ label: 'Restoring the previous daemon image' });
          const cause = err instanceof Error ? err.message : String(err);
          try {
            const previous = { ...spec, image: previousImage.reference };
            await this.restoreHarnessImage(steps, swap, previous, previousImage.digest, candidate);
          } catch (rollback) {
            throw new LocalDaemonError('start', `${cause} Could not restore the previous daemon image: ${rollback instanceof Error ? rollback.message : String(rollback)}`);
          }
          throw new LocalDaemonError('start', `${cause} The previous daemon image was restored.`);
        }
      } finally {
        // DELETE is idempotent for this lease id. Attempt release even on a dropped acquisition reply.
        const release = () => check('DELETE', id).catch(() => 'unknown');
        if (await release() !== 'idle' && await release() !== 'idle' && replacementVerified) {
          throw new LocalDaemonError('unavailable', `Codex ${CODEX_VERSION} was installed, but the daemon could not confirm that maintenance ended. New turns may be paused until the maintenance lease expires.`);
        }
      }
    });
  }

  private requireHarnessIdle(availability: HarnessMaintenanceAvailability): void {
    if (availability === 'idle') return;
    if (availability === 'busy') throw new LocalDaemonError('busy', 'The local daemon is busy. Wait for running work and pending requests to finish, then retry.');
    if (availability === 'unsupported') throw new LocalDaemonError('incompatible', 'Update the local daemon before updating its Codex harness.');
    throw new LocalDaemonError('unavailable', 'Could not verify that the local daemon is idle.');
  }

  private async restoreHarnessImage(d: StepDeps, ctx: OpContext, spec: LocalDaemonSpec, previous: string, candidate: string): Promise<void> {
    const { vaultPath, hostPort } = spec;
    const current = await inspectOurContainer(d, vaultPath);
    if (current === 'foreign' || (typeof current === 'object' && current.image?.digest !== previous && current.image?.digest !== candidate)) {
      throw new LocalDaemonError('name-conflict', 'A different container is using the daemon name.');
    }
    if (typeof current === 'object' && current.image?.digest === previous) {
      if (current.state !== 'running') {
        await this.runAndAwaitHealthy(d, vaultPath, () => startContainer(d, vaultPath), hostPort, ctx);
      }
      return;
    }
    if (typeof current === 'object') {
      await stopContainer(d, vaultPath);
      await removeContainer(d, vaultPath);
    }
    if (!spec.image || await imageDigest(d, spec.image) !== previous) {
      throw new LocalDaemonError('verify', 'The previous daemon image is unavailable.');
    }
    await this.runAndAwaitHealthy(d, vaultPath, () => createContainer(d, spec), hostPort, ctx);
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
      const retained = retainedCodexImage(before.observed.containerImage, version, harnesses);
      const image = retained && await imagePresent(d, retained) ? retained : undefined;
      if (!image && !(await imagePresent(d, localImageRef(version, harnesses)))) {
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
      await prepareVolumes(d, { vaultPath, version, harnesses, ...(image ? { image } : {}), ...(credential ? { credential } : {}) });
      await this.patchSettings({ credentialWritten: credential ? true : this.settings().credentialWritten === true });
      const port = await this.choosePort(this.settings().port || DEFAULT_HOST_PORT);
      await this.patchSettings({ port });
      await this.runAndAwaitHealthy(d, vaultPath, () => createContainer(d, { ...this.specFor(vaultPath, version, port), ...(image ? { image } : {}) }), port, ctx);
      const result = await this.reconcile(ctx);
      if (result.update !== 'none' && result.status !== 'degraded') {
        throw new LocalDaemonError('incompatible', `The daemon still reports a different version than v${version} after updating.`);
      }
      if (oldVersion && oldVersion !== version) await removeImage(d, oldVersion, harnesses);
      await pruneStaleDaemonImages(d, version);
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
   * Claude sign-in for the daemon. Reuses an existing container sign-in (no prompt) when the keychain has one
   * (unless `force`, used when that token has expired); otherwise runs the in-container `claude setup-token` flow once, stores the token, and writes it to the daemon.
   */
  signIn(handlers: SignInHandlers, opts: RunOptions & { force?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.runOp('sign-in', opts, async (ctx) => {
      this.requireEnabled();
      if (!this.harnesses().includes('claude')) return { ok: false as const, error: 'Claude is turned off for the local daemon. Turn it on first.' };
      // `force`: the stored token no longer works (expired or revoked), so run the flow again instead of reusing it.
      if (!opts.force && this.deps.secrets.get(CONTAINER_AUTH_TOKEN_SECRET)) {
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
      if (opts.force) {
        // The volume already holds a credential (the stale one), so the plan would never rewrite it: do it explicitly.
        const o = await this.observe(ctx.signal);
        await this.execute(['apply-credential'], o, ctx);
      }
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
   * Non-Claude harness sign-in inside the daemon container:
   * - `codex`: `codex login --device-auth` (URL + one-time code, nothing to paste back).
   * - `antigravity`: `agy acp --login` (Google OAuth URL, then paste authorization code / callback URL on stdin).
   * Credentials are created by each CLI in the daemon's data volume; this plugin never sees or stores them.
   * OpenCode has no non-interactive login, so it is refused here with the exact command to run (`manualLoginCommand`).
   */
  signInHarness(
    harness: Exclude<LocalHarness, 'claude'>,
    handlers: Pick<SignInHandlers, 'onProgress' | 'onUrl'> & Partial<Pick<SignInHandlers, 'onCodePrompt'>>,
    opts: RunOptions = {},
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.runOp('sign-in', opts, async (ctx) => {
      this.requireEnabled();
      const vaultPath = this.requireVault();
      const manual = async (): Promise<string> => manualLoginCommand(harness, containerNameFor(vaultPath), (await readRuntime(this.deps.runtime)).binary ?? undefined);
      if (!this.harnesses().includes(harness)) return { ok: false as const, error: `${harness} is turned off for the local daemon. Turn it on and apply the change first.` };
      if ((harness !== 'codex' && harness !== 'antigravity') || !this.deps.harnessSignInRunner) {
        return { ok: false as const, error: `${harness} cannot be signed in from Settings. Run this in a terminal:\n${await manual()}` };
      }
      if (harness === 'antigravity' && !handlers.onCodePrompt) {
        return { ok: false as const, error: `Antigravity sign-in needs an authorization code prompt. Run this in a terminal:\n${await manual()}` };
      }
      const label = HARNESS_LABEL[harness];
      ctx.emit({ label: `Signing in to ${label}` });
      await this.reconcile(ctx);
      const d: StepDeps = { runner: this.deps.createRunner(), signal: ctx.signal };
      const before = await probeHarnesses(d, vaultPath);
      if (before && before[harness]?.cli === false) {
        return { ok: false as const, error: `The ${label} CLI is not in the daemon image. Apply the harness change (Update) so the image is rebuilt with it.` };
      }
      const result = await this.deps.harnessSignInRunner({
        harness,
        containerName: containerNameFor(vaultPath),
        onProgress: handlers.onProgress,
        onUrl: handlers.onUrl,
        ...(handlers.onCodePrompt ? { onCodePrompt: handlers.onCodePrompt } : {}),
      });
      if (!result.ok) return { ok: false as const, error: `${result.error}\nOr run this in a terminal:\n${await manual()}` };
      const after = await probeHarnesses(d, vaultPath);
      if (after && after[harness]?.signedIn === false) {
        return { ok: false as const, error: `${label} reported success but no login was found in the daemon. Run this in a terminal:\n${await manual()}` };
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
