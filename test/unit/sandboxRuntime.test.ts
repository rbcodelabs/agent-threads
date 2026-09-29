/**
 * Tests for sandboxRuntime — detect/install/start of Apple's `container` runtime.
 *
 * No test touches the real network beyond a loopback http server, and none run
 * a real runtime: exec, download and platform facts are injected. The install
 * flow runs against a real scratch directory so rename/rm semantics are real.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import {
  RUNTIME_MIN_FREE_BYTES,
  createDefaultRuntimeDeps,
  createNodeDownload,
  detectRuntime,
  getRuntimeStatus,
  installManagedRuntime,
  isRuntimeSupported,
  managedRuntimeBinDirIfPresent,
  managedRuntimeBinary,
  managedRuntimeRoot,
  parseContainerVersion,
  parseSystemStatus,
  startRuntime,
  type ExecFn,
  type ExecResult,
  type RuntimeDeps,
  type RuntimePin,
} from '../../src/sandboxRuntime';
import { runnerEnv } from '../../src/sandboxVm';

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): ExecResult => ({ exitCode: 1, stdout: '', stderr });

let scratch: string;
beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrt-')); });
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

const PAYLOAD = Buffer.from('fake-pkg-bytes');
const PIN: RuntimePin = {
  version: '9.9.9',
  url: 'https://example.invalid/x.pkg',
  sha256: crypto.createHash('sha256').update(PAYLOAD).digest('hex'),
  bytes: PAYLOAD.length,
};

interface Calls { exec: Array<[string, string[]]>; downloads: number }

/** Deps whose fs is real (rooted at scratch/home) and whose exec/download are scripted. */
function makeDeps(over: Partial<RuntimeDeps> & { pkgutil?: 'ok' | 'fail'; free?: number; calls?: Calls } = {}): RuntimeDeps {
  const real = createDefaultRuntimeDeps();
  const calls = over.calls ?? { exec: [], downloads: 0 };
  const home = path.join(scratch, 'home');
  const exec: ExecFn = async (file, args) => {
    calls.exec.push([file, args]);
    if (file === '/usr/sbin/pkgutil') {
      if (over.pkgutil === 'fail') return fail('pkgutil: bad');
      const dest = args[2]!;
      fs.mkdirSync(path.join(dest, 'Payload', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'Payload', 'bin', 'container'), '#!/bin/sh\n');
      return ok();
    }
    if (file === '/usr/bin/xattr') return ok();
    if (file.endsWith('/bin/container') && args[0] === '--version') {
      return ok(`container CLI version ${PIN.version} (build: release, commit: abc)\n`);
    }
    return fail('unexpected');
  };
  return {
    platform: () => 'darwin',
    arch: () => 'arm64',
    osRelease: () => '25.4.0',
    homedir: () => home,
    env: () => ({ PATH: '/nope' }),
    exec,
    download: async (o) => { calls.downloads++; fs.writeFileSync(o.dest, PAYLOAD); return { bytes: PAYLOAD.length }; },
    fs: { ...real.fs, freeBytes: async () => over.free ?? RUNTIME_MIN_FREE_BYTES * 2 },
    now: () => Date.now(),
    tmpSuffix: () => 'tmp',
    systemDirs: [],
    ...over,
  } as RuntimeDeps;
}

function leftovers(deps: RuntimeDeps): string[] {
  const root = managedRuntimeRoot(deps);
  return fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n !== PIN.version) : [];
}

describe('isRuntimeSupported', () => {
  it('accepts darwin arm64 Darwin 25', () => {
    expect(isRuntimeSupported(makeDeps())).toEqual({ supported: true });
  });
  it('rejects non-darwin', () => {
    const r = isRuntimeSupported(makeDeps({ platform: () => 'linux' }));
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/macOS/);
  });
  it('rejects intel', () => {
    const r = isRuntimeSupported(makeDeps({ arch: () => 'x64' }));
    expect(r.reason).toMatch(/Apple silicon/);
  });
  it('rejects macOS older than 26 (Darwin < 25)', () => {
    const r = isRuntimeSupported(makeDeps({ osRelease: () => '24.6.0' }));
    expect(r.reason).toMatch(/macOS 26/);
  });
  it('reports desktop-only when platform info is unavailable (mobile)', () => {
    const r = isRuntimeSupported(makeDeps({ platform: () => { throw new Error('no os'); } }));
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/desktop-only/);
  });
});

