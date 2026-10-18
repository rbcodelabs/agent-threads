import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOL_CALL_STYLE,
  formatToolPath,
  formatToolRowSummary,
  normalizeToolCallStyle,
  summarizeToolGroup,
  toolCallStyleClass,
} from '../../src/toolNameUtils';
import { applyToolCallStyleClass } from '../../src/toolCallDom';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ToolCallRecord } from '../../src/types';

const ctx = { vaultRoot: '/Users/alex/Vault', home: '/Users/alex' };
const tool = (name: string, summary = ''): ToolCallRecord => ({ name, summary });

describe('tool call style setting', () => {
  it('defaults to tree', () => {
    expect(DEFAULT_TOOL_CALL_STYLE).toBe('tree');
    expect(DEFAULT_SETTINGS.toolCallStyle).toBe('tree');
  });

  it('normalizes unknown / missing values to tree and keeps valid ones', () => {
    expect(normalizeToolCallStyle(undefined)).toBe('tree');
    expect(normalizeToolCallStyle('bogus')).toBe('tree');
    expect(normalizeToolCallStyle('chips')).toBe('chips');
    expect(normalizeToolCallStyle('cards')).toBe('cards');
  });

  it('applyToolCallStyleClass leaves exactly one ct-tools-* class and swaps live', () => {
    const classes = new Set<string>(['ct-root', 'ct-tools-chips']);
    const root = {
      classList: {
        toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); },
      },
    } as unknown as HTMLElement;
    applyToolCallStyleClass(root, 'cards');
    expect([...classes].sort()).toEqual(['ct-root', 'ct-tools-cards']);
    applyToolCallStyleClass(root, 'tree');
    expect([...classes].sort()).toEqual(['ct-root', toolCallStyleClass('tree')]);
    expect(() => applyToolCallStyleClass(null, 'tree')).not.toThrow();
  });
});

describe('formatToolPath', () => {
  it('makes in-vault paths vault-relative with dim dir + bright file', () => {
    expect(formatToolPath('/Users/alex/Vault/Agent How-Tos/Vault Conventions.md', ctx)).toEqual({
      dir: 'Agent How-Tos/',
      file: 'Vault Conventions.md',
    });
  });
  it('makes paths outside the vault home-relative', () => {
    expect(formatToolPath('/Users/alex/projects/app/src/a.ts', ctx)).toEqual({ dir: '~/projects/app/src/', file: 'a.ts' });
  });
  it('leaves other absolute paths and bare names alone', () => {
    expect(formatToolPath('/etc/hosts', ctx)).toEqual({ dir: '/etc/', file: 'hosts' });
    expect(formatToolPath('README.md', ctx)).toEqual({ dir: '', file: 'README.md' });
  });
  it('does not treat a sibling prefix as inside the vault', () => {
    expect(formatToolPath('/Users/alex/Vault2/x.md', ctx).dir).toBe('~/Vault2/');
  });
  it('tolerates trailing slashes on the roots', () => {
    expect(formatToolPath('/Users/alex/Vault/a.md', { vaultRoot: '/Users/alex/Vault/' })).toEqual({ dir: '', file: 'a.md' });
  });
});

describe('formatToolRowSummary', () => {
  it('formats path tools as paths', () => {
    expect(formatToolRowSummary('Read', '/Users/alex/Vault/Notes/a.md', ctx)).toEqual({ isPath: true, dir: 'Notes/', main: 'a.md' });
    expect(formatToolRowSummary('mcp__claude_threads__vault_get_backlinks', 'Notes/a.md', ctx).isPath).toBe(true);
  });
  it('passes queries and commands through untouched', () => {
    expect(formatToolRowSummary('mcp__claude_threads__vault_search', 'Proxmox Tailscale', ctx)).toEqual({
      isPath: false, dir: '', main: 'Proxmox Tailscale',
    });
    expect(formatToolRowSummary('Bash', 'git status', ctx).isPath).toBe(false);
  });
  it('treats an absolute-looking summary from any tool as a path', () => {
    expect(formatToolRowSummary('Grep', '/Users/alex/projects/x', ctx)).toEqual({ isPath: true, dir: '~/projects/', main: 'x' });
  });
});

describe('summarizeToolGroup', () => {
  it('summarizes reads', () => {
    expect(summarizeToolGroup('exploring', [tool('Read'), tool('Read'), tool('Read')])).toEqual({ label: 'Read 3 files', countInLabel: true });
  });
  it('summarizes mixed exploring', () => {
    expect(summarizeToolGroup('exploring', [tool('Read'), tool('Grep'), tool('Bash'), tool('Bash')]).label)
      .toBe('Read 1 file, searched 1 pattern, ran 2 commands');
  });
  it('summarizes vault searches without a count in the label', () => {
    expect(summarizeToolGroup('working', [tool('mcp__claude_threads__vault_search'), tool('mcp__obsidian__obsidian_search_vault')]))
      .toEqual({ label: 'Searched the vault', countInLabel: false });
  });
  it('summarizes edits, writes and plans', () => {
    expect(summarizeToolGroup('editing', [tool('Edit'), tool('Write')]).label).toBe('Edited 2 files');
    expect(summarizeToolGroup('editing', [tool('Write'), tool('Write')]).label).toBe('Wrote 2 files');
    expect(summarizeToolGroup('planning', [tool('TaskCreate'), tool('TaskUpdate')]).label).toBe('Updated the plan (2 steps)');
  });
});
