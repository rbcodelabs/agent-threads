/**
 * Local daemon: the side-effecting steps, each a small idempotent function over
 * an injected {@link VmCommandRunner}. Nothing here decides WHAT to do (that is
 * `assess.ts`) or holds state (that is `controller.ts`).
 *
 * Every function throws {@link LocalDaemonError} with a typed `code`, or
 * {@link LocalDaemonAbortedError}; callers never have to parse messages.
 * Secrets (the control token, the Claude credential) are never placed in argv:
 * the credential travels on stdin, the token is read from `exec` stdout and
 * kept out of every message.
 */

import { VM_LIFECYCLE_TIMEOUT_MS, type VmCommandResult, type VmCommandRunner } from '../containerCli';
import {
  BUILD_TIMEOUT_MS,
  MAX_BUFFER_BYTES,
  PULL_TIMEOUT_MS,
  LOCAL_TOKEN_NAME,
  VERIFY_OK_MARKER,
  thinDockerfileFor,
  harnessProbeArgs,
  normalizeHarnesses,
  LABEL_OWNER,
  buildThinImageArgs,
  containerNameFor,
  credentialPresentArgs,
  dataVolumeFor,
  imageInspectArgs,
  imageRemoveArgs,
  inspectContainerArgs,
  localImageRef,
  logsArgs,
  bootLogArgs,
  prepareArgs,
  publishedImageRef,
  pullArgs,
  removeContainerArgs,
  runArgs,
  startContainerArgs,
  stopContainerArgs,
  killContainerArgs,
  tokenCreateArgs,
  tokenListArgs,
  tokenRevokeArgs,
  verifyImageArgs,
  volumeCreateArgs,
  volumeInspectArgs,
  volumeRemoveArgs,
  workspacesVolumeFor,
  type LocalDaemonSpec,
} from './spec';
import {
  classifyPullError,
  describePullFailure,
  parseInspectedContainer,
  parseTokenCreate,
  parseHarnessProbe,
  type HarnessProbeResult,
  parseTokenList,
  redactSecrets,
  tail,
  type InspectedContainer,
  type LastRunExit,
  parseBootLogExit,
} from './parse';

export type LocalDaemonErrorCode =
  | 'pull-denied' | 'pull-not-found' | 'pull-network' | 'disk' | 'pull'
  | 'build' | 'verify' | 'volume' | 'prepare' | 'run' | 'port-in-use' | 'name-conflict'
  | 'start' | 'stop' | 'remove' | 'health' | 'token' | 'keychain' | 'credential'
  | 'runtime' | 'unsupported' | 'not-set-up' | 'needs-sign-in' | 'incompatible' | 'busy' | 'unavailable';

export class LocalDaemonError extends Error {
  constructor(readonly code: LocalDaemonErrorCode, message: string, readonly detail?: string) {
    super(message);
    this.name = 'LocalDaemonError';
  }
}

export class LocalDaemonAbortedError extends Error {
  constructor() {
    super('The local daemon operation was cancelled.');
    this.name = 'AbortError';
  }
}

export interface StepDeps {
  runner: VmCommandRunner;
  signal?: AbortSignal;
  /** Human-readable progress: a phase message or a line of CLI output. */
  report?: (line: string) => void;
}

const SHORT_TIMEOUT_MS = 20_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LocalDaemonAbortedError();
}

function text(r: VmCommandResult): string {
  return `${r.stderr}\n${r.stdout}`.trim();
}

function failed(code: LocalDaemonErrorCode, what: string, r: VmCommandResult, secrets: ReadonlyArray<string | undefined> = []): LocalDaemonError {
  const body = redactSecrets(tail(text(r)), secrets);
  return new LocalDaemonError(code, `${what} failed (exit ${r.exitCode}):\n${body}`, body);
}

