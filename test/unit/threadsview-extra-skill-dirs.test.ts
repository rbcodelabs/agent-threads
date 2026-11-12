import { describe, expect, it } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';

// The thread composer and the new-conversation (Dispatch) composer must offer
// the same /skill list. Both get it from computeExtraSkillDirs(); the new
// composer previously received none, so only ~/.claude/skills showed up.
type Host = { plugin: unknown };
const compute = (plugin: unknown) =>
  (ThreadsView.prototype as unknown as { computeExtraSkillDirs(this: Host): Array<{ dir: string; prefix?: string }> })
    .computeExtraSkillDirs.call({ plugin });

describe('ThreadsView.computeExtraSkillDirs', () => {
  it('includes local-source, local-skills and vault-skills roots with their namespaces', () => {
    const dirs = compute({
      settings: { skillSources: [{ type: 'local', skillsPath: '/src/skills' }] },
      getPluginSkillsRoot: () => '/vault/.geode/skills',
      getLocalSkillsRoot: () => '/vault/Skills',
    });
    expect(dirs[0]).toEqual({ dir: '/src/skills' });
    expect(dirs.find(d => d.dir === '/vault/Skills')?.prefix).toBe('local');
    expect(dirs.find(d => d.dir === '/vault/.geode/skills')?.prefix).toBeTruthy();
  });

  it('returns an empty list when nothing is configured', () => {
    expect(compute({ settings: {}, getPluginSkillsRoot: () => '', getLocalSkillsRoot: () => '' })).toEqual([]);
  });
});
