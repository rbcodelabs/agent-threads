/**
 * Choosing among the folders a daemon advertises (`workspaces.list`), so the
 * person never types a remote path from memory. Pure logic shared by Settings
 * (vault folder / default folder dropdowns) and the Run on picker.
 */
import type { WorkspaceInfo } from '../protocol';
import { normalizePosixPath } from './vaultMapping';
import { guestToHostPath, hostToGuestPath, type PathMount } from './mountPaths';

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

// ── Local daemon: folders named for the Mac, valued as the daemon's own paths ─

export interface LocalDaemonChoice {
  /** The path inside the daemon (what a thread's cwd is). */
  value: string;
  /** Host-side name: a Project's name, `vault`, or the shared folder's name. */
  label: string;
}

export interface LocalDaemonChoices {
  choices: LocalDaemonChoice[];
  /** The guest path to pre-select (the selected Project's folder), when it is shared. */
  selected?: string;
  /** Projects whose folder is not under any mount. */
  unshared: Array<{ name: string; hostPath: string }>;
  /** The selected Project's entry in `unshared`, if that is the one in play. */
  selectedUnshared?: { name: string; hostPath: string };
}

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p;

/**
 * The "Run on this Mac (container)" folder list. Each folder the daemon advertises is named for its folder on the
 * Mac (a Project's name when a Project lives there); Projects inside a mount but not advertised are added; Projects
 * outside every mount are reported as `unshared` so the UI can offer to share them.
 */
export function buildLocalDaemonChoices(input: {
  workspaces: readonly WorkspaceInfo[];
  mounts: readonly PathMount[];
  projects: ReadonlyArray<{ name: string; cwd: string }>;
  selectedProjectCwd?: string;
}): LocalDaemonChoices {
  const { workspaces, mounts, projects } = input;
  const norm = (p: string): string => normalizePosixPath(p) ?? p;
  const projectAt = new Map<string, string>(); // guest path -> project name
  const unshared: Array<{ name: string; hostPath: string }> = [];
  for (const project of projects) {
    const guest = hostToGuestPath(mounts, project.cwd);
    if (guest === undefined) {
      if (!unshared.some((u) => norm(u.hostPath) === norm(project.cwd))) unshared.push({ name: project.name, hostPath: project.cwd });
    } else if (!projectAt.has(guest)) projectAt.set(guest, project.name);
  }
  const choices: LocalDaemonChoice[] = [];
  for (const w of workspaces) {
    const guest = norm(w.path);
    const host = guestToHostPath(mounts, w.path);
    const label = projectAt.get(guest) ?? (w.kind === 'vault' ? 'vault' : host ? baseName(host) : w.name || w.path);
    choices.push({ value: w.path, label: `${label}${w.readOnly ? ' (read-only)' : ''}` });
  }
  for (const [guest, name] of projectAt) {
    if (!choices.some((c) => norm(c.value) === guest)) choices.push({ value: guest, label: name });
  }
  const selectedGuest = input.selectedProjectCwd ? hostToGuestPath(mounts, input.selectedProjectCwd) : undefined;
  const selectedUnshared = input.selectedProjectCwd
    ? unshared.find((u) => norm(u.hostPath) === norm(input.selectedProjectCwd as string))
    : undefined;
  return { choices, selected: selectedGuest, unshared, selectedUnshared };
}
