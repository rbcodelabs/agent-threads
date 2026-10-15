/**
 * Choosing among the folders a daemon advertises (`workspaces.list`), so the
 * person never types a remote path from memory. Pure logic shared by Settings
 * (vault folder / default folder dropdowns) and the Run on picker.
 */
import type { WorkspaceInfo } from '../protocol';
import { normalizePosixPath } from './vaultMapping';

const fold = (s: string): string => s.normalize('NFC').toLowerCase();

export type VaultPickReason = 'only-vault' | 'name-match' | 'none';

export interface VaultPick {
  workspace?: WorkspaceInfo;
  reason: VaultPickReason;
}

/**
 * Which advertised folder is this vault's copy?
 *   1. exactly one folder looks like a vault (has a `.geode`/`.obsidian`/`.vault` marker): that one;
 *   2. otherwise the one whose folder name equals this vault's folder name (vault-like folders first);
 *   3. otherwise nothing, and the person chooses (or leaves it as None).
 * An ambiguous match (two candidates) is treated as no match rather than a guess.
 */
export function pickVaultWorkspace(workspaces: readonly WorkspaceInfo[], vaultFolderName: string | undefined): VaultPick {
  const vaults = workspaces.filter((w) => w.kind === 'vault');
  if (vaults.length === 1) return { workspace: vaults[0], reason: 'only-vault' };
  const wanted = vaultFolderName ? fold(vaultFolderName) : '';
  if (wanted) {
    for (const tier of [vaults, workspaces]) {
      const matches = tier.filter((w) => fold(w.name) === wanted);
      if (matches.length === 1) return { workspace: matches[0], reason: 'name-match' };
      if (matches.length > 1) break;
    }
  }
  return { reason: 'none' };
}

/** The daemon's own preferred starting folder, else its first read-write folder. */
export function pickDefaultWorkspace(workspaces: readonly WorkspaceInfo[]): WorkspaceInfo | undefined {
  return workspaces.find((w) => w.isDefault) ?? workspaces.find((w) => !w.readOnly) ?? workspaces[0];
}

/** Short label for a dropdown: `my-vault (vault, read-only)`. */
export function workspaceLabel(w: WorkspaceInfo): string {
  const tags = [w.kind === 'vault' ? 'vault' : '', w.readOnly ? 'read-only' : ''].filter(Boolean);
  return `${w.name || w.path}${tags.length ? ` (${tags.join(', ')})` : ''} - ${w.path}`;
}

/** The advertised folder equal to `path` (lexically), if any. */
export function workspaceForPath(workspaces: readonly WorkspaceInfo[], path: string | undefined): WorkspaceInfo | undefined {
  const wanted = path ? normalizePosixPath(path) : undefined;
  if (wanted === undefined) return undefined;
  return workspaces.find((w) => normalizePosixPath(w.path) === wanted);
}

/** The advertised folder that contains `path` (the deepest one), if any. */
export function workspaceContaining(workspaces: readonly WorkspaceInfo[], path: string | undefined): WorkspaceInfo | undefined {
  const target = path ? normalizePosixPath(path) : undefined;
  if (target === undefined) return undefined;
  let best: { w: WorkspaceInfo; len: number } | undefined;
  for (const w of workspaces) {
    const root = normalizePosixPath(w.path);
    if (root === undefined) continue;
    const inside = root === '/' || target === root || target.startsWith(`${root}/`);
    if (inside && (!best || root.length > best.len)) best = { w, len: root.length };
  }
  return best?.w;
}

/** One sentence under the vault dropdown saying why it is set the way it is. */
export function describeVaultPick(pick: VaultPick, daemonName: string): string {
  switch (pick.reason) {
    case 'only-vault': return `Chosen for you: the only vault on ${daemonName}.`;
    case 'name-match': return `Chosen for you: its name matches this vault.`;
    default: return `${daemonName} has no folder that clearly matches this vault. Choose one, or leave it as None.`;
  }
}

/** Parent of an absolute POSIX path, or undefined at the root. */
export function parentPath(path: string): string | undefined {
  const p = normalizePosixPath(path);
  if (p === undefined || p === '/') return undefined;
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

// ── Settings dialog: what to pre-fill once the daemon has told us its folders ─

export interface FolderDraft {
  /** Vault folder on the daemon ('' = none). */
  vaultRemote: string;
  /** Default folder for new threads ('' = none). */
  folder: string;
  /** The person changed the vault field themselves, so discovery must not overwrite it. */
  vaultTouched: boolean;
  folderTouched: boolean;
}

export interface DiscoveryOutcome {
  draft: FolderDraft;
  /** How the vault folder was (or was not) chosen, for the hint line. */
  vaultPick: VaultPick;
  /** True when discovery filled the vault field. */
  vaultAutoSelected: boolean;
}

/**
 * Apply a successful `workspaces.list` to the dialog. Only EMPTY, untouched
 * fields are filled: a value the person typed or saved earlier always wins.
 */
export function applyDiscovery(draft: FolderDraft, workspaces: readonly WorkspaceInfo[], vaultFolderName: string | undefined): DiscoveryOutcome {
  const vaultPick = pickVaultWorkspace(workspaces, vaultFolderName);
  const next = { ...draft };
  let vaultAutoSelected = false;
  if (!draft.vaultTouched && !draft.vaultRemote.trim() && vaultPick.workspace) {
    next.vaultRemote = vaultPick.workspace.path;
    vaultAutoSelected = true;
  }
  if (!draft.folderTouched && !draft.folder.trim()) {
    next.folder = pickDefaultWorkspace(workspaces)?.path ?? '';
  }
  return { draft: next, vaultPick, vaultAutoSelected };
}
