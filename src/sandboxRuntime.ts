/**
 * sandboxRuntime.ts — detect, install and start Apple's open-source `container`
 * runtime so sandboxed VMs need ZERO manual setup (no `brew install container`).
 *
 * ## Shape
 *
 *   detectRuntime()        find a usable `container` (system copy wins over managed)
 *   installManagedRuntime  download the pinned signed .pkg, verify sha256,
 *                          `pkgutil --expand-full` (no root needed), move the
 *                          Payload into a versioned folder
 *   startRuntime()         `container system start --enable-kernel-install`
 *   getRuntimeStatus()     one snapshot a Settings UI can render
 *
 * ## Why the managed copy lives outside the vault
 *
 * ~423 MB of binaries. Vaults are frequently iCloud-synced, so the managed
 * runtime goes under `~/Library/Application Support/claude-threads/runtime`,
 * never inside the vault.
 *
 * ## One runtime at a time
 *
 * The launchd labels (`com.apple.container.apiserver`) are fixed per user, so
 * two runtimes cannot run together. If ANY runtime is already up, `startRuntime`
 * does nothing — `container system status` from any binary talks to the same
 * service.
 *
 * ## Testing seam
 *
 * Every OS interaction (exec, download, fs, platform facts) is reached through
 * `RuntimeDeps`, so unit tests need no network, no macOS 26 and no real runtime.
 *
 * ## Node builtins are required lazily
 *
 * Same convention as `sandboxVm.ts`: nothing is loaded at module scope, so
 * importing this on mobile is inert.
 */

// ── Pinned release ───────────────────────────────────────────────────────────

export const RUNTIME_VERSION = '1.5.0';
export const RUNTIME_PKG_URL =
  `https://github.com/apple/container/releases/download/${RUNTIME_VERSION}/container-${RUNTIME_VERSION}-installer-signed.pkg`;
export const RUNTIME_PKG_SHA256 = 'a24808cb202318fa1c3bbee0c6c6887fe1225fe899d7b687a0ddd939bd6573f8';
export const RUNTIME_PKG_BYTES = 118_045_087;

/** Expanded payload is ~423 MB and the pkg is ~118 MB; require headroom for both plus the kernel. */
export const RUNTIME_MIN_FREE_BYTES = 1_200_000_000;

/** Darwin kernel major that corresponds to macOS 26. */
export const MIN_DARWIN_MAJOR = 25;

export const MAX_DOWNLOAD_REDIRECTS = 5;
export const RUNTIME_START_TIMEOUT_SECONDS = 180;
/** A lock older than this is assumed to belong to a crashed installer. */
export const INSTALL_LOCK_STALE_MS = 30 * 60_000;

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface RuntimePin {
  version: string;
  url: string;
  sha256: string;
  bytes: number;
}

export const DEFAULT_RUNTIME_PIN: RuntimePin = {
  version: RUNTIME_VERSION,
  url: RUNTIME_PKG_URL,
  sha256: RUNTIME_PKG_SHA256,
  bytes: RUNTIME_PKG_BYTES,
};

export type RuntimeSource = 'system' | 'managed';

export interface DetectedRuntime {
  source: RuntimeSource;
  binary: string;
  version?: string;
}

export type RuntimePhase =
  | 'checking' | 'downloading' | 'verifying' | 'unpacking' | 'finalizing' | 'starting' | 'done';

export interface RuntimeProgress {
  phase: RuntimePhase;
  message?: string;
  bytes?: number;
  total?: number;
  /** 0-100, only while downloading. */
  percent?: number;
}
export type RuntimeProgressFn = (p: RuntimeProgress) => void;

export interface ExecResult { exitCode: number; stdout: string; stderr: string }

/** Resolves with a non-zero `exitCode` for a command that ran and failed; REJECTS only when it could not be run. */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; env?: Record<string, string | undefined>; signal?: AbortSignal },
) => Promise<ExecResult>;

export interface DownloadOptions {
  url: string;
  dest: string;
  signal?: AbortSignal;
  maxRedirects?: number;
  onBytes?: (bytes: number, total?: number) => void;
  /** Tests only: permit http:// (production downloads are https-only). */
  allowInsecure?: boolean;
}
export type DownloadFn = (opts: DownloadOptions) => Promise<{ bytes: number }>;