async function run(
  d: StepDeps,
  args: string[],
  timeoutMs: number,
  extra: { input?: string; chatty?: boolean } = {},
): Promise<VmCommandResult> {
  throwIfAborted(d.signal);
  const r = await d.runner(args, {
    timeoutMs,
    signal: d.signal,
    ...(extra.input !== undefined ? { input: extra.input } : {}),
    ...(extra.chatty ? { onOutput: d.report, maxBufferBytes: MAX_BUFFER_BYTES } : {}),
  });
  throwIfAborted(d.signal);
  return r;
}

// ── Observation helpers (never throw on "does not exist") ────────────────────

export async function imagePresent(d: StepDeps, ref: string): Promise<boolean> {
  return (await run(d, imageInspectArgs(ref), SHORT_TIMEOUT_MS)).exitCode === 0;
}

export async function volumesPresent(d: StepDeps, vaultPath: string): Promise<boolean> {
  for (const name of [dataVolumeFor(vaultPath), workspacesVolumeFor(vaultPath)]) {
    if ((await run(d, volumeInspectArgs(name), SHORT_TIMEOUT_MS)).exitCode !== 0) return false;
  }
  return true;
}

/** `absent` (no such container), `foreign` (the name is taken by something we did not create), or ours. */
export async function inspectOurContainer(d: StepDeps, vaultPath: string): Promise<'absent' | 'foreign' | InspectedContainer> {
  const r = await run(d, inspectContainerArgs(containerNameFor(vaultPath)), SHORT_TIMEOUT_MS);
  if (r.exitCode !== 0) return 'absent';
  const parsed = parseInspectedContainer(r.stdout);
  // An empty `inspect` result also means absent (some CLI versions exit 0 with `[]`).
  if (!parsed) return r.stdout.trim() === '' || r.stdout.trim() === '[]' ? 'absent' : 'foreign';
  return parsed.labels[LABEL_OWNER] === '1' ? parsed : 'foreign';
}

/**
 * Which harness CLIs the running container has and which logins exist in its persisted HOME (see
 * `HARNESS_PROBE_SCRIPT`). Null when the probe could not run or printed nothing recognisable: callers show
 * "unknown", never a guess.
 */
export async function probeHarnesses(d: StepDeps, vaultPath: string): Promise<HarnessProbeResult | null> {
  const r = await run(d, harnessProbeArgs(containerNameFor(vaultPath)), SHORT_TIMEOUT_MS);
  return r.exitCode === 0 ? parseHarnessProbe(r.stdout) : null;
}

/** Probes whether the credential file is present inside the running container. */
export async function credentialFilePresent(d: StepDeps, vaultPath: string): Promise<boolean> {
  return (await run(d, credentialPresentArgs(containerNameFor(vaultPath)), SHORT_TIMEOUT_MS)).exitCode === 0;
}

// ── Image: pull, build the thin harness layer, verify ─────────────────────────

export async function pullDaemonImage(d: StepDeps, version: string): Promise<void> {
  const ref = publishedImageRef(version);
  d.report?.(`Pulling ${ref}`);
  const r = await run(d, pullArgs(version), PULL_TIMEOUT_MS, { chatty: true });
  if (r.exitCode === 0) return;
  const kind = classifyPullError(text(r));
  const code: LocalDaemonErrorCode = kind === 'denied' ? 'pull-denied' : kind === 'not-found' ? 'pull-not-found'
    : kind === 'network' ? 'pull-network' : kind === 'disk' ? 'disk' : 'pull';
  const detail = tail(text(r));
  throw new LocalDaemonError(code, kind === 'unknown' ? `${describePullFailure(kind, ref, version)}\n${detail}` : describePullFailure(kind, ref, version), detail);
}

function installNote(harnesses?: readonly string[]): string {
  const set = normalizeHarnesses(harnesses);
  const parts = [
    ...(set.includes('claude') ? ['the Claude CLI from Anthropic'] : []),
    ...(set.includes('codex') ? ['the Codex CLI (npm @openai/codex)'] : []),
    ...(set.includes('opencode') ? ['the OpenCode CLI (npm opencode-ai)'] : []),
  ];
  return `installs ${parts.join(', ')}`;
}

