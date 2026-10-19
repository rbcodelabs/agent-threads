import { describe, expect, it } from 'vitest';
import {
  buildPickerEntries,
  computeProjectLastUsed,
  filterProjects,
  initialHighlight,
  moveHighlight,
  normalizeProjectSort,
  sortProjects,
  type PickerProject,
} from '../../src/projectPickerLogic';

const P = (id: string, name: string, vaultFolder = `Projects/${name}`): PickerProject => ({ id, name, vaultFolder });
const alpha = P('a', 'Alpha');
const beta = P('b', 'beta');
const gamma = P('g', 'Gamma');
const zed = P('z', 'Zed');
const ALL = [zed, gamma, alpha, beta];
const names = (list: readonly PickerProject[]) => list.map((p) => p.name);

describe('normalizeProjectSort', () => {
  it('defaults to recent for missing or unknown values', () => {
    expect(normalizeProjectSort(undefined)).toBe('recent');
    expect(normalizeProjectSort('nonsense')).toBe('recent');
    expect(normalizeProjectSort('alphabetical')).toBe('alphabetical');
  });
});

describe('computeProjectLastUsed', () => {
  it('takes the newest thread activity per project and ignores unassigned threads', () => {
    const map = computeProjectLastUsed([
      { projectId: 'a', updatedAt: 10 },
      { projectId: 'a', updatedAt: 30 },
      { projectId: 'b', updatedAt: 20 },
      { updatedAt: 99 },
    ]);
    expect([...map.entries()].sort()).toEqual([['a', 30], ['b', 20]]);
  });

  it('lets an explicit pick win when it is newer than thread activity, and vice versa', () => {
    const map = computeProjectLastUsed(
      [{ projectId: 'a', updatedAt: 100 }, { projectId: 'b', updatedAt: 5 }],
      { a: 50, b: 500, c: 7 },
    );
    expect(map.get('a')).toBe(100);
    expect(map.get('b')).toBe(500);
    expect(map.get('c')).toBe(7);
  });
});

describe('sortProjects', () => {
  it('alphabetical is case-insensitive and numeric-aware', () => {
    expect(names(sortProjects(ALL, 'alphabetical'))).toEqual(['Alpha', 'beta', 'Gamma', 'Zed']);
    const numbered = [P('1', 'Project 10'), P('2', 'Project 2')];
    expect(names(sortProjects(numbered, 'alphabetical'))).toEqual(['Project 2', 'Project 10']);
  });

  it('recent puts the most recently used first, never-used last (by name)', () => {
    const lastUsed = new Map([['g', 300], ['z', 100]]);
    expect(names(sortProjects(ALL, 'recent', lastUsed))).toEqual(['Gamma', 'Zed', 'Alpha', 'beta']);
  });

  it('recent with no usage data degrades to alphabetical', () => {
    expect(names(sortProjects(ALL, 'recent'))).toEqual(['Alpha', 'beta', 'Gamma', 'Zed']);
  });

  it('does not mutate its input', () => {
    const input = [...ALL];
    sortProjects(input, 'alphabetical');
    expect(input).toEqual(ALL);
  });
});

describe('filterProjects', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(filterProjects(ALL, '')).toEqual(ALL);
    expect(filterProjects(ALL, '   ')).toEqual(ALL);
  });

  it('matches case-insensitively on the name', () => {
    expect(names(filterProjects(ALL, 'GAM'))).toEqual(['Gamma']);
  });

  it('requires every term, in any order', () => {
    const list = [P('1', 'Golden Wealth'), P('2', 'Wealth Tracker'), P('3', 'Golden Gate')];
    expect(names(filterProjects(list, 'wealth golden'))).toEqual(['Golden Wealth']);
  });

  it('also matches the vault folder', () => {
    const list = [P('1', 'Site', 'Work/Acme/Site'), P('2', 'Docs', 'Personal/Docs')];
    expect(names(filterProjects(list, 'acme'))).toEqual(['Site']);
  });

  it('promotes name-prefix matches ahead of substring matches, keeping the incoming order', () => {
    const list = [P('1', 'Big Agent'), P('2', 'Agent Two'), P('3', 'Agent One')];
    expect(names(filterProjects(list, 'agent'))).toEqual(['Agent Two', 'Agent One', 'Big Agent']);
  });

  it('returns nothing when no project matches', () => {
    expect(filterProjects(ALL, 'qqq')).toEqual([]);
  });
});

describe('buildPickerEntries', () => {
  const kinds = (entries: ReturnType<typeof buildPickerEntries>) =>
    entries.map((e) => (e.kind === 'project' ? e.project.name : e.kind));

  it('lists No Project, the sorted projects, then New Project…', () => {
    expect(kinds(buildPickerEntries({ projects: ALL, query: '', mode: 'alphabetical' })))
      .toEqual(['none', 'Alpha', 'beta', 'Gamma', 'Zed', 'new']);
  });

  it('applies the recent sort', () => {
    const lastUsed = new Map([['z', 9]]);
    expect(kinds(buildPickerEntries({ projects: ALL, query: '', mode: 'recent', lastUsed }))[1]).toBe('Zed');
  });

  it('filters projects but always keeps New Project…', () => {
    expect(kinds(buildPickerEntries({ projects: ALL, query: 'gam', mode: 'recent' }))).toEqual(['Gamma', 'new']);
    expect(kinds(buildPickerEntries({ projects: ALL, query: 'qqq', mode: 'recent' }))).toEqual(['new']);
  });

  it('keeps No Project while the query could mean "none", and hides it otherwise', () => {
    expect(kinds(buildPickerEntries({ projects: ALL, query: 'no', mode: 'recent' }))).toContain('none');
    expect(kinds(buildPickerEntries({ projects: ALL, query: 'gam', mode: 'recent' }))).not.toContain('none');
  });

  it('omits No Project when disallowed', () => {
    expect(kinds(buildPickerEntries({ projects: ALL, query: '', mode: 'recent', allowNone: false }))).not.toContain('none');
  });
});

describe('moveHighlight', () => {
  it('wraps in both directions', () => {
    expect(moveHighlight(0, -1, 4)).toBe(3);
    expect(moveHighlight(3, 1, 4)).toBe(0);
    expect(moveHighlight(1, 1, 4)).toBe(2);
  });

  it('starts from the first or last row when nothing is highlighted', () => {
    expect(moveHighlight(-1, 1, 4)).toBe(0);
    expect(moveHighlight(-1, -1, 4)).toBe(3);
  });

  it('returns -1 for an empty list', () => {
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
});

describe('initialHighlight', () => {
  const entries = buildPickerEntries({ projects: ALL, query: '', mode: 'alphabetical' });

  it('highlights the selected project, or No Project when none is selected', () => {
    expect(initialHighlight(entries, 'g', '')).toBe(entries.findIndex((e) => e.kind === 'project' && e.project.id === 'g'));
    expect(initialHighlight(entries, null, '')).toBe(0);
  });

  it('while filtering, highlights the first matching project rather than No Project', () => {
    const filtered = buildPickerEntries({ projects: ALL, query: 'a', mode: 'alphabetical' });
    const index = initialHighlight(filtered, null, 'a');
    expect(filtered[index]).toMatchObject({ kind: 'project' });
  });

  it('falls back to the New Project… row when nothing matches', () => {
    const filtered = buildPickerEntries({ projects: ALL, query: 'qqq', mode: 'alphabetical' });
    expect(filtered[initialHighlight(filtered, null, 'qqq')]).toEqual({ kind: 'new' });
  });
});