/** The subset of `fs.promises` + sync helpers the manager touches. */
export interface RuntimeFs {
  exists(p: string): boolean;
  mkdirp(p: string): Promise<void>;
  rm(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  readdir(p: string): Promise<string[]>;
  fileSize(p: string): Promise<number>;
  mtimeMs(p: string): Promise<number>;
  sha256(p: string): Promise<string>;
  freeBytes(p: string): Promise<number>;
  /** Exclusive create; returns false when the file already exists. */
  createExclusive(p: string, content: string): Promise<boolean>;
}

export interface RuntimeDeps {
  platform(): string;
  arch(): string;
  /** `os.release()` — on Darwin this is the kernel version, e.g. `25.4.0`. */
  osRelease(): string;
  homedir(): string;
  env(): Record<string, string | undefined>;
  exec: ExecFn;
  download: DownloadFn;
  fs: RuntimeFs;
  now(): number;
  tmpSuffix(): string;
  /** Well-known install dirs searched after PATH. Defaults to Homebrew + /usr/local. */
  systemDirs?: string[];
}

export class RuntimeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeInstallError';
  }
}

export class RuntimeAbortError extends Error {
  constructor() {
    super('Runtime install was cancelled');
    this.name = 'AbortError';
  }
}

// ── Real dependencies (lazy requires) ────────────────────────────────────────

function nodeRequire<T>(name: string): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(name) as T | null;
  if (!mod) throw new Error(`Node builtin "${name}" is not available on this platform`);
  return mod;
}

function createNodeExec(): ExecFn {
  return (file, args, opts) =>
    new Promise<ExecResult>((resolve, reject) => {
      const cp = nodeRequire<typeof import('child_process')>('child_process');
      cp.execFile(
        file,
        args,
        {
          timeout: opts.timeoutMs,
          env: opts.env as NodeJS.ProcessEnv | undefined,
          signal: opts.signal,
          maxBuffer: 16 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          if (error.name === 'AbortError') { reject(new RuntimeAbortError()); return; }
          if (code === 'ENOENT' || code === 'EACCES') { reject(error); return; }
          const exitCode = typeof code === 'number' ? code : 1;
          resolve({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    });
}

/**
 * Streams `url` to `dest`, following up to `maxRedirects` redirects (GitHub
 * release URLs 302 to object storage). Rejects with `RuntimeAbortError` when
 * `signal` fires. Does NOT clean up `dest`; the caller owns that.
 */
export function createNodeDownload(): DownloadFn {
  return (opts) =>
    new Promise<{ bytes: number }>((resolve, reject) => {
      const nodeFs = nodeRequire<typeof import('fs')>('fs');
      const maxRedirects = opts.maxRedirects ?? MAX_DOWNLOAD_REDIRECTS;
      let settled = false;
      let currentReq: import('http').ClientRequest | null = null;
      let out: import('fs').WriteStream | null = null;

      const finish = (err: Error | null, bytes = 0) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        if (err) {
          currentReq?.destroy();
          if (out) out.destroy();
          reject(err);
        } else {
          resolve({ bytes });
        }
      };
      const onAbort = () => finish(new RuntimeAbortError());

      if (opts.signal?.aborted) { reject(new RuntimeAbortError()); return; }
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      const get = (url: string, redirectsLeft: number) => {
        let parsed: URL;
        try { parsed = new URL(url); } catch { finish(new RuntimeInstallError(`Invalid download URL: ${url}`)); return; }
        if (parsed.protocol !== 'https:' && !(opts.allowInsecure && parsed.protocol === 'http:')) {
          finish(new RuntimeInstallError(`Refusing non-https download URL: ${url}`));
          return;
        }
        const mod = parsed.protocol === 'https:'
          ? nodeRequire<typeof import('https')>('https')
          : nodeRequire<typeof import('http')>('http');
        const req = mod.get(parsed, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              finish(new RuntimeInstallError(`Too many redirects (more than ${maxRedirects}) fetching ${opts.url}`));
              return;
            }
            get(new URL(res.headers.location, parsed).toString(), redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            finish(new RuntimeInstallError(`Download failed: HTTP ${status} from ${parsed.host}`));
            return;
          }
          const totalHeader = Number(res.headers['content-length']);
          const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;
          let bytes = 0;
          out = nodeFs.createWriteStream(opts.dest);
          out.on('error', (e) => finish(e));
          res.on('error', (e) => finish(e));
          res.on('aborted', () => finish(new RuntimeInstallError('Download connection was interrupted')));
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            opts.onBytes?.(bytes, total);
          });
          out.on('finish', () => finish(null, bytes));
          res.pipe(out);
        });
        currentReq = req;
        req.on('error', (e) => finish(opts.signal?.aborted ? new RuntimeAbortError() : e));
      };
      get(opts.url, maxRedirects);
    });
}

