import { describe, it, expect } from 'vitest';
import { mapToVaultPath, findBridgesForFiles, bridgeRoots, type BridgeInfo } from '../../src/bridgeUtils';

function bridge(overrides: Partial<BridgeInfo> = {}): BridgeInfo {
  return {
    id: 'b1',
    name: 'Agentic PM Playbook',
    repoPath: '/Users/me/projects/agent-pm-playbook',
    sourcePath: '',
    vaultPath: 'Playbooks/Agentic PM Playbook',
    branch: 'main',
    autoSync: true,
    status: 'ok',
    ...overrides,
  };
}

describe('bridgeRoots', () => {
  it('returns the repo root for a whole-repo bridge', () => {
    expect(bridgeRoots(bridge())).toEqual(['/Users/me/projects/agent-pm-playbook']);
  });

  it('appends sourcePath when set', () => {
    expect(bridgeRoots(bridge({ sourcePath: 'docs' }))).toEqual([
      '/Users/me/projects/agent-pm-playbook/docs',
    ]);
  });

  it('includes the active worktree root when set', () => {
    const roots = bridgeRoots(bridge({ activeWorktreePath: '/tmp/wt/abc', sourcePath: 'docs' }));
    expect(roots).toEqual([
      '/Users/me/projects/agent-pm-playbook/docs',
      '/tmp/wt/abc/docs',
    ]);
  });
});

describe('mapToVaultPath', () => {
  it('maps a repo file to its synced vault path', () => {
    const m = mapToVaultPath('/Users/me/projects/agent-pm-playbook/skills/pm-coach/SKILL.md', [bridge()]);
    expect(m?.vaultRelPath).toBe('Playbooks/Agentic PM Playbook/skills/pm-coach/SKILL.md');
    expect(m?.bridge.id).toBe('b1');
  });

  it('respects sourcePath subfolder boundaries', () => {
    const b = bridge({ sourcePath: 'docs' });
    expect(mapToVaultPath('/Users/me/projects/agent-pm-playbook/docs/intro.md', [b])?.vaultRelPath)
      .toBe('Playbooks/Agentic PM Playbook/intro.md');
    // Outside the mirrored subfolder: not synced, no mapping.
    expect(mapToVaultPath('/Users/me/projects/agent-pm-playbook/src/index.ts', [b])).toBeNull();
  });

  it('does not match sibling directories with a shared prefix', () => {
    expect(mapToVaultPath('/Users/me/projects/agent-pm-playbook-fork/readme.md', [bridge()])).toBeNull();
  });

  it('matches files inside the active worktree', () => {
    const b = bridge({ activeWorktreePath: '/tmp/wt/abc' });
    expect(mapToVaultPath('/tmp/wt/abc/skills/SKILL.md', [b])?.vaultRelPath)
      .toBe('Playbooks/Agentic PM Playbook/skills/SKILL.md');
  });

  it('returns null for unrelated paths', () => {
    expect(mapToVaultPath('/Users/me/Documents/Personal/Daily/2026-06-11.md', [bridge()])).toBeNull();
  });

  it('picks the first matching bridge', () => {
    const b2 = bridge({ id: 'b2', repoPath: '/Users/me/projects/other', vaultPath: 'Other' });
    const m = mapToVaultPath('/Users/me/projects/other/a.md', [bridge(), b2]);
    expect(m?.bridge.id).toBe('b2');
  });
});

describe('findBridgesForFiles', () => {
  it('returns unique bridges for a mixed set of files', () => {
    const b2 = bridge({ id: 'b2', repoPath: '/Users/me/projects/other', vaultPath: 'Other' });
    const matched = findBridgesForFiles(
      [
        '/Users/me/projects/agent-pm-playbook/a.md',
        '/Users/me/projects/agent-pm-playbook/b.md',
        '/Users/me/projects/other/c.md',
        '/Users/me/projects/unbridged/d.md',
      ],
      [bridge(), b2],
    );
    expect(matched.map(b => b.id)).toEqual(['b1', 'b2']);
  });

  it('returns empty for vault-internal edits', () => {
    expect(findBridgesForFiles(['/Users/me/Documents/Personal/note.md'], [bridge()])).toEqual([]);
  });
});
