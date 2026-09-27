/**
 * `vault_list`: a read-only folder listing over the vault's `DataAdapter`.
 *
 * Why it exists: current Claude Code builds expose no Glob/Grep tool to these
 * sessions, so a skill that must not use Bash had no way to list a folder and
 * the model fell back to `ls`/`find`. This lists through the same adapter the
 * host uses, so it works on any adapter (desktop filesystem or mobile), sees
 * non-Markdown files, and never runs a shell.
 *
 * - Paths are vault-relative. Absolute paths and any `..` segment are rejected
 *   before the adapter is touched.
 * - The host config dir (`app.vault.configDir`, e.g. `.obsidian` / `.geode`) is
 *   skipped unless the requested path is inside it.
 * - Entries are sorted by path. The walk stops as soon as `limit` entries plus
 *   one are found, so `truncated` is exact without listing the whole vault.
 */

export const VAULT_LIST_DEFAULT_LIMIT = 500;
export const VAULT_LIST_MAX_LIMIT = 2000;

/** The slice of Obsidian's `DataAdapter` this needs. */
export interface VaultListAdapter {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: 'file' | 'folder'; size?: number; mtime?: number } | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

/** The slice of the host's abstract file tree (`Vault.getRoot` / `getAbstractFileByPath`) this needs. */
export interface VaultTree {
  getRoot(): VaultTreeNode;
  getAbstractFileByPath(path: string): VaultTreeNode | null;
}

/** A `TFolder` (has `children`) or `TFile` (has `stat`), duck-typed so tests need no host classes. */
export interface VaultTreeNode {
  path: string;
  children?: VaultTreeNode[];
  stat?: { size?: number; mtime?: number };
}

/**
 * A `VaultListAdapter` over the vault's in-memory file tree, for hosts whose
 * `DataAdapter` has no `list()` — Geode's FileSystemAdapter does not implement
 * it. Same entries, errors and rules as the adapter path, because `listVault`
 * still applies them; the one difference is that the tree never contains the
 * host config dir, so it cannot be listed even when requested explicitly.
 */
export function vaultTreeAdapter(vault: VaultTree): VaultListAdapter {
  const node = (path: string): VaultTreeNode | null => {
    const key = relative(path);
    return key === '' ? vault.getRoot() : vault.getAbstractFileByPath(key);
  };
  return {
    exists: async (path) => node(path) !== null,
    stat: async (path) => {
      const found = node(path);
      if (!found) return null;
      if (Array.isArray(found.children)) return { type: 'folder' };
      return { type: 'file', size: found.stat?.size, mtime: found.stat?.mtime };
    },
    list: async (path) => {
      const found = node(path);
      if (!found || !Array.isArray(found.children)) throw new VaultListError(`Folder not found: ${relative(path)}`);
      const files: string[] = [];
      const folders: string[] = [];
      for (const child of found.children) (Array.isArray(child.children) ? folders : files).push(child.path);
      return { files, folders };
    },
  };
}

/**
 * The listing source for a host: its `DataAdapter` when that implements
 * `list()` (Obsidian), otherwise the vault's file tree (Geode).
 */
export function vaultListSource(vault: VaultTree & { adapter?: unknown }): VaultListAdapter {
  const adapter = vault.adapter as Partial<VaultListAdapter> | undefined;
  if (adapter && typeof adapter.list === 'function' && typeof adapter.stat === 'function' && typeof adapter.exists === 'function') {
    return adapter as VaultListAdapter;
  }
  return vaultTreeAdapter(vault);
}

export interface VaultListEntry {
  path: string;
  type: 'file' | 'folder';
  size?: number;
  mtime?: number;
}

export interface VaultListResult {
  /** The normalized, vault-relative folder that was listed ('' = vault root). */
  path: string;
  entries: VaultListEntry[];
  truncated: boolean;
}

/** A caller mistake (bad path, missing folder); the message is safe to show the model. */
export class VaultListError extends Error {}

/**
 * Normalizes a caller-supplied folder to a vault-relative path ('' = root).
 * Throws VaultListError for absolute paths and `..` escapes.
 */
export function normalizeVaultListPath(input?: string): string {
  const raw = (input ?? '').trim();
  if (raw === '' || raw === '.' || raw === './' || raw === '/') return '';
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('~')) {
    throw new VaultListError(`Path must be vault-relative, not absolute: ${raw}`);
  }
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    throw new VaultListError(`Path must be vault-relative, not absolute: ${raw}`);
  }
  const segments = raw.replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new VaultListError(`Path must stay inside the vault (no ".." segments): ${raw}`);
  }
  return segments.join('/');
}

/** Adapter paths can come back with a leading slash at the root; entries never carry one. */
function relative(path: string): string {
  let start = 0;
  while (start < path.length && path.charCodeAt(start) === 0x2f) start++;
  return start === 0 ? path : path.slice(start);
}

function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

export async function listVault(
  adapter: VaultListAdapter,
  options: { path?: string; recursive?: boolean; limit?: number; configDir?: string },
): Promise<VaultListResult> {
  const root = normalizeVaultListPath(options.path);
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? VAULT_LIST_DEFAULT_LIMIT)), VAULT_LIST_MAX_LIMIT);
  const configDir = options.configDir ? normalizeVaultListPath(options.configDir) : '';
  // Explicitly asking for the config dir (or something inside it) lists it.
  const skipConfigDir = configDir !== '' && !(root !== '' && isWithin(root, configDir));

  if (root !== '') {
    if (!(await adapter.exists(root))) throw new VaultListError(`Folder not found: ${root}`);
    const stat = await adapter.stat(root);
    if (!stat) throw new VaultListError(`Folder not found: ${root}`);
    if (stat.type !== 'folder') throw new VaultListError(`Not a folder: ${root}`);
  }

  const entries: VaultListEntry[] = [];
  let truncated = false;

  const walk = async (folder: string): Promise<void> => {
    const listed = await adapter.list(folder === '' ? '/' : folder);
    const children = [
      ...listed.folders.map((p) => ({ path: relative(p), type: 'folder' as const })),
      ...listed.files.map((p) => ({ path: relative(p), type: 'file' as const })),
    ]
      .filter((child) => !(skipConfigDir && isWithin(child.path, configDir)))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    for (const child of children) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const stat = await adapter.stat(child.path);
      const entry: VaultListEntry = { path: child.path, type: stat?.type ?? child.type };
      if (entry.type === 'file' && typeof stat?.size === 'number') entry.size = stat.size;
      if (typeof stat?.mtime === 'number') entry.mtime = stat.mtime;
      entries.push(entry);
      if (options.recursive && entry.type === 'folder') {
        await walk(child.path);
        if (truncated) return;
      }
    }
  };

  await walk(root);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { path: root, entries, truncated };
}