function createNodeFs(): RuntimeFs {
  const fs = () => nodeRequire<typeof import('fs')>('fs');
  return {
    exists: (p) => fs().existsSync(p),
    mkdirp: async (p) => { await fs().promises.mkdir(p, { recursive: true }); },
    rm: async (p) => { await fs().promises.rm(p, { recursive: true, force: true }); },
    rename: (a, b) => fs().promises.rename(a, b),
    chmod: (p, m) => fs().promises.chmod(p, m),
    readdir: (p) => fs().promises.readdir(p),
    fileSize: async (p) => (await fs().promises.stat(p)).size,
    mtimeMs: async (p) => (await fs().promises.stat(p)).mtimeMs,
    sha256: (p) =>
      new Promise<string>((resolve, reject) => {
        const hash = nodeRequire<typeof import('crypto')>('crypto').createHash('sha256');
        const s = fs().createReadStream(p);
        s.on('error', reject);
        s.on('data', (c) => hash.update(c));
        s.on('end', () => resolve(hash.digest('hex')));
      }),
    freeBytes: async (p) => {
      const st = await fs().promises.statfs(p);
      return Number(st.bavail) * Number(st.bsize);
    },
    createExclusive: async (p, content) => {
      try {
        const h = await fs().promises.open(p, 'wx');
        await h.writeFile(content);
        await h.close();
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
      }
    },
  };
}

export function createDefaultRuntimeDeps(): RuntimeDeps {
  return {
    platform: () => nodeRequire<typeof import('os')>('os').platform(),
    arch: () => nodeRequire<typeof import('os')>('os').arch(),
    osRelease: () => nodeRequire<typeof import('os')>('os').release(),
    homedir: () => nodeRequire<typeof import('os')>('os').homedir(),
    env: () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
    exec: createNodeExec(),
    download: createNodeDownload(),
    fs: createNodeFs(),
    now: () => Date.now(),
    tmpSuffix: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

// ── Paths & platform ─────────────────────────────────────────────────────────

/** `<home>/Library/Application Support/claude-threads/runtime` — deliberately outside the vault. */
export function managedRuntimeRoot(deps: RuntimeDeps = createDefaultRuntimeDeps()): string {
  return `${deps.homedir()}/Library/Application Support/claude-threads/runtime`;
}

export function managedRuntimeDir(pin: RuntimePin = DEFAULT_RUNTIME_PIN, deps: RuntimeDeps = createDefaultRuntimeDeps()): string {
  return `${managedRuntimeRoot(deps)}/${pin.version}`;
}

export function managedRuntimeBinary(pin: RuntimePin = DEFAULT_RUNTIME_PIN, deps: RuntimeDeps = createDefaultRuntimeDeps()): string {
  return `${managedRuntimeDir(pin, deps)}/bin/container`;
}

/**
 * The managed runtime's `bin` directory IF it is installed, else null. Never
 * throws: `runnerEnv()` calls this on every spawn, on every platform.
 */
export function managedRuntimeBinDirIfPresent(deps?: RuntimeDeps): string | null {
  try {
    const d = deps ?? createDefaultRuntimeDeps();
    const bin = managedRuntimeBinary(DEFAULT_RUNTIME_PIN, d);
    return d.fs.exists(bin) ? `${managedRuntimeDir(DEFAULT_RUNTIME_PIN, d)}/bin` : null;
  } catch {
    return null;
  }
}

export interface SupportCheck { supported: boolean; reason?: string }

export function isRuntimeSupported(deps: RuntimeDeps = createDefaultRuntimeDeps()): SupportCheck {
  let platform: string; let arch: string; let release: string;
  try {
    platform = deps.platform(); arch = deps.arch(); release = deps.osRelease();
  } catch {
    return { supported: false, reason: 'Sandboxed VMs are desktop-only and are not available on mobile.' };
  }
  if (platform !== 'darwin') {
    return { supported: false, reason: `Sandboxed VMs require macOS (this is ${platform}).` };
  }
  if (arch !== 'arm64') {
    return { supported: false, reason: `Sandboxed VMs require Apple silicon (this Mac is ${arch}).` };
  }
  const major = parseInt(release.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major < MIN_DARWIN_MAJOR) {
    return { supported: false, reason: `Sandboxed VMs require macOS 26 or later (Darwin ${release} is older).` };
  }
  return { supported: true };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** `container CLI version 1.5.0 (build: ...)` → `1.5.0`. */
export function parseContainerVersion(output: string): string | undefined {
  return /version\s+v?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)/i.exec(output)?.[1];
}

export interface ParsedStatus {
  running: boolean;
  appRoot?: string;
  installRoot?: string;
}

/**
 * Parses `container system status`. Key names differ across releases
 * (`appRoot` in 1.3.x, `paths.appRoot` in 1.5.x) and column spacing is not
 * stable, so lines are split on the first whitespace run and keys matched by
 * their final dotted segment.
 */
export function parseSystemStatus(output: string): ParsedStatus {
  const kv = new Map<string, string>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const m = /^([A-Za-z][\w.-]*)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.split('.').pop()!.toLowerCase();
    if (!kv.has(key)) kv.set(key, m[2]!.trim());
  }
  return {
    running: kv.get('status')?.toLowerCase() === 'running',
    appRoot: kv.get('approot'),
    installRoot: kv.get('installroot'),
  };
}

// ── Detection ────────────────────────────────────────────────────────────────

function searchDirs(deps: RuntimeDeps): string[] {
  const pathDirs = (deps.env().PATH ?? '').split(':').filter(Boolean);
  const seen = new Set<string>();
  return [...pathDirs, ...(deps.systemDirs ?? ['/opt/homebrew/bin', '/usr/local/bin'])].filter((d) => !seen.has(d) && !!seen.add(d));
}

async function probeVersion(binary: string, deps: RuntimeDeps): Promise<string | null> {
  try {
    const r = await deps.exec(binary, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, env: deps.env() });
    if (r.exitCode !== 0) return null;
    return parseContainerVersion(r.stdout + r.stderr) ?? '';
  } catch {
    return null;
  }
}

