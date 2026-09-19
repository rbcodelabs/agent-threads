/**
 * Host-owned artifact storage roots (ADR-0010).
 *
 * `data` on an artifact is opaque to the host. `storageRoot` deliberately is
 * not, because the host has to be able to delete an artifact's directory when
 * the owning thread goes away — deletion needs an owner, and the peer cannot
 * be it.
 *
 * That makes `storageRoot` the one peer-supplied value the host later hands to
 * a *recursive delete*, so it is the sharp edge of this contribution type. A
 * buggy or malicious peer must never be able to steer that delete at an
 * arbitrary directory. Every root is therefore resolved (through `..` and,
 * where the host can, through symlinks) and checked to lie strictly inside
 * `<vault>/.geode/artifacts/` — once before it is ever persisted, and again
 * immediately before anything is removed. Both checks matter: the first stops
 * a bad root getting in, the second stops one that got in some other way
 * (hand-edited data.json, a future migration) from being acted on.
 *
 * Node modules are required lazily, matching the rest of the codebase, so this
 * module stays importable from the mobile bundle where `fs` does not exist.
 */

export const ARTIFACT_STORAGE_DIR = '.geode';
export const ARTIFACT_STORAGE_SUBDIR = 'artifacts';

/** Room for a deep artifact tree without accepting an unbounded string. */
const MAX_STORAGE_ROOT_LENGTH = 4096;

export type StorageRootResolution =
  | { readonly status: 'ok'; readonly path: string }
  | { readonly status: 'invalid'; readonly message: string };

/** The slice of `fs` this module needs. Injectable so tests never touch disk. */
export interface ArtifactStorageFs {
  /** Resolves symlinks. Expected to throw for a path that does not exist. */
  realpathSync?(target: string): string;
  rm?(target: string, options: { recursive: true; force: true }): Promise<unknown>;
}

interface PathModule {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(target: string): string;
  basename(target: string): string;
  isAbsolute(target: string): boolean;
  readonly sep: string;
}

function nodePath(): PathModule | null {
  try {
    return require('path') as PathModule;
  } catch {
    return null;
  }
}

function nodeStorageFs(): ArtifactStorageFs {
  try {
    const fs = require('fs') as typeof import('fs');
    return {
      // `.native` resolves case and symlinks the way the OS does; it is absent
      // from some shims, so fall back rather than throwing at import time.
      realpathSync: target => (typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(target) : fs.realpathSync(target)),
      rm: (target, options) => fs.promises.rm(target, options),
    };
  } catch {
    return {};
  }
}

/** `<vault>/.geode/artifacts` — the only directory tree artifacts may occupy. */
export function artifactStorageRoot(vaultRoot: string): string {
  const pathModule = nodePath();
  if (!pathModule) return `${vaultRoot}/${ARTIFACT_STORAGE_DIR}/${ARTIFACT_STORAGE_SUBDIR}`;
  return pathModule.join(vaultRoot, ARTIFACT_STORAGE_DIR, ARTIFACT_STORAGE_SUBDIR);
}

/**
 * Resolves `target` as far as the filesystem can, then re-appends the segments
 * that do not exist yet. A peer may legitimately declare a storage root before
 * creating it, and `realpath` throws on a missing path — walking up to the
 * deepest existing ancestor keeps symlink resolution working for the part that
 * does exist without rejecting not-yet-created directories.
 */
function resolveDeep(pathModule: PathModule, storageFs: ArtifactStorageFs, target: string): string {
  const absolute = pathModule.resolve(target);
  const realpathSync = storageFs.realpathSync;
  if (!realpathSync) return absolute;
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return missing.length ? pathModule.join(realpathSync(current), ...missing) : realpathSync(current);
    } catch {
      const parent = pathModule.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (!parent || parent === current) return absolute;
      missing.unshift(pathModule.basename(current));
      current = parent;
    }
  }
}

function invalid(message: string): StorageRootResolution {
  return { status: 'invalid', message };
}

/**
 * Accepts `candidate` only when it resolves to a directory strictly inside the
 * vault's artifact root. The artifact root itself and the vault root are both
 * rejected: deleting either would take every artifact (or the whole vault)
 * with it.
 */
export function resolveStorageRoot(
  vaultRoot: string,
  candidate: unknown,
  storageFs: ArtifactStorageFs = nodeStorageFs(),
): StorageRootResolution {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return invalid('storageRoot must be a non-empty string.');
  }
  if (candidate.length > MAX_STORAGE_ROOT_LENGTH) {
    return invalid(`storageRoot must be no longer than ${MAX_STORAGE_ROOT_LENGTH} characters.`);
  }
  if (candidate.includes('\0')) {
    return invalid('storageRoot must not contain null bytes.');
  }
  if (!vaultRoot) {
    return invalid('This host has no local vault, so artifact storage cannot be validated.');
  }
  const pathModule = nodePath();
  if (!pathModule) {
    return invalid('This host has no local filesystem, so artifact storage cannot be validated.');
  }
  // A relative path has no meaning here: there is no defined base to resolve it
  // against, and accepting one would make containment depend on process cwd.
  if (!pathModule.isAbsolute(candidate)) {
    return invalid('storageRoot must be an absolute path inside the vault artifact root.');
  }

  const root = resolveDeep(pathModule, storageFs, artifactStorageRoot(vaultRoot));
  const vault = resolveDeep(pathModule, storageFs, vaultRoot);
  const resolved = resolveDeep(pathModule, storageFs, candidate);

  if (resolved === root) {
    return invalid('storageRoot must be a directory inside the artifact root, not the artifact root itself.');
  }
  if (resolved === vault) {
    return invalid('storageRoot must not be the vault root.');
  }
  if (!resolved.startsWith(root + pathModule.sep)) {
    return invalid(`storageRoot must resolve inside ${root}.`);
  }
  return { status: 'ok', path: resolved };
}

/**
 * Deletes one artifact's storage. Re-validates first, so a root that somehow
 * bypassed `resolveStorageRoot` on the way in still cannot be acted on. A
 * missing or already-deleted directory is not an error — thread deletion must
 * never fail because storage was cleaned up some other way.
 */
export async function removeStorageRoot(
  vaultRoot: string,
  candidate: unknown,
  storageFs: ArtifactStorageFs = nodeStorageFs(),
): Promise<boolean> {
  const resolved = resolveStorageRoot(vaultRoot, candidate, storageFs);
  if (resolved.status !== 'ok' || !storageFs.rm) return false;
  try {
    await storageFs.rm(resolved.path, { recursive: true, force: true });
    return true;
  } catch {
    // Tolerated silently: storage cleanup is best-effort garbage collection,
    // not part of the delete's success condition.
    return false;
  }
}
