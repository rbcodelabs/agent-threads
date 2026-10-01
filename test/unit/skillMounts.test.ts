/**
 * Tests for skillMounts — the pure host-path -> guest-path mapping that lets a
 * VM-routed Claude harness (ADR-0015) see skills. No Obsidian, no real fs.
 */
import { describe, it, expect } from 'vitest';
import {
  GUEST_HOME,
  SKILLS_GUEST_ROOT,
  mountSignature,
  parseMountSignature,
  planSkillMounts,
  rewritePluginsForGuest,
  type MountFs,
} from '../../src/skillMounts';

interface FakeNode { real?: string; dir?: boolean; links?: Record<string, string> }

/** Fake fs keyed by host path. `real` defaults to the path itself (not a symlink). */
function fakeFs(nodes: Record<string, FakeNode>): MountFs {
  return {
    realpath: (p) => {
      const n = nodes[p];
      if (!n) return null;
      return n.real ?? p;
    },
    isDirectory: (p) => {
      const n = nodes[p];
      if (!n) return false;
      return n.dir !== false;
    },
    childSymlinks: (dir) => Object.entries(nodes[dir]?.links ?? {}).map(([name, linkText]) => ({ name, linkText })),
  };
}

const HOME = '/Users/rick';

describe('planSkillMounts', () => {
  it('mounts each plugin root at a deterministic /skills/<name>-<hash> guest path', () => {
    const fs = fakeFs({ '/a/skills/foo': {} });
    const plan = planSkillMounts({ plugins: [{ type: 'local', path: '/a/skills/foo' }], homeDir: HOME, fs });
    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0].hostPath).toBe('/a/skills/foo');
    expect(plan.mounts[0].guestPath).toMatch(new RegExp(`^${SKILLS_GUEST_ROOT}/foo-[0-9a-f]{10}$`));
    expect(plan.pluginGuestPaths['/a/skills/foo']).toBe(plan.mounts[0].guestPath);
    const again = planSkillMounts({ plugins: [{ type: 'local', path: '/a/skills/foo' }], homeDir: HOME, fs });
    expect(again).toEqual(plan);
  });

  it('resolves symlinks with realpath and dedupes plugins that share a real directory', () => {
    const fs = fakeFs({
      '/link/a': { real: '/real/x' },
      '/link/b': { real: '/real/x' },
      '/real/x': {},
    });
    const plan = planSkillMounts({
      plugins: [{ type: 'local', path: '/link/a' }, { type: 'local', path: '/link/b' }],
      homeDir: HOME,
      fs,
    });
    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0].hostPath).toBe('/real/x');
    expect(plan.pluginGuestPaths['/link/a']).toBe(plan.pluginGuestPaths['/link/b']);
  });

  it('skips nonexistent paths and non-directories', () => {
    const fs = fakeFs({ '/file': { dir: false } });
    const plan = planSkillMounts({
      plugins: [{ type: 'local', path: '/missing' }, { type: 'local', path: '/file' }],
      homeDir: HOME,
      fs,
    });
    expect(plan.mounts).toEqual([]);
    expect(plan.pluginGuestPaths).toEqual({});
  });

  it('rejects host paths containing a colon (volume delimiter)', () => {
    const fs = fakeFs({ '/bad:path': {}, '/ok': {} });
    const plan = planSkillMounts({
      plugins: [{ type: 'local', path: '/bad:path' }, { type: 'local', path: '/ok' }],
      homeDir: HOME,
      fs,
    });
    expect(plan.mounts.map((m) => m.hostPath)).toEqual(['/ok']);
  });

  it('mounts ~/.claude/skills and ~/.claude/agents at the guest home when present', () => {
    const fs = fakeFs({ [`${HOME}/.claude/skills`]: {}, [`${HOME}/.claude/agents`]: {} });
    const plan = planSkillMounts({ plugins: [], homeDir: HOME, fs });
    expect(plan.mounts).toEqual([
      { hostPath: `${HOME}/.claude/agents`, guestPath: `${GUEST_HOME}/.claude/agents` },
      { hostPath: `${HOME}/.claude/skills`, guestPath: `${GUEST_HOME}/.claude/skills` },
    ]);
  });

  it('omits ~/.claude mounts that do not exist', () => {
    const plan = planSkillMounts({ plugins: [], homeDir: HOME, fs: fakeFs({}) });
    expect(plan.mounts).toEqual([]);
  });

  it('mounts escaping relative symlink targets where the link resolves in the guest', () => {
    // ~/.claude/skills/find-skills -> ../../.agents/skills/find-skills
    const skills = `${HOME}/.claude/skills`;
    const fs = fakeFs({
      [skills]: { links: { 'find-skills': '../../.agents/skills/find-skills' } },
      [`${skills}/find-skills`]: { real: `${HOME}/.agents/skills/find-skills` },
      [`${HOME}/.agents/skills/find-skills`]: {},
    });
    const plan = planSkillMounts({ plugins: [], homeDir: HOME, fs });
    expect(plan.mounts).toContainEqual({
      hostPath: `${HOME}/.agents/skills/find-skills`,
      guestPath: `${GUEST_HOME}/.agents/skills/find-skills`,
    });
  });

  it('mounts absolute symlink targets at the identical path when under the host home', () => {
    const skills = `${HOME}/.claude/skills`;
    const fs = fakeFs({
      [skills]: { links: { s: `${HOME}/elsewhere/s` } },
      [`${skills}/s`]: { real: `${HOME}/elsewhere/s` },
      [`${HOME}/elsewhere/s`]: {},
    });
    const plan = planSkillMounts({ plugins: [], homeDir: HOME, fs });
    expect(plan.mounts).toContainEqual({ hostPath: `${HOME}/elsewhere/s`, guestPath: `${HOME}/elsewhere/s` });
  });

  it('never mounts symlink targets over system paths', () => {
    const skills = `${HOME}/.claude/skills`;
    const fs = fakeFs({
      [skills]: { links: { evil: '/etc' } },
      [`${skills}/evil`]: { real: '/etc' },
      '/etc': {},
    });
    const plan = planSkillMounts({ plugins: [], homeDir: HOME, fs });
    expect(plan.mounts.map((m) => m.guestPath)).not.toContain('/etc');
  });

  it('scans a plugin root\'s skills/ subdir for escaping symlinks too', () => {
    const fs = fakeFs({
      '/vault/skills-root': { links: {} },
      '/vault/skills-root/skills': { links: { x: `${HOME}/src/x` } },
      '/vault/skills-root/skills/x': { real: `${HOME}/src/x` },
      [`${HOME}/src/x`]: {},
    });
    const plan = planSkillMounts({ plugins: [{ type: 'local', path: '/vault/skills-root' }], homeDir: HOME, fs });
    expect(plan.mounts.map((m) => m.hostPath)).toContain(`${HOME}/src/x`);
  });

  it('returns mounts sorted by guest path so the signature is order-independent', () => {
    const fs = fakeFs({ '/z': {}, '/a': {} });
    const one = planSkillMounts({ plugins: [{ type: 'local', path: '/z' }, { type: 'local', path: '/a' }], homeDir: HOME, fs });
    const two = planSkillMounts({ plugins: [{ type: 'local', path: '/a' }, { type: 'local', path: '/z' }], homeDir: HOME, fs });
    expect(mountSignature(one.mounts)).toBe(mountSignature(two.mounts));
  });
});

