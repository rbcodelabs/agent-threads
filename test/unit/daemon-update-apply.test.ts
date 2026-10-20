import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUpdate, parseChecksumFile, parseVersionOutput, pruneOldBundles, sha256Of } from '../../daemon/update/apply';
import { UpdateError, UpdateHeld, type FetchLike, type FetchResponse, type LatestRelease } from '../../daemon/update/release';
import { readState, withUpdateLock } from '../../daemon/update/state';

const tag = (v: string) => `v${v}`;
const releaseFor = (v: string): LatestRelease => ({
  version: v, tag: tag(v),
  bundleUrl: `https://github.com/rbcodelabs/agent-threads/releases/download/${tag(v)}/agent-threads.cjs`,
  checksumUrl: `https://github.com/rbcodelabs/agent-threads/releases/download/${tag(v)}/agent-threads.cjs.sha256`,
});
/** A bundle that behaves like `agent-threads --version [--json]`; real node runs it in the sanity check. */
const bundleText = (version: string, protocol = 1, extra = '') =>
  `if (process.argv.includes('--version')) { console.log(process.argv.includes('--json') ? JSON.stringify({ version: ${JSON.stringify(version)}, protocol: ${protocol} }) : ${JSON.stringify(version)}); }\n${extra}\n`;

function res(body: string | Buffer, status = 200): FetchResponse {
  const b = Buffer.from(body);
  return { status, headers: { get: () => null }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer };
}
function serve(v: string, bundle: string, opts: { sum?: string } = {}): FetchLike {
  const rel = releaseFor(v);
  return async (url) => {
    if (url === rel.bundleUrl) return res(bundle);
    if (url === rel.checksumUrl) return res(opts.sum ?? `${sha256Of(Buffer.from(bundle))}  agent-threads.cjs\n`);
    return res('', 404);
  };
}

let dir: string;
let dataDir: string;
let bundle: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'at-update-'));
  dataDir = join(dir, 'data');
  bundle = join(dir, 'agent-threads.cjs');
  writeFileSync(bundle, bundleText('0.68.2'), { mode: 0o644 });
  chmodSync(bundle, 0o644);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const base = (v: string, fetch: FetchLike, more: Partial<Parameters<typeof applyUpdate>[0]> = {}) => ({
  release: releaseFor(v), currentVersion: '0.68.2', bundlePath: bundle, dataDir, nodePath: process.execPath, fetch, ...more,
});
const untouched = () => { expect(readFileSync(bundle, 'utf8')).toBe(bundleText('0.68.2')); };
const leftovers = () => readdirSync(dir).filter((f) => f.startsWith('.agent-threads-update') || f.endsWith('.tmp'));

describe('parsing', () => {
  const hex = 'a'.repeat(64);
  it('reads sha256sum lines', () => {
    expect(parseChecksumFile(`${hex}  agent-threads.cjs\n`, 'agent-threads.cjs')).toBe(hex);
    expect(parseChecksumFile(`${hex.toUpperCase()} *agent-threads.cjs`, 'agent-threads.cjs')).toBe(hex);
    expect(parseChecksumFile(hex, 'agent-threads.cjs')).toBe(hex);
  });
  it('rejects a malformed file or one for another artifact', () => {
    expect(() => parseChecksumFile('nope', 'agent-threads.cjs')).toThrow(/sha256sum format/);
    expect(() => parseChecksumFile(`${hex}  other.cjs`, 'agent-threads.cjs')).toThrow(/not agent-threads.cjs/);
  });
  it('accepts JSON or a bare version from --version', () => {
    expect(parseVersionOutput('{"version":"1.2.3","protocol":1}\n')).toEqual({ version: '1.2.3', protocol: 1 });
    expect(parseVersionOutput('1.2.3\n')).toEqual({ version: '1.2.3' });
    expect(parseVersionOutput('Error: boom\nat x')).toBeNull();
  });
});

