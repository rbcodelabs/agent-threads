/**
 * Pure logic for the Skills Manager "+" menu and the Settings pointer. Kept
 * free of Obsidian and Node imports so it is unit-testable and safe to load on
 * mobile (SettingsTab imports it).
 */

export type ImportMenuItemId = 'import-folder' | 'import-file' | 'add-github-source' | 'add-local-source';

export interface ImportMenuItem {
  id: ImportMenuItemId;
  title: string;
  icon: string;
  enabled: boolean;
  /** Why the item is unavailable. Only set when `enabled` is false. */
  disabledReason?: string;
}

export interface ImportMenuState {
  /** The "+" button is usable when at least one item is. */
  enabled: boolean;
  items: ImportMenuItem[];
  /** Tooltip for the "+" button. */
  tooltip: string;
}

export const NO_INSTALL_ROOT_MESSAGE =
  'Cannot resolve the vault skills folder, so there is nowhere to install to. Skill installs need a desktop vault on a real filesystem.';

export const NO_CLONE_BASE_MESSAGE =
  'Cannot resolve the vault folder, so there is nowhere to clone to. GitHub skill sources need a desktop vault on a real filesystem.';

/**
 * Which "+" menu items work in the current vault. Importing needs the plugin
 * skills root; adding a GitHub source needs the clone base. A local-folder
 * source only registers an existing path, so it works whenever the plugin can
 * persist settings, which is always.
 */
export function getImportMenuState(opts: { canInstall: boolean; canClone: boolean }): ImportMenuState {
  const items: ImportMenuItem[] = [
    { id: 'import-folder', title: 'Folder…', icon: 'folder-plus', enabled: opts.canInstall, ...(opts.canInstall ? {} : { disabledReason: NO_INSTALL_ROOT_MESSAGE }) },
    { id: 'import-file', title: 'File (.skill)…', icon: 'file-up', enabled: opts.canInstall, ...(opts.canInstall ? {} : { disabledReason: NO_INSTALL_ROOT_MESSAGE }) },
    { id: 'add-github-source', title: 'GitHub repo…', icon: 'git-branch', enabled: opts.canClone, ...(opts.canClone ? {} : { disabledReason: NO_CLONE_BASE_MESSAGE }) },
    { id: 'add-local-source', title: 'Local folder source…', icon: 'folder-symlink', enabled: true },
  ];
  return {
    enabled: items.some((i) => i.enabled),
    items,
    tooltip: 'Import a skill or add a skill source',
  };
}

/** One-line summary of how many skill sources are configured. */
export function describeSkillSourceCount(count: number): string {
  if (count === 0) return 'No skill sources configured.';
  return `${count} skill source${count === 1 ? '' : 's'} configured.`;
}
