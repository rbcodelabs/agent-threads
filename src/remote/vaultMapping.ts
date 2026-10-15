/**
 * Vault path mapping for remote daemons.
 *
 * A daemon may hold a synced mirror of the vault (for example /home/user/vault
 * on my-server). A vault thread run there should default to the same folder
 * the thread would use on this computer, expressed under the daemon's root.
 *
 * Everything here is LEXICAL and pure: no filesystem access, no symlink
 * resolution (the plugin cannot see the remote disk, and the daemon does the
 * real symlink-aware check against its workspace allowlist). Paths are POSIX.
 * Comparison is case-sensitive and Unicode-normalized (NFC) so a macOS name
 * stored decomposed still matches; a vault on a case-insensitive volume whose
 * folder was typed with different case simply does not map, and the caller
 * falls back to the daemon's default folder.
 */
import type { RemoteDaemonConfig, RemoteVaultMapping } from '../types';

/**
 * Collapse repeated slashes, resolve `.` and `..` lexically, drop a trailing
 * slash, NFC-normalize. Returns undefined for anything that is not an
 * absolute POSIX path (relative, empty, contains NUL/newline) or that climbs
 * above `/`.
 */
export function normalizePosixPath(input: string): string | undefined {
  if (typeof input !== 'string') return undefined;
  const raw = input.trim();
  if (!raw.startsWith('/') || /[\0\n\r]/.test(raw)) return undefined;
  const out: string[] = [];
  for (const seg of raw.normalize('NFC').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** `path` equals `root` or sits below it. Both must already be normalized. */
function isWithin(root: string, path: string): boolean {
  if (root === '/') return true;
  return path === root || path.startsWith(`${root}/`);
}

/** Relative remainder of `path` under `root` ('' when equal), or undefined when outside. */
export function relativeWithin(root: string, path: string): string | undefined {
  const r = normalizePosixPath(root);
  const p = normalizePosixPath(path);
  if (r === undefined || p === undefined || !isWithin(r, p)) return undefined;
  if (r === '/') return p.slice(1);
  return p === r ? '' : p.slice(r.length + 1);
}

/** Join a normalized absolute root and a relative remainder. */
function joinUnder(root: string, relative: string): string {
  if (!relative) return root;
  return root === '/' ? `/${relative}` : `${root}/${relative}`;
}

/**
 * The folder on this computer that `mapping` is anchored to: its explicit
 * `localRoot`, else the vault root.
 */
export function effectiveLocalRoot(mapping: RemoteVaultMapping, vaultRoot: string | undefined): string | undefined {
  const explicit = mapping.localRoot?.trim();
  return normalizePosixPath(explicit || vaultRoot || '');
}

/**
 * Map a local path to the corresponding path under the daemon's root.
 * Undefined when the path is outside the mapped local root, or when either
 * root is unusable (the caller then keeps its non-vault default).
 */
export function mapLocalToRemote(
  mapping: RemoteVaultMapping,
  vaultRoot: string | undefined,
  localPath: string | undefined,
): string | undefined {
  if (!localPath) return undefined;
  const localRoot = effectiveLocalRoot(mapping, vaultRoot);
  const remoteRoot = normalizePosixPath(mapping.remoteRoot);
  if (localRoot === undefined || remoteRoot === undefined) return undefined;
  const rel = relativeWithin(localRoot, localPath);
  if (rel === undefined) return undefined;
  return joinUnder(remoteRoot, rel);
}

/** True when a remote path is the mapped remote root or below it. */
export function isUnderRemoteRoot(mapping: RemoteVaultMapping | undefined, remotePath: string | undefined): boolean {
  if (!mapping || !remotePath) return false;
  const remoteRoot = normalizePosixPath(mapping.remoteRoot);
  if (remoteRoot === undefined) return false;
  const rel = relativeWithin(remoteRoot, remotePath);
  return rel !== undefined;
}

/**
 * The folder to pre-fill for a new remote thread: the mapped vault folder when
 * the thread's local cwd is inside the vault (mapping root) and the daemon has
 * a mapping, otherwise the daemon's own default folder (possibly none).
 */
export function suggestRemoteCwd(
  daemon: Pick<RemoteDaemonConfig, 'defaultCwdRoot' | 'vaultMapping'>,
  localCwd: string | undefined,
  vaultRoot: string | undefined,
): { cwd: string; fromVault: boolean } {
  const mapped = daemon.vaultMapping ? mapLocalToRemote(daemon.vaultMapping, vaultRoot, localCwd) : undefined;
  if (mapped !== undefined) return { cwd: mapped, fromVault: true };
  return { cwd: daemon.defaultCwdRoot ?? '', fromVault: false };
}
