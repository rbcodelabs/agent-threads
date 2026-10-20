import { describe, expect, it } from 'vitest';
import { addNamedRow, buildPickerRows, checkAddByName, isForwardableName, mergeSavedEntries, selectedEntries } from '../../src/remote/pushedSecretPicker';

const sources = {
  envNames: ['GH_TOKEN', 'PATH', 'bad name', 'NPM_TOKEN'],
  keychain: [
    { name: 'NPM_TOKEN', projectIds: [] },
    { name: 'LINEAR_API_KEY', projectIds: ['p2', 'p1'] },
    { name: 'HOME', projectIds: [] },
  ],
  projectName: (id: string) => ({ p1: 'Alpha' } as Record<string, string>)[id],
};

describe('buildPickerRows', () => {
  const rows = buildPickerRows(sources);
  it('offers only names forwardableEnv would forward, ordered by label', () => {
    expect(rows.map((r) => r.entry)).toEqual(['p1/LINEAR_API_KEY', 'GH_TOKEN', 'NPM_TOKEN', 'p2/LINEAR_API_KEY']);
    expect(isForwardableName('PATH')).toBe(false);
    expect(isForwardableName('GH_TOKEN')).toBe(true);
  });
  it('names the project for scoped secrets, falling back to the id', () => {
    expect(rows.find((r) => r.entry === 'p1/LINEAR_API_KEY')!.label).toBe('Alpha / LINEAR_API_KEY');
    expect(rows.find((r) => r.entry === 'p2/LINEAR_API_KEY')!.label).toBe('p2 / LINEAR_API_KEY');
  });
  it('lists a name defined in both places once', () => {
    expect(rows.filter((r) => r.entry === 'NPM_TOKEN')).toHaveLength(1);
  });
  it('is empty with nothing defined', () => {
    expect(buildPickerRows({ envNames: [], keychain: [] })).toEqual([]);
  });
});

describe('mergeSavedEntries', () => {
  const rows = buildPickerRows(sources);
  it('keeps unresolvable saved entries, flagged, after the available ones', () => {
    const merged = mergeSavedEntries(rows, ['GH_TOKEN', 'GONE', 'zz/OLD']);
    expect(merged.slice(0, rows.length)).toEqual(rows);
    expect(merged.slice(rows.length).map((r) => [r.entry, r.found])).toEqual([['GONE', false], ['zz/OLD', false]]);
    expect(merged[rows.length].hint).toMatch(/Not found/);
  });
  it('does not duplicate entries', () => {
    expect(mergeSavedEntries(rows, ['GH_TOKEN', 'GH_TOKEN'])).toHaveLength(rows.length);
  });
});

describe('checkAddByName', () => {
  it('accepts NAME and project/NAME, trimmed', () => {
    expect(checkAddByName('  GH_TOKEN ')).toEqual({ ok: true, entry: 'GH_TOKEN' });
    expect(checkAddByName('proj/NPM_TOKEN')).toEqual({ ok: true, entry: 'proj/NPM_TOKEN' });
  });
  it('rejects without echoing the input', () => {
    const secret = 'ghp_SECRETVALUE123';
    for (const bad of [`GH=${secret}`, `${secret} words`, '1ABC', 'a/b/c', '']) {
      const r = checkAddByName(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).not.toContain('ghp_');
        if (bad) expect(r.reason).not.toContain(bad);
      }
    }
  });
});

describe('selection', () => {
  it('addNamedRow adds a ticked not-found row, or ticks an existing one', () => {
    const rows = buildPickerRows(sources);
    const a = addNamedRow(rows, new Set(), 'NEW_ONE');
    expect(a.rows.at(-1)).toMatchObject({ entry: 'NEW_ONE', found: false });
    expect(a.selected.has('NEW_ONE')).toBe(true);
    const b = addNamedRow(a.rows, a.selected, 'GH_TOKEN');
    expect(b.rows).toHaveLength(a.rows.length);
    expect(b.selected.has('GH_TOKEN')).toBe(true);
  });
  it('selectedEntries returns ticked rows in display order; empty selection is empty', () => {
    const rows = mergeSavedEntries(buildPickerRows(sources), ['GONE']);
    expect(selectedEntries(rows, new Set())).toEqual([]);
    expect(selectedEntries(rows, new Set(['GONE', 'GH_TOKEN']))).toEqual(['GH_TOKEN', 'GONE']);
  });
});