/**
 * Finds a working `container`: PATH, Homebrew and /usr/local first (source
 * `system`), the managed copy last. The first candidate that actually executes
 * `--version` wins, so a system install always beats the managed one.
 */
export async function detectRuntime(
  deps: RuntimeDeps = createDefaultRuntimeDeps(),
  pin: RuntimePin = DEFAULT_RUNTIME_PIN,
): Promise<DetectedRuntime | null> {
  const candidates: Array<{ source: RuntimeSource; binary: string }> = [
    ...searchDirs(deps).map((d) => ({ source: 'system' as const, binary: `${d}/container` })),
    { source: 'managed', binary: managedRuntimeBinary(pin, deps) },
  ];
  for (const c of candidates) {
    if (!deps.fs.exists(c.binary)) continue;
    const version = await probeVersion(c.binary, deps);
    if (version === null) continue;
    return { source: c.source, binary: c.binary, ...(version ? { version } : {}) };
  }
  return null;
}

// ── Install ──────────────────────────────────────────────────────────────────

export interface InstallOptions {
  onProgress?: RuntimeProgressFn;
  signal?: AbortSignal;
  pin?: RuntimePin;
  deps?: RuntimeDeps;
}

export interface InstallResult {
  binary: string;
  version: string;
  alreadyInstalled: boolean;
}

const inflightInstalls = new Map<string, Promise<InstallResult>>();

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RuntimeAbortError();
}

async function installedVersionMatches(binary: string, pin: RuntimePin, deps: RuntimeDeps): Promise<boolean> {
  if (!deps.fs.exists(binary)) return false;
  return (await probeVersion(binary, deps)) === pin.version;
}

/**
 * Installs the pinned managed runtime. Idempotent, and concurrent calls in this
 * process share one install; a lock file guards against other processes.
 * Unverified bytes are never installed, and a failure leaves nothing behind.
 */
