/**
 * Pure (no Node imports) helpers for the machine-specific `clonePath` of managed
 * GitHub skill sources. Kept out of skillManager so main.ts can import them
 * statically, including on mobile.
 */
import type { SkillSource } from './types';

function joinPath(base: string, id: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + id;
}

/**
 * Re-derives the clone location of every managed GitHub source from the
 * current vault (`<cloneBase>/<id>`), in memory. A persisted absolute path goes
 * stale the moment the vault moves or `data.json` syncs to another machine, so
 * a missing clonePath, or one in managed form (`.../skill-sources/<id>`) that
 * points somewhere else, is replaced. A hand-set path to any other location is
 * the user's and is left alone. Returns true when any source was changed.
 */
export function resolveManagedClonePaths(skillSources: SkillSource[] | undefined, cloneBase: string): boolean {
  if (!skillSources?.length || !cloneBase) return false;
  let changed = false;
  for (const source of skillSources) {
    if (source.type !== 'github' || !source.id) continue;
    const derived = joinPath(cloneBase, source.id);
    if (source.clonePath === derived) continue;
    if (!source.clonePath || isManagedClonePathForm(source.clonePath, source.id)) {
      source.clonePath = derived;
      changed = true;
    }
  }
  return changed;
}

function isManagedClonePathForm(clonePath: string, id: string): boolean {
  const norm = clonePath.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return norm.length >= 2 && norm[norm.length - 1] === id && norm[norm.length - 2] === 'skill-sources';
}

/** Copies of `skillSources` safe to persist: managed clone paths are machine-specific, so they are dropped. */
export function skillSourcesForPersistence(skillSources: SkillSource[] | undefined): SkillSource[] | undefined {
  if (!skillSources) return skillSources;
  return skillSources.map((s) => {
    if (s.type === 'github' && s.id && s.clonePath && isManagedClonePathForm(s.clonePath, s.id)) {
      const { clonePath: _omit, ...rest } = s;
      return rest;
    }
    return s;
  });
}

