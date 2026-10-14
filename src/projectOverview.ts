import type { Project } from './types';

/** True for a vault-relative overview path: not absolute (POSIX or Windows) and no `..` segment. Empty is valid (means the default). */
export function isValidOverviewPath(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  return !(v.startsWith('/') || v.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(v) || v.split(/[\\/]/).includes('..'));
}

/** Vault-relative path of the Project overview note (explicit setting, else `<vaultFolder>/_overview.md`). */
export function resolveProjectOverviewPath(project: Pick<Project, 'vaultFolder' | 'overviewPath'>): string {
  const explicit = project.overviewPath?.trim();
  if (explicit) return explicit.replace(/^\/+/, '');
  const folder = project.vaultFolder.trim().replace(/^\/+|\/+$/g, '');
  return folder ? `${folder}/_overview.md` : '_overview.md';
}

/**
 * Reads the Project overview note via the supplied reader. Returns the note
 * text, or undefined when it is missing, empty, escapes the vault, or fails
 * to read. Never throws.
 */
export function readProjectOverview(
  project: Pick<Project, 'vaultFolder' | 'overviewPath'> | undefined,
  readVaultFile: (vaultRelativePath: string) => string | undefined,
): { path: string; content: string } | undefined {
  if (!project) return undefined;
  const overviewPath = resolveProjectOverviewPath(project);
  if (overviewPath.split(/[\\/]/).includes('..')) return undefined;
  try {
    const content = readVaultFile(overviewPath)?.trim();
    return content ? { path: overviewPath, content } : undefined;
  } catch {
    return undefined;
  }
}

export function buildProjectOverviewContext(overview: { path: string; content: string } | undefined): string {
  if (!overview) return '';
  return `## Project overview (${overview.path})\n` +
    'This is the grounding context for this Project. Use vault_search for deeper detail.\n\n' +
    overview.content;
}

/**
 * Composes the per-thread appended system prompt. Order is fixed:
 * environment, Project description, Project overview, active goal.
 * thread.managerNotes / proposedReply are intentionally never passed in.
 */
export function composeAppendSystemPrompt(parts: {
  envContext?: string;
  projectDesc?: string;
  overviewContext?: string;
  goalContext?: string;
}): string {
  return [parts.envContext, parts.projectDesc, parts.overviewContext, parts.goalContext]
    .filter(Boolean)
    .join('\n\n');
}