export function installManagedRuntime(opts: InstallOptions = {}): Promise<InstallResult> {
  const deps = opts.deps ?? createDefaultRuntimeDeps();
  const pin = opts.pin ?? DEFAULT_RUNTIME_PIN;
  const key = `${managedRuntimeRoot(deps)}/${pin.version}`;
  const existing = inflightInstalls.get(key);
  if (existing) return existing;
  const p = runInstall(deps, pin, opts).finally(() => { inflightInstalls.delete(key); });
  inflightInstalls.set(key, p);
  return p;
}

async function runInstall(deps: RuntimeDeps, pin: RuntimePin, opts: InstallOptions): Promise<InstallResult> {
  const { signal } = opts;
  const progress: RuntimeProgressFn = (p) => { try { opts.onProgress?.(p); } catch { /* UI callback must not break install */ } };
  const fs = deps.fs;

  progress({ phase: 'checking', message: 'Checking this Mac' });
  const support = isRuntimeSupported(deps);
  if (!support.supported) throw new RuntimeInstallError(support.reason ?? 'Unsupported platform');

  const root = managedRuntimeRoot(deps);
  const finalDir = `${root}/${pin.version}`;
  const finalBinary = `${finalDir}/bin/container`;

  if (await installedVersionMatches(finalBinary, pin, deps)) {
    progress({ phase: 'done', message: 'Already installed' });
    return { binary: finalBinary, version: pin.version, alreadyInstalled: true };
  }

  await fs.mkdirp(root);
  const free = await fs.freeBytes(root);
  if (free < RUNTIME_MIN_FREE_BYTES) {
    throw new RuntimeInstallError(
      `Not enough free disk space: need about ${(RUNTIME_MIN_FREE_BYTES / 1e9).toFixed(1)} GB, `
      + `have ${(free / 1e9).toFixed(1)} GB.`,
    );
  }

  const lockPath = `${root}/.install.lock`;
  if (!(await fs.createExclusive(lockPath, String(deps.now())))) {
    const age = deps.now() - (await fs.mtimeMs(lockPath).catch(() => deps.now()));
    if (age > INSTALL_LOCK_STALE_MS) {
      await fs.rm(lockPath);
      if (!(await fs.createExclusive(lockPath, String(deps.now())))) {
        throw new RuntimeInstallError('Another install is already in progress.');
      }
    } else {
      throw new RuntimeInstallError('Another install is already in progress.');
    }
  }

  const partial = `${root}/.download-${pin.version}.partial`;
  const workDir = `${root}/.expand-${pin.version}-${deps.tmpSuffix()}`;
  try {
    throwIfAborted(signal);
    await fs.rm(partial);
    progress({ phase: 'downloading', message: 'Downloading the container runtime', bytes: 0, total: pin.bytes, percent: 0 });
    let lastPercent = -1;
    await deps.download({
      url: pin.url,
      dest: partial,
      signal,
      maxRedirects: MAX_DOWNLOAD_REDIRECTS,
      onBytes: (bytes, total) => {
        const t = total ?? pin.bytes;
        const percent = Math.min(100, Math.floor((bytes / t) * 100));
        if (percent === lastPercent) return;
        lastPercent = percent;
        progress({ phase: 'downloading', bytes, total: t, percent });
      },
    });
    throwIfAborted(signal);

    progress({ phase: 'verifying', message: 'Verifying download' });
    const size = await fs.fileSize(partial);
    if (size !== pin.bytes) {
      await fs.rm(partial);
      throw new RuntimeInstallError(`Downloaded runtime has the wrong size (${size} bytes, expected ${pin.bytes}). Nothing was installed.`);
    }
    const digest = await fs.sha256(partial);
    if (digest !== pin.sha256) {
      await fs.rm(partial);
      throw new RuntimeInstallError('Downloaded runtime failed its SHA-256 check. Nothing was installed.');
    }
    throwIfAborted(signal);

    progress({ phase: 'unpacking', message: 'Unpacking' });
    await fs.mkdirp(workDir);
    const expanded = `${workDir}/expanded`; // pkgutil requires that this NOT exist yet
    const r = await deps.exec('/usr/sbin/pkgutil', ['--expand-full', partial, expanded], {
      timeoutMs: INSTALL_TIMEOUT_MS, signal,
    });
    if (r.exitCode !== 0) {
      throw new RuntimeInstallError(`pkgutil could not unpack the runtime: ${(r.stderr || r.stdout).trim() || `exit ${r.exitCode}`}`);
    }
    const payload = `${expanded}/Payload`;
    if (!fs.exists(`${payload}/bin/container`)) {
      throw new RuntimeInstallError('The runtime package did not contain bin/container.');
    }
    throwIfAborted(signal);

    progress({ phase: 'finalizing', message: 'Finishing up' });
    const binDir = `${payload}/bin`;
    for (const name of await fs.readdir(binDir)) await fs.chmod(`${binDir}/${name}`, 0o755);
    // Best effort: files written by pkgutil were observed to carry no quarantine flag, but clear it anyway.
    await deps.exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', payload], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);

    // Replace any stale/broken previous folder, then atomically move into place (same volume).
    await fs.rm(finalDir);
    await fs.rename(payload, finalDir);

    const got = await probeVersion(finalBinary, deps);
    if (got !== pin.version) {
      await fs.rm(finalDir);
      throw new RuntimeInstallError(
        `Installed runtime reports version ${got ?? 'unknown'}, expected ${pin.version}. It was removed.`,
      );
    }
    progress({ phase: 'done', message: 'Installed' });
    return { binary: finalBinary, version: pin.version, alreadyInstalled: false };
  } finally {
    await fs.rm(partial).catch(() => undefined);
    await fs.rm(workDir).catch(() => undefined);
    await fs.rm(lockPath).catch(() => undefined);
  }
}