describe('applyUpdate', () => {
  it('verifies, runs the sanity check, keeps the previous bundle, swaps atomically and leaves a marker', async () => {
    const next = bundleText('0.68.3');
    const out = await applyUpdate(base('0.68.3', serve('0.68.3', next)));
    expect(out).toMatchObject({ from: '0.68.2', to: '0.68.3', prevPath: `${bundle}.prev-0.68.2` });
    expect(readFileSync(bundle, 'utf8')).toBe(next);
    expect(readFileSync(`${bundle}.prev-0.68.2`, 'utf8')).toBe(bundleText('0.68.2'));
    expect(statSync(bundle).mode & 0o777).toBe(0o644);
    expect(readState(dataDir).pendingUpgrade).toMatchObject({ from: '0.68.2', to: '0.68.3', boots: 0, bundlePath: bundle });
    expect(leftovers()).toEqual([]);
  });
  it('preserves a non-default mode', async () => {
    chmodSync(bundle, 0o755);
    await applyUpdate(base('0.68.3', serve('0.68.3', bundleText('0.68.3'))));
    expect(statSync(bundle).mode & 0o777).toBe(0o755);
  });
  it('a checksum mismatch leaves the running bundle untouched and nothing behind', async () => {
    await expect(applyUpdate(base('0.68.3', serve('0.68.3', bundleText('0.68.3'), { sum: `${'0'.repeat(64)}  agent-threads.cjs` })))).rejects.toMatchObject({ stage: 'checksum' });
    untouched();
    expect(existsSync(`${bundle}.prev-0.68.2`)).toBe(false);
    expect(readState(dataDir).pendingUpgrade).toBeUndefined();
    expect(leftovers()).toEqual([]);
  });
  it('never executes a download whose checksum does not match', async () => {
    const marker = join(dir, 'ran');
    const evil = bundleText('0.68.3', 1, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
    await expect(applyUpdate(base('0.68.3', serve('0.68.3', evil, { sum: `${'1'.repeat(64)}  agent-threads.cjs` })))).rejects.toBeInstanceOf(UpdateError);
    expect(existsSync(marker)).toBe(false);
  });
  it('a bundle that fails to run fails the sanity check', async () => {
    await expect(applyUpdate(base('0.68.3', serve('0.68.3', 'throw new Error("cannot start");')))).rejects.toMatchObject({ stage: 'sanity' });
    untouched();
    expect(leftovers()).toEqual([]);
    expect(existsSync(`${bundle}.prev-0.68.2`)).toBe(false);
  });
  it('a bundle that reports the wrong version fails the sanity check', async () => {
    await expect(applyUpdate(base('0.68.3', serve('0.68.3', bundleText('0.68.4'))))).rejects.toMatchObject({ stage: 'sanity', message: expect.stringContaining('expected 0.68.3') });
    untouched();
  });
  it('holds a release that speaks another wire protocol, without installing it', async () => {
    const err = await applyUpdate(base('0.68.3', serve('0.68.3', bundleText('0.68.3', 2)))).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateHeld);
    expect(err.reason).toMatch(/protocol v2/);
    untouched();
    expect(leftovers()).toEqual([]);
  });
  it('holds a major version without downloading anything', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => { calls++; return res('x'); };
    await expect(applyUpdate(base('1.0.0', fetch))).rejects.toBeInstanceOf(UpdateHeld);
    expect(calls).toBe(0);
  });
  it('never downgrades or reinstalls the same version', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => { calls++; return res('x'); };
    await expect(applyUpdate(base('0.68.1', fetch))).rejects.toThrow(/never downgrading/);
    await expect(applyUpdate(base('0.68.2', fetch))).rejects.toThrow(/never downgrading/);
    expect(calls).toBe(0);
  });
  it('a failed download leaves everything as it was', async () => {
    await expect(applyUpdate(base('0.68.3', async () => res('', 500)))).rejects.toMatchObject({ stage: 'download' });
    untouched();
  });
  it('an empty bundle is refused', async () => {
    await expect(applyUpdate(base('0.68.3', serve('0.68.3', '')))).rejects.toThrow(/empty/);
    untouched();
  });
  it('retains only the last two previous bundles', async () => {
    let current = '0.68.2';
    for (const next of ['0.68.3', '0.68.4', '0.68.5', '0.68.6']) {
      await applyUpdate(base(next, serve(next, bundleText(next)), { currentVersion: current }));
      current = next;
    }
    const prevs = readdirSync(dir).filter((f) => f.includes('.prev-')).sort();
    expect(prevs).toEqual(['agent-threads.cjs.prev-0.68.4', 'agent-threads.cjs.prev-0.68.5']);
  });
  it('orders retention by version, not by file time', () => {
    for (const v of ['0.9.0', '0.10.0', '0.11.0']) writeFileSync(`${bundle}.prev-${v}`, v);
    utimesSync(`${bundle}.prev-0.11.0`, 1, 1); // oldest mtime, newest version
    pruneOldBundles(bundle, 2, `${bundle}.prev-0.11.0`);
    expect(readdirSync(dir).filter((f) => f.includes('.prev-')).sort()).toEqual(['agent-threads.cjs.prev-0.10.0', 'agent-threads.cjs.prev-0.11.0']);
  });
  it('a running process keeps working: the swap is a rename, never an in-place write', async () => {
    const before = statSync(bundle).ino;
    await applyUpdate(base('0.68.3', serve('0.68.3', bundleText('0.68.3'))));
    expect(statSync(bundle).ino).not.toBe(before);
  });
});

describe('update lock', () => {
  it('admits one holder and takes over a stale lock', async () => {
    let inner: string | null | undefined;
    const outer = await withUpdateLock(dataDir, async () => {
      inner = await withUpdateLock(dataDir, async () => 'second');
      return 'first';
    });
    expect(outer).toBe('first');
    expect(inner).toBeNull();
    writeFileSync(join(dataDir, 'update.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await withUpdateLock(dataDir, async () => 'took over')).toBe('took over');
    writeFileSync(join(dataDir, 'update.lock'), JSON.stringify({ pid: process.pid, at: 1 }));
    expect(await withUpdateLock(dataDir, async () => 'old lock')).toBe('old lock');
    expect(existsSync(join(dataDir, 'update.lock'))).toBe(false);
  });
});