export async function buildThinImage(d: StepDeps, version: string, harnesses?: readonly string[]): Promise<void> {
  d.report?.(`Building ${localImageRef(version, harnesses)} (${installNote(harnesses)})`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs/promises') as typeof import('fs/promises');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  let dir: string | null = null;
  try {
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-threads-daemon-build-'));
      await fs.writeFile(path.join(dir, 'Dockerfile'), thinDockerfileFor(harnesses), 'utf8');
    } catch (err) {
      throw new LocalDaemonError('build', `Writing the daemon Dockerfile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const r = await run(d, buildThinImageArgs({ version, dockerfilePath: path.join(dir, 'Dockerfile'), contextDir: dir, harnesses }), BUILD_TIMEOUT_MS, { chatty: true });
    if (r.exitCode !== 0) {
      const kind = classifyPullError(text(r));
      if (kind === 'disk') throw new LocalDaemonError('disk', describePullFailure('disk', publishedImageRef(version), version), tail(text(r)));
      throw failed('build', `Adding the agent CLIs to the daemon image (${installNote(harnesses)})`, r);
    }
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function verifyThinImage(d: StepDeps, version: string, harnesses?: readonly string[]): Promise<void> {
  const r = await run(d, verifyImageArgs(version, harnesses), 60_000);
  if (r.exitCode !== 0 || !r.stdout.includes(VERIFY_OK_MARKER)) {
    throw failed('verify', `${localImageRef(version, harnesses)} was built but is missing ${[...normalizeHarnesses(harnesses), 'agent-threads', 'git'].join(', ')};`, r);
  }
}

/** Pull + build + verify. */
export async function ensureImage(d: StepDeps, version: string, harnesses?: readonly string[]): Promise<void> {
  await pullDaemonImage(d, version);
  await buildThinImage(d, version, harnesses);
  await verifyThinImage(d, version, harnesses);
}

// ── Volumes ──────────────────────────────────────────────────────────────────

export async function createVolumes(d: StepDeps, vaultPath: string): Promise<void> {
  for (const name of [dataVolumeFor(vaultPath), workspacesVolumeFor(vaultPath)]) {
    const r = await run(d, volumeCreateArgs(name), VM_LIFECYCLE_TIMEOUT_MS);
    if (r.exitCode === 0) continue;
    // Not every runtime version makes `create` idempotent: an existing volume is fine.
    if ((await run(d, volumeInspectArgs(name), SHORT_TIMEOUT_MS)).exitCode === 0) continue;
    throw failed('volume', `Creating volume ${name}`, r);
  }
}

export async function removeVolumes(d: StepDeps, vaultPath: string): Promise<void> {
  for (const name of [dataVolumeFor(vaultPath), workspacesVolumeFor(vaultPath)]) {
    const present = (await run(d, volumeInspectArgs(name), SHORT_TIMEOUT_MS)).exitCode === 0;
    if (!present) continue;
    const r = await run(d, volumeRemoveArgs(name), VM_LIFECYCLE_TIMEOUT_MS);
    if (r.exitCode !== 0) throw failed('volume', `Removing volume ${name}`, r);
  }
}

/**
 * Fix ownership of the volumes (named volumes are root-owned) and optionally write the Claude credential into the
 * data volume from stdin. Safe to repeat; run it with the daemon container STOPPED (a volume cannot be assumed
 * attachable twice).
 */
export async function prepareVolumes(
  d: StepDeps,
  opts: { vaultPath: string; version: string; credential?: string; harnesses?: readonly string[] },
): Promise<void> {
  const withCredential = !!opts.credential;
  d.report?.(withCredential ? 'Preparing the data volume and writing the Claude credential' : 'Preparing the data volume');
  const r = await run(
    d,
    prepareArgs({ vaultPath: opts.vaultPath, version: opts.version, withCredential, harnesses: opts.harnesses }),
    VM_LIFECYCLE_TIMEOUT_MS,
    withCredential ? { input: opts.credential } : {},
  );
  if (r.exitCode !== 0) {
    throw failed(withCredential && /credential was not received/.test(text(r)) ? 'credential' : 'prepare', 'Preparing the daemon data volume', r, [opts.credential]);
  }
}

// ── Container lifecycle ──────────────────────────────────────────────────────

export async function createContainer(d: StepDeps, spec: LocalDaemonSpec): Promise<void> {
  d.report?.('Starting the daemon container');
  const r = await run(d, runArgs(spec), VM_LIFECYCLE_TIMEOUT_MS);
  if (r.exitCode === 0) return;
  const out = text(r);
  if (/address already in use|port is already|port .*in use|EADDRINUSE|failed to bind/i.test(out)) {
    throw new LocalDaemonError('port-in-use', `Port ${spec.hostPort} on this Mac is already in use.`, tail(out));
  }
  if (/already exists|name.*in use|exists/i.test(out)) {
    throw new LocalDaemonError('name-conflict', 'A container with the daemon\'s name already exists. It was not created by Agent Threads, so it was left alone.', tail(out));
  }
  throw failed('run', 'Starting the daemon container', r);
}

export async function startContainer(d: StepDeps, vaultPath: string): Promise<void> {
  const r = await run(d, startContainerArgs(containerNameFor(vaultPath)), VM_LIFECYCLE_TIMEOUT_MS);
  if (r.exitCode !== 0) throw failed('start', 'Starting the daemon container', r);
}

/** Graceful stop (the daemon flushes its journals on SIGTERM). Already-stopped is success. */
export async function stopContainer(d: StepDeps, vaultPath: string): Promise<void> {
  const r = await run(d, stopContainerArgs(containerNameFor(vaultPath)), 60_000);
  if (r.exitCode === 0) return;
  const state = await inspectOurContainer(d, vaultPath);
  if (state === 'absent' || (state !== 'foreign' && state.state !== 'running')) return;
  throw failed('stop', 'Stopping the daemon container', r);
}

const ESCALATION_TIMEOUT_MS = 15_000;

export interface ForceStopOptions {
  /** Ends the container's VM helper process on the host (`container-runtime-linux`); the last resort for a wedged VM. */
  killVmHelper?(containerName: string): Promise<void>;
  /** Skip the graceful `stop` (the Kill button). */
  skipGraceful?: boolean;
}

async function isStopped(d: StepDeps, vaultPath: string): Promise<boolean> {
  const state = await inspectOurContainer(d, vaultPath);
  return state === 'absent' || (state !== 'foreign' && state.state !== 'running');
}

/**
 * Stops the container however it takes: `stop` with a short timeout, then `kill`, then the VM helper process. A
 * wedged VM (out of memory) ignores `container stop`, so one 60 s attempt would just hang. Never throws for a step
 * that merely did not work; throws only when the container is still running after every step.
 */
export async function forceStopContainer(d: StepDeps, vaultPath: string, opts: ForceStopOptions = {}): Promise<void> {
  const name = containerNameFor(vaultPath);
  if (!opts.skipGraceful) {
    await run(d, stopContainerArgs(name), ESCALATION_TIMEOUT_MS);
    if (await isStopped(d, vaultPath)) return;
  }
  await run(d, killContainerArgs(name), ESCALATION_TIMEOUT_MS);
  if (await isStopped(d, vaultPath)) return;
  if (opts.killVmHelper) {
    try { await opts.killVmHelper(name); } catch { /* reported below if the container is still up */ }
    // With the helper gone the apiserver can finally reap the container.
    await run(d, stopContainerArgs(name), ESCALATION_TIMEOUT_MS);
    if (await isStopped(d, vaultPath)) return;
  }
  throw new LocalDaemonError('stop', 'The daemon container did not stop (graceful stop, kill and ending its VM process all failed). Restart the container runtime or this Mac.');
}

/** Removes OUR container only (the caller has already established ownership). Absent is success. */
export async function removeContainer(d: StepDeps, vaultPath: string): Promise<void> {
  const r = await run(d, removeContainerArgs(containerNameFor(vaultPath)), VM_LIFECYCLE_TIMEOUT_MS);
  if (r.exitCode === 0) return;
  if ((await inspectOurContainer(d, vaultPath)) === 'absent') return;
  throw failed('remove', 'Removing the daemon container', r);
}

export async function removeImage(d: StepDeps, version: string, harnesses?: readonly string[]): Promise<void> {
  const ref = localImageRef(version, harnesses);
  if (!(await imagePresent(d, ref))) return;
  // Best effort: an image still used by a container is simply kept.
  await run(d, imageRemoveArgs(ref), VM_LIFECYCLE_TIMEOUT_MS);
}

/** Last lines of the container log, for a failure message. Never throws. */
export async function logTail(d: StepDeps, vaultPath: string): Promise<string> {
  try {
    const r = await d.runner(logsArgs(containerNameFor(vaultPath)), { timeoutMs: SHORT_TIMEOUT_MS, signal: d.signal });
    return tail(text(r), 20);
  } catch {
    return '(no log available)';
  }
}

/** How the stopped container's last run ended (see `parseBootLogExit`). Null when the boot log is unavailable. Never throws. */
export async function lastRunExit(d: StepDeps, vaultPath: string): Promise<LastRunExit | null> {
  try {
    const r = await d.runner(bootLogArgs(containerNameFor(vaultPath)), { timeoutMs: SHORT_TIMEOUT_MS, signal: d.signal });
    return r.exitCode === 0 ? parseBootLogExit(r.stdout) : null;
  } catch {
    return null;
  }
}

// ── Readiness ────────────────────────────────────────────────────────────────

export interface WaitHealthyOptions {
  /** One `GET /healthz`; true when the daemon answered ok. */
  probe: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
  signal?: AbortSignal;
}

/**
 * Bounded poll of `/healthz` after `run`: waiting on an event we caused (the daemon booting), not a state-guessing
 * timer. Returns false when it never answered.
 */
export async function waitHealthy(o: WaitHealthyOptions): Promise<boolean> {
  const attempts = o.attempts ?? 60;
  const delay = o.delayMs ?? 1000;
  for (let i = 0; i < attempts; i++) {
    throwIfAborted(o.signal);
    if (await o.probe()) return true;
    if (i < attempts - 1) await o.sleep(delay);
  }
  return false;
}

// ── Control token ────────────────────────────────────────────────────────────

export interface MintTokenOptions {
  vaultPath: string;
  /** Persist the token (keychain) BEFORE anything else uses it. Must throw if it cannot. */
  store: (token: string) => void;
}

/**
 * Crash-safe order: revoke any stale `geode-local` token (an orphan from a crash between create and store, or one
 * the keychain lost), create a new one, store it in the keychain IMMEDIATELY, and if the store fails revoke the new
 * token and fail. The token is never logged or put in argv.
 */
export async function mintControlToken(d: StepDeps, o: MintTokenOptions): Promise<{ id: string }> {
  const name = containerNameFor(o.vaultPath);
  const list = await run(d, tokenListArgs(name), SHORT_TIMEOUT_MS);
  if (list.exitCode === 0) {
    for (const t of parseTokenList(list.stdout)) {
      if (t.name === LOCAL_TOKEN_NAME && !t.revoked) {
        await run(d, tokenRevokeArgs(name, t.id), SHORT_TIMEOUT_MS);
      }
    }
  }
  const create = await run(d, tokenCreateArgs(name), SHORT_TIMEOUT_MS);
  const created = create.exitCode === 0 ? parseTokenCreate(create.stdout) : null;
  if (!created) {
    // Do not include stdout: it may contain the token.
    const body = redactSecrets(tail(create.stderr), []);
    throw new LocalDaemonError('token', `Creating the daemon access token failed (exit ${create.exitCode}).\n${body}`, body);
  }
  try {
    o.store(created.token);
  } catch (err) {
    await run(d, tokenRevokeArgs(name, created.id), SHORT_TIMEOUT_MS).catch(() => undefined);
    throw new LocalDaemonError('keychain', `The access token could not be saved to the keychain: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { id: created.id };
}