// ── Start & status ───────────────────────────────────────────────────────────

export async function readSystemStatus(binary: string, deps: RuntimeDeps = createDefaultRuntimeDeps()): Promise<ParsedStatus> {
  try {
    const r = await deps.exec(binary, ['system', 'status'], { timeoutMs: PROBE_TIMEOUT_MS, env: deps.env() });
    if (r.exitCode !== 0) return { running: false };
    return parseSystemStatus(r.stdout + '\n' + r.stderr);
  } catch {
    return { running: false };
  }
}

export interface StartOptions {
  binary: string;
  onProgress?: RuntimeProgressFn;
  deps?: RuntimeDeps;
}

export interface StartResult { started: boolean; alreadyRunning: boolean }

/** Starts the runtime service unless one (any install) is already running. */
export async function startRuntime(opts: StartOptions): Promise<StartResult> {
  const deps = opts.deps ?? createDefaultRuntimeDeps();
  const progress: RuntimeProgressFn = (p) => { try { opts.onProgress?.(p); } catch { /* ignore */ } };
  progress({ phase: 'checking', message: 'Checking whether the runtime is running' });
  if ((await readSystemStatus(opts.binary, deps)).running) {
    progress({ phase: 'done', message: 'Already running' });
    return { started: false, alreadyRunning: true };
  }
  progress({ phase: 'starting', message: 'Starting the container runtime (first start downloads a Linux kernel)' });
  const r = await deps.exec(
    opts.binary,
    ['system', 'start', '--enable-kernel-install', '--timeout', String(RUNTIME_START_TIMEOUT_SECONDS)],
    { timeoutMs: (RUNTIME_START_TIMEOUT_SECONDS + 30) * 1000, env: deps.env() },
  );
  if (r.exitCode !== 0) {
    throw new RuntimeInstallError(`container system start failed: ${(r.stderr || r.stdout).trim() || `exit ${r.exitCode}`}`);
  }
  if (!(await readSystemStatus(opts.binary, deps)).running) {
    throw new RuntimeInstallError(
      `container system start returned but the runtime is not running. ${(r.stderr || r.stdout).trim()}`.trim(),
    );
  }
  progress({ phase: 'done', message: 'Running' });
  return { started: true, alreadyRunning: false };
}

export interface RuntimeStatus {
  supported: boolean;
  reason?: string;
  detected?: DetectedRuntime;
  running: boolean;
}

export async function getRuntimeStatus(
  deps: RuntimeDeps = createDefaultRuntimeDeps(),
  pin: RuntimePin = DEFAULT_RUNTIME_PIN,
): Promise<RuntimeStatus> {
  const support = isRuntimeSupported(deps);
  if (!support.supported) return { supported: false, reason: support.reason, running: false };
  const detected = await detectRuntime(deps, pin);
  if (!detected) return { supported: true, running: false };
  const { running } = await readSystemStatus(detected.binary, deps);
  return { supported: true, detected, running };
}
