import { describe, it, expect } from 'vitest';
import {
  buildProjectOverviewContext,
  composeAppendSystemPrompt,
  isValidOverviewPath,
  readProjectOverview,
  resolveProjectOverviewPath,
} from '../../src/projectOverview';

const project = { vaultFolder: 'Work/Acme' };

function compose(proj: { vaultFolder: string; overviewPath?: string } | undefined, files: Record<string, string>, goalContext = '') {
  const overview = readProjectOverview(proj, p => files[p]);
  return composeAppendSystemPrompt({
    envContext: 'ENV',
    projectDesc: 'DESC',
    overviewContext: buildProjectOverviewContext(overview),
    goalContext,
  });
}

describe('project overview', () => {
  it('defaults to <vaultFolder>/_overview.md', () => {
    expect(resolveProjectOverviewPath(project)).toBe('Work/Acme/_overview.md');
    expect(resolveProjectOverviewPath({ vaultFolder: 'Work/Acme/' })).toBe('Work/Acme/_overview.md');
  });

  it('injects the note under a heading with the grounding line when present', () => {
    const out = compose(project, { 'Work/Acme/_overview.md': '# Acme\nBig picture.\n' });
    expect(out).toContain('## Project overview (Work/Acme/_overview.md)');
    expect(out).toContain('grounding context');
    expect(out).toContain('vault_search');
    expect(out).toContain('Big picture.');
  });

  it('injects nothing when the file is missing', () => {
    expect(compose(project, {})).toBe('ENV\n\nDESC');
  });

  it('swallows read errors', () => {
    const overview = readProjectOverview(project, () => { throw new Error('EACCES'); });
    expect(overview).toBeUndefined();
  });

  it('uses a custom overviewPath', () => {
    const out = compose({ ...project, overviewPath: 'Other/Home.md' }, {
      'Work/Acme/_overview.md': 'default',
      'Other/Home.md': 'custom body',
    });
    expect(out).toContain('## Project overview (Other/Home.md)');
    expect(out).toContain('custom body');
    expect(out).not.toContain('default');
  });

  it('rejects paths that escape the vault', () => {
    expect(readProjectOverview({ ...project, overviewPath: '../secret.md' }, () => 'x')).toBeUndefined();
  });

  it('injects nothing without a project', () => {
    expect(compose(undefined, { 'Work/Acme/_overview.md': 'x' })).toBe('ENV\n\nDESC');
  });

  it('orders env, description, overview, then goal', () => {
    const out = compose(project, { 'Work/Acme/_overview.md': 'OVERVIEW' }, 'GOAL');
    const idx = ['ENV', 'DESC', '## Project overview', 'OVERVIEW', 'GOAL'].map(s => out.indexOf(s));
    expect(idx.every(i => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe('isValidOverviewPath', () => {
  it('accepts empty and vault-relative paths', () => {
    for (const ok of ['', '  ', 'Notes/o.md', 'a b/c.md']) expect(isValidOverviewPath(ok)).toBe(true);
  });
  it('rejects absolute, drive-letter and .. paths', () => {
    for (const bad of ['/etc/passwd', '\\\\srv\\x', 'C:\\x.md', '../x.md', 'a/../../x.md', 'a\\..\\x.md']) expect(isValidOverviewPath(bad)).toBe(false);
  });
});
