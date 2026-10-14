import { describe, it, expect } from 'vitest';
import { resolvePlanText, isPlanFilePath, type PlanTextDeps } from '../../src/planText';

const mk = (files: Record<string, string>, newest?: { path: string; mtimeMs: number }, now = 1000): PlanTextDeps => ({
  readFile: (p) => files[p],
  newestPlan: () => newest,
  now: () => now,
});

describe('resolvePlanText', () => {
  it('prefers input.plan', () => {
    expect(resolvePlanText({ plan: 'inline' }, '/a/.claude/plans/x.md', mk({ '/a/.claude/plans/x.md': 'file' }))).toBe('inline');
  });
  it('reads input.planFilePath when plan is absent', () => {
    expect(resolvePlanText({ planFilePath: '/p.md' }, undefined, mk({ '/p.md': 'from file' }))).toBe('from file');
  });
  it('falls back to the plan file the session wrote', () => {
    expect(resolvePlanText({}, '/h/.claude/plans/s.md', mk({ '/h/.claude/plans/s.md': 'written' }))).toBe('written');
  });
  it('falls back to newest plan file when fresh', () => {
    const deps = mk({ '/n.md': 'newest' }, { path: '/n.md', mtimeMs: 900 });
    expect(resolvePlanText({}, undefined, deps)).toBe('newest');
  });
  it('ignores a stale newest plan file', () => {
    const deps = mk({ '/n.md': 'old' }, { path: '/n.md', mtimeMs: 0 }, 7 * 60 * 60 * 1000);
    expect(resolvePlanText({}, undefined, deps)).toBe('');
  });
  it('returns empty when nothing is found', () => {
    expect(resolvePlanText(undefined, undefined, mk({}))).toBe('');
  });
});

describe('isPlanFilePath', () => {
  it('matches plan files only', () => {
    expect(isPlanFilePath('/Users/x/.claude/plans/a-b-c.md')).toBe(true);
    expect(isPlanFilePath('/Users/x/proj/notes.md')).toBe(false);
  });
});