describe('parsing', () => {
  it('parses the version banner', () => {
    expect(parseContainerVersion('container CLI version 1.5.0 (build: release, commit: d265d66)')).toBe('1.5.0');
    expect(parseContainerVersion('garbage')).toBeUndefined();
  });
  it('parses 1.3.x status keys (appRoot)', () => {
    const s = parseSystemStatus('status        running\nappRoot       /Users/x/Library/Application Support/com.apple.container/\ninstallRoot   /opt/homebrew/Cellar/container/1.3.1/\n');
    expect(s).toEqual({
      running: true,
      appRoot: '/Users/x/Library/Application Support/com.apple.container/',
      installRoot: '/opt/homebrew/Cellar/container/1.3.1/',
    });
  });
  it('parses 1.5.x status keys (paths.appRoot)', () => {
    const s = parseSystemStatus('status              running\npaths.appRoot       /a/b\npaths.installRoot   /c/d\n');
    expect(s).toEqual({ running: true, appRoot: '/a/b', installRoot: '/c/d' });
  });
  it('does not treat "not running" as running', () => {
    expect(parseSystemStatus('status  stopped\n').running).toBe(false);
    expect(parseSystemStatus('apiserver is not running\n').running).toBe(false);
  });
});

describe('detectRuntime', () => {
  it('prefers a system binary over the managed one', async () => {
    const deps = makeDeps({ env: () => ({ PATH: path.join(scratch, 'sysbin') }) });
    const sys = path.join(scratch, 'sysbin', 'container');
    fs.mkdirSync(path.dirname(sys), { recursive: true });
    fs.writeFileSync(sys, '');
    const managed = managedRuntimeBinary(PIN, deps);
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, '');
    const exec: ExecFn = async (file) => ok(`container CLI version ${file === sys ? '1.3.1' : '9.9.9'}`);
    const d = await detectRuntime({ ...deps, exec }, PIN);
    expect(d).toEqual({ source: 'system', binary: sys, version: '1.3.1' });
  });
  it('falls back to managed, and skips a binary that will not execute', async () => {
    const deps = makeDeps({ env: () => ({ PATH: path.join(scratch, 'sysbin') }) });
    const sys = path.join(scratch, 'sysbin', 'container');
    fs.mkdirSync(path.dirname(sys), { recursive: true });
    fs.writeFileSync(sys, '');
    const managed = managedRuntimeBinary(PIN, deps);
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, '');
    const exec: ExecFn = async (file) => {
      if (file === sys) throw Object.assign(new Error('nope'), { code: 'EACCES' });
      return ok('container CLI version 9.9.9');
    };
    const d = await detectRuntime({ ...deps, exec }, PIN);
    expect(d?.source).toBe('managed');
    expect(d?.binary).toBe(managed);
  });
  it('returns null when nothing is found', async () => {
    expect(await detectRuntime(makeDeps({ env: () => ({ PATH: '/definitely/not' }) }), PIN)).toBeNull();
  });
});

