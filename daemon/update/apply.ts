/**
 * Stage, verify and swap in a new bundle. Nothing here touches the running bundle until every check has passed,
 * and the swap is a single rename in the bundle's own directory, so a crash at any point leaves either the old
 * file or the new one, never a torn one.
 *
 * Order: download bundle + checksum -> SHA-256 -> write a temp file beside the bundle (same mode) -> run it with
 * `--version --json` (the only time a downloaded file executes, and only after the checksum matched) -> keep the
 * old bundle as `agent-threads.cjs.prev-<version>` (last two retained) -> write the rollback marker -> rename.
 *
 * Honest limit: the checksum is published in the same release as the bundle, so it detects a damaged or truncated
 * download, not a compromised release or account (same caveat as deploy/install.sh).
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PROTOCOL_VERSION } from '../../src/protocol';
import { getChecked, UpdateError, UpdateHeld, type FetchLike, type LatestRelease } from './release';
import { compareVersions, isMajorBump, parseStableVersion } from './semver';
import { patchState } from './state';

export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
export const PREV_RETAINED = 2;
const SANITY_TIMEOUT_MS = 20_000;

export interface ApplyOptions {
  release: LatestRelease;
  currentVersion: string;
  bundlePath: string;
  dataDir: string;
  /** The node binary used for the sanity check (the one running us). */
  nodePath: string;
  fetch: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  /** Test seam: replaces the real `node <file> --version --json` run. Resolves to its stdout. */
  runVersion?: (file: string) => Promise<string>;
  log?: (line: string) => void;
}

export interface Applied { from: string; to: string; prevPath: string; bundlePath: string }

/** The first hex token of a `sha256sum` line (`<64 hex>  agent-threads.cjs`). */
export function parseChecksumFile(text: string, expectedName: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const m = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(line);
  if (!m) throw new UpdateError('checksum', 'the checksum file is not in sha256sum format');
  if (m[2] && basename(m[2]) !== expectedName) throw new UpdateError('checksum', `the checksum file is for ${m[2]}, not ${expectedName}`);
  return m[1].toLowerCase();
}

export const sha256Of = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function runNodeVersion(nodePath: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // No shell, a minimal environment, a timeout, and the file is passed as an argument.
    execFile(nodePath, [file, '--version', '--json'], { timeout: SANITY_TIMEOUT_MS, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

/** What `--version --json` printed. Older bundles print the bare version; both are accepted. */
export function parseVersionOutput(out: string): { version: string; protocol?: number } | null {
  const t = out.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { version?: unknown; protocol?: unknown };
      return typeof j.version === 'string' ? { version: j.version, ...(typeof j.protocol === 'number' ? { protocol: j.protocol } : {}) } : null;
    } catch { return null; }
  }
  return /^\S+$/.test(t) ? { version: t } : null;
}

/** Keep the newest `keep` previous bundles (by version, then mtime); `protect` is never deleted. */
export function pruneOldBundles(bundlePath: string, keep: number, protect: string): string[] {
  const dir = dirname(bundlePath);
  const prefix = `${basename(bundlePath)}.prev-`;
  const found = readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => {
    let mtime = 0;
    try { mtime = statSync(join(dir, f)).mtimeMs; } catch { /* vanished */ }
    return { path: join(dir, f), version: f.slice(prefix.length), mtime };
  });
  found.sort((a, b) => {
    const pa = parseStableVersion(a.version);
    const pb = parseStableVersion(b.version);
    if (pa && pb) return compareVersions(b.version, a.version);
    if (pa) return -1;
    if (pb) return 1;
    return b.mtime - a.mtime;
  });
  const removed: string[] = [];
  for (const f of found.slice(keep)) {
    if (f.path === protect) continue;
    try { rmSync(f.path, { force: true }); removed.push(f.path); } catch { /* best effort */ }
  }
  return removed;
}

function writeFileSyncDurable(path: string, data: Buffer, mode: number): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
}

export async function applyUpdate(o: ApplyOptions): Promise<Applied> {
  const { release, bundlePath } = o;
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => Date.now());
  const timeoutMs = o.timeoutMs ?? 120_000;
  if (compareVersions(release.version, o.currentVersion) <= 0) throw new UpdateError('apply', `${release.version} is not newer than ${o.currentVersion}; never downgrading`);
  if (isMajorBump(release.version, o.currentVersion)) throw new UpdateHeld(release.version, `${release.version} is a new major version; it may change the protocol or configuration, so it is not applied automatically. Upgrade by hand after reading the release notes`);

  const sum = await getChecked(release.checksumUrl, { fetch: o.fetch, timeoutMs, maxBytes: 4096 });
  const expected = parseChecksumFile(sum.body!.toString('utf8'), basename(release.bundleUrl));
  const bundle = await getChecked(release.bundleUrl, { fetch: o.fetch, timeoutMs, maxBytes: MAX_BUNDLE_BYTES });
  const data = bundle.body!;
  if (data.length === 0) throw new UpdateError('download', 'the downloaded bundle is empty');
  if (sha256Of(data) !== expected) throw new UpdateError('checksum', 'checksum mismatch: the download is damaged or incomplete (the checksum comes from the same release, so this catches corruption, not a compromised release)');

  const dir = dirname(bundlePath);
  const mode = (() => { try { return statSync(bundlePath).mode & 0o777; } catch { return 0o644; } })();
  const tmp = join(dir, `.agent-threads-update-${process.pid}-${randomBytes(4).toString('hex')}.cjs`);
  const prevPath = `${bundlePath}.prev-${o.currentVersion}`;
  const prevTmp = `${prevPath}.${randomBytes(4).toString('hex')}.tmp`;
  let swapped = false;
  try {
    writeFileSyncDurable(tmp, data, mode);

    let out: string;
    try { out = await (o.runVersion ? o.runVersion(tmp) : runNodeVersion(o.nodePath, tmp)); } catch (err) {
      throw new UpdateError('sanity', `the new bundle did not run (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
    }
    const reported = parseVersionOutput(out);
    if (!reported || reported.version !== release.version) throw new UpdateError('sanity', `the new bundle reports version "${reported?.version ?? out.trim().slice(0, 40)}", expected ${release.version}`);
    if (reported.protocol !== undefined && reported.protocol !== PROTOCOL_VERSION) {
      throw new UpdateHeld(release.version, `${release.version} speaks wire protocol v${reported.protocol} (this daemon speaks v${PROTOCOL_VERSION}); not applied automatically. Upgrade the daemon and the Geode plugin together by hand`);
    }

    copyFileSync(bundlePath, prevTmp);
    chmodSync(prevTmp, mode);
    renameSync(prevTmp, prevPath);
    pruneOldBundles(bundlePath, PREV_RETAINED, prevPath);

    patchState(o.dataDir, (s) => ({
      ...s,
      pendingUpgrade: { from: o.currentVersion, to: release.version, prevPath, bundlePath, appliedAt: now(), boots: 0 },
      held: undefined,
    }));
    try {
      renameSync(tmp, bundlePath);
      swapped = true;
    } catch (err) {
      patchState(o.dataDir, (s) => ({ ...s, pendingUpgrade: undefined }));
      throw new UpdateError('apply', `could not replace the bundle: ${err instanceof Error ? err.message : String(err)}`);
    }
    log(`installed ${release.version} over ${o.currentVersion}; previous bundle kept at ${prevPath}`);
    return { from: o.currentVersion, to: release.version, prevPath, bundlePath };
  } finally {
    if (!swapped) {
      rmSync(tmp, { force: true });
      rmSync(prevTmp, { force: true });
    }
  }
}