describe('mountSignature / parseMountSignature', () => {
  it('is empty for no mounts and round-trips otherwise', () => {
    expect(mountSignature([])).toBe('');
    expect(parseMountSignature('')).toEqual([]);
    const mounts = [{ hostPath: '/h', guestPath: '/g' }];
    expect(parseMountSignature(mountSignature(mounts))).toEqual(mounts);
  });

  it('returns null for garbage', () => {
    expect(parseMountSignature('{nope')).toBeNull();
  });
});

describe('rewritePluginsForGuest', () => {
  const plan = { mounts: [], pluginGuestPaths: { '/h/a': '/skills/a-1', '/h/b': '/skills/b-2' } };

  it('rewrites mapped plugin paths and preserves other fields', () => {
    const out = rewritePluginsForGuest(
      [{ type: 'local', path: '/h/a' }],
      plan,
      [{ hostPath: '/h/a', guestPath: '/skills/a-1' }],
    );
    expect(out).toEqual([{ type: 'local', path: '/skills/a-1' }]);
  });

  it('drops plugins whose guest path is not actually mounted (stale reused container)', () => {
    const out = rewritePluginsForGuest(
      [{ type: 'local', path: '/h/a' }, { type: 'local', path: '/h/b' }],
      plan,
      [{ hostPath: '/h/b', guestPath: '/skills/b-2' }],
    );
    expect(out).toEqual([{ type: 'local', path: '/skills/b-2' }]);
  });

  it('drops unmapped plugins', () => {
    expect(rewritePluginsForGuest([{ type: 'local', path: '/h/zzz' }], plan, [])).toEqual([]);
  });
});