describe('installManagedRuntime', () => {
  it('installs: verifies, unpacks, moves into the versioned folder and cleans up', async () => {
    const calls: Calls = { exec: [], downloads: 0 };
    const deps = makeDeps({ calls });
    const phases: string[] = [];
    const res = await installManagedRuntime({ deps, pin: PIN, onProgress: (p) => phases.push(p.phase) });
    expect(res.alreadyInstalled).toBe(false);
    expect(res.binary).toBe(managedRuntimeBinary(PIN, deps));
    expect(fs.statSync(res.binary).mode & 0o111).not.toBe(0);
    expect(leftovers(deps)).toEqual([]);
    expect(phases).toEqual(expect.arrayContaining(['checking', 'downloading', 'verifying', 'unpacking', 'finalizing', 'done']));
    expect(calls.exec.find(([f]) => f === '/usr/sbin/pkgutil')?.[1].slice(0, 1)).toEqual(['--expand-full']);
  });

  it('checksum mismatch deletes the file, throws, and installs nothing', async () => {
    const deps = makeDeps({
      download: async (o) => { fs.writeFileSync(o.dest, Buffer.from('tampered-bytes')); return { bytes: 14 }; },
    });
    await expect(installManagedRuntime({ deps, pin: { ...PIN, bytes: 14 } })).rejects.toThrow(/SHA-256/);
    expect(fs.existsSync(managedRuntimeBinary(PIN, deps))).toBe(false);
    expect(leftovers(deps)).toEqual([]);
  });

  it('size mismatch also throws and cleans up', async () => {
    const deps = makeDeps({
      download: async (o) => { fs.writeFileSync(o.dest, Buffer.from('short')); return { bytes: 5 }; },
    });
    await expect(installManagedRuntime({ deps, pin: PIN })).rejects.toThrow(/wrong size/);
    expect(leftovers(deps)).toEqual([]);
  });

  it('refuses when disk space is short, before downloading', async () => {
    const calls: Calls = { exec: [], downloads: 0 };
    const deps = makeDeps({ calls, free: 1_000 });
    await expect(installManagedRuntime({ deps, pin: PIN })).rejects.toThrow(/free disk space/);
    expect(calls.downloads).toBe(0);
  });

  it('refuses on unsupported platforms', async () => {
    const deps = makeDeps({ arch: () => 'x64' });
    await expect(installManagedRuntime({ deps, pin: PIN })).rejects.toThrow(/Apple silicon/);
  });

  it('is a no-op when already installed', async () => {
    const calls: Calls = { exec: [], downloads: 0 };
    const deps = makeDeps({ calls });
    await installManagedRuntime({ deps, pin: PIN });
    calls.downloads = 0;
    const again = await installManagedRuntime({ deps, pin: PIN });
    expect(again.alreadyInstalled).toBe(true);
    expect(calls.downloads).toBe(0);
  });

  it('collapses concurrent installs into one download', async () => {
    const calls: Calls = { exec: [], downloads: 0 };
    const deps = makeDeps({ calls });
    const [a, b] = await Promise.all([
      installManagedRuntime({ deps, pin: PIN }),
      installManagedRuntime({ deps, pin: PIN }),
    ]);
    expect(calls.downloads).toBe(1);
    expect(a.binary).toBe(b.binary);
  });

  it('rejects when another process holds a fresh lock, and removes a stale one', async () => {
    const deps = makeDeps();
    const root = managedRuntimeRoot(deps);
    fs.mkdirSync(root, { recursive: true });
    const lock = path.join(root, '.install.lock');
    fs.writeFileSync(lock, 'x');
    await expect(installManagedRuntime({ deps, pin: PIN })).rejects.toThrow(/already in progress/);
    expect(fs.existsSync(lock)).toBe(true); // not ours to delete
    const old = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(lock, old, old);
    await expect(installManagedRuntime({ deps, pin: PIN })).resolves.toMatchObject({ alreadyInstalled: false });
  });

  it('cleans up when pkgutil fails', async () => {
    const deps = makeDeps({ pkgutil: 'fail' });
    await expect(installManagedRuntime({ deps, pin: PIN })).rejects.toThrow(/pkgutil/);
    expect(fs.existsSync(managedRuntimeBinary(PIN, deps))).toBe(false);
    expect(leftovers(deps)).toEqual([]);
  });

  it('removes the install if the unpacked binary reports the wrong version', async () => {
    const base = makeDeps();
    const deps = makeDeps({
      exec: async (f, a, o) => (f.endsWith('/bin/container') ? ok('container CLI version 0.0.1') : base.exec(f, a, o)),
    });
    await expect(installManagedRuntime({ deps, pin: PIN })).rejects.toThrow(/expected 9\.9\.9/);
    expect(fs.existsSync(path.dirname(path.dirname(managedRuntimeBinary(PIN, deps))))).toBe(false);
  });

  it('abort mid-download cleans up the partial file', async () => {
    const ac = new AbortController();
    const deps = makeDeps({
      download: async (o) => {
        fs.writeFileSync(o.dest, 'half');
        ac.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    await expect(installManagedRuntime({ deps, pin: PIN, signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(leftovers(deps)).toEqual([]);
  });
});

describe('createNodeDownload (loopback http)', () => {
  let server: http.Server;
  let base: string;
  const body = Buffer.alloc(200_000, 7);
  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/r1') { res.writeHead(302, { location: '/r2' }); res.end(); return; }
      if (req.url === '/r2') { res.writeHead(302, { location: '/file' }); res.end(); return; }
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
      if (req.url === '/file') { res.writeHead(200, { 'content-length': String(body.length) }); res.end(body); return; }
      if (req.url === '/slow') {
        res.writeHead(200, { 'content-length': '1000000' });
        res.write(Buffer.alloc(1000));
        return; // never finishes
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('follows redirects and reports bytes', async () => {
    const dest = path.join(scratch, 'f');
    let last = 0;
    const r = await createNodeDownload()({ url: `${base}/r1`, dest, allowInsecure: true, onBytes: (b) => { last = b; } });
    expect(r.bytes).toBe(body.length);
    expect(last).toBe(body.length);
    expect(fs.readFileSync(dest).equals(body)).toBe(true);
  });
  it('gives up after too many redirects', async () => {
    await expect(createNodeDownload()({ url: `${base}/loop`, dest: path.join(scratch, 'f'), allowInsecure: true, maxRedirects: 5 }))
      .rejects.toThrow(/Too many redirects/);
  });
  it('errors on non-200', async () => {
    await expect(createNodeDownload()({ url: `${base}/nope`, dest: path.join(scratch, 'f'), allowInsecure: true }))
      .rejects.toThrow(/HTTP 404/);
  });
  it('refuses http unless explicitly allowed', async () => {
    await expect(createNodeDownload()({ url: `${base}/file`, dest: path.join(scratch, 'f') }))
      .rejects.toThrow(/non-https/);
  });
  it('aborts mid-download', async () => {
    const ac = new AbortController();
    const p = createNodeDownload()({
      url: `${base}/slow`, dest: path.join(scratch, 'f'), allowInsecure: true, signal: ac.signal,
      onBytes: () => ac.abort(),
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('startRuntime', () => {
  const running = 'status  running\nappRoot /a\n';
  it('is a no-op when already running', async () => {
    const seen: string[][] = [];
    const deps = makeDeps({ exec: async (_f, a) => { seen.push(a); return ok(running); } });
    const r = await startRuntime({ binary: '/x/container', deps });
    expect(r).toEqual({ started: false, alreadyRunning: true });
    expect(seen.some((a) => a[1] === 'start')).toBe(false);
  });
  it('starts with kernel install and re-checks status', async () => {
    const seen: string[][] = [];
    let up = false;
    const deps = makeDeps({
      exec: async (_f, a) => {
        seen.push(a);
        if (a[1] === 'start') { up = true; return ok(); }
        return up ? ok(running) : ok('status  stopped\n');
      },
    });
    const r = await startRuntime({ binary: '/x/container', deps });
    expect(r.started).toBe(true);
    expect(seen.find((a) => a[1] === 'start')).toEqual(['system', 'start', '--enable-kernel-install', '--timeout', '180']);
  });
  it('surfaces stderr when start fails', async () => {
    const deps = makeDeps({ exec: async (_f, a) => (a[1] === 'start' ? fail('kernel download failed') : ok('status  stopped')) });
    await expect(startRuntime({ binary: '/x/container', deps })).rejects.toThrow(/kernel download failed/);
  });
  it('errors when start returns 0 but the service is not up', async () => {
    const deps = makeDeps({ exec: async () => ok('status  stopped') });
    await expect(startRuntime({ binary: '/x/container', deps })).rejects.toThrow(/not running/);
  });
});

describe('getRuntimeStatus', () => {
  it('reports unsupported with a reason', async () => {
    const s = await getRuntimeStatus(makeDeps({ platform: () => 'win32' }), PIN);
    expect(s.supported).toBe(false);
    expect(s.reason).toBeTruthy();
    expect(s.running).toBe(false);
  });
  it('reports detected + running', async () => {
    const deps = makeDeps({ env: () => ({ PATH: path.join(scratch, 'b') }) });
    const bin = path.join(scratch, 'b', 'container');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '');
    const exec: ExecFn = async (_f, a) => (a[0] === '--version' ? ok('container CLI version 1.3.1') : ok('status running'));
    const s = await getRuntimeStatus({ ...deps, exec }, PIN);
    expect(s).toMatchObject({ supported: true, running: true, detected: { source: 'system', version: '1.3.1' } });
  });
  it('supported but nothing installed', async () => {
    expect(await getRuntimeStatus(makeDeps(), PIN)).toEqual({ supported: true, running: false });
  });
});

describe('managed bin dir + runnerEnv', () => {
  it('managedRuntimeBinDirIfPresent is null until installed', async () => {
    const deps = makeDeps();
    // Default pin version differs from PIN, so create the real-pin layout.
    expect(managedRuntimeBinDirIfPresent(deps)).toBeNull();
    const bin = managedRuntimeBinary(undefined, deps);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '');
    expect(managedRuntimeBinDirIfPresent(deps)).toBe(path.dirname(bin));
  });
  it('lives outside any vault, under Application Support', () => {
    expect(managedRuntimeRoot(makeDeps())).toMatch(/Library\/Application Support\/claude-threads\/runtime$/);
  });
  it('runnerEnv appends the managed dir LAST, only when present', () => {
    const withManaged = runnerEnv('/m/bin').PATH!;
    expect(withManaged.startsWith('/opt/homebrew/bin:/usr/local/bin:')).toBe(true);
    expect(withManaged.endsWith(':/m/bin')).toBe(true);
    const without = runnerEnv(null).PATH!;
    expect(without).not.toContain('/m/bin');
    expect(without.endsWith(':')).toBe(process.env.PATH ? false : true);
  });
});
