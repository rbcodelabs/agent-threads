import { describe, expect, it } from 'vitest';
import { CROSS_PROJECT_SPAWN_TOOL } from '../../src/agentThreadCreation';
import { formatToolName, getActivityKind, getToolIcon } from '../../src/toolNameUtils';

describe('host-neutral tool display', () => {
  const codexToolCases = [
    { raw: 'commandExecution', display: 'Bash', icon: 'terminal', activity: 'exploring' },
    { raw: 'fileChange', display: 'Edit', icon: 'file-pen', activity: 'editing' },
    { raw: 'webSearch', display: 'WebSearch', icon: 'search', activity: 'researching' },
    { raw: 'imageView', display: 'View Image', icon: 'image', activity: 'exploring' },
    { raw: 'imageGeneration', display: 'Generate Image', icon: 'image-plus', activity: 'editing' },
  ] as const;

  it.each(codexToolCases)('normalizes Codex $raw records for every display helper', ({ raw, display, icon, activity }) => {
    expect(formatToolName(raw)).toBe(display);
    expect(getToolIcon(raw)).toBe(icon);
    expect(getActivityKind(raw)).toBe(activity);
  });

  it('treats Codex server:tool MCP names like Claude mcp__server__tool names', () => {
    const codexName = 'obsidian:obsidian_search_vault';
    const claudeName = 'mcp__obsidian__obsidian_search_vault';

    expect(formatToolName(codexName)).toBe('search vault');
    expect(getToolIcon(codexName)).toBe('vault');
    expect(getActivityKind(codexName)).toBe('working');
    expect(formatToolName(codexName)).toBe(formatToolName(claudeName));
    expect(getToolIcon(codexName)).toBe(getToolIcon(claudeName));
    expect(getActivityKind(codexName)).toBe(getActivityKind(claudeName));
  });

  it.each([
    { raw: 'custom:commandExecution', display: 'commandExecution' },
    { raw: 'mcp__custom__fileChange', display: 'fileChange' },
  ])('does not apply native Codex aliases across the $raw MCP namespace', ({ raw, display }) => {
    expect(formatToolName(raw)).toBe(display);
    expect(getToolIcon(raw)).toBe('wrench');
    expect(getActivityKind(raw)).toBe('working');
  });

  it('formats canonical fully-qualified names without leaking the server name', () => {
    expect(formatToolName('mcp__claude_threads__vault_search')).toBe('vault search');
    expect(formatToolName('mcp__claude_threads__threads_send_message')).toBe('threads send message');
    expect(getToolIcon('mcp__claude_threads__vault_search')).toBe('vault');
    expect(getActivityKind('mcp__claude_threads__Bash')).toBe('exploring');
  });

  it('keeps legacy display compatibility', () => {
    expect(formatToolName('mcp__obsidian__obsidian_search_vault')).toBe('search vault');
  });
});

describe('cross-project spawn pseudo tool', () => {
  it('renders a friendly label instead of dropping the prefix', () => {
    expect(formatToolName(CROSS_PROJECT_SPAWN_TOOL)).toBe('Spawn thread in another project');
  });

  it('leaves other colon-prefixed tools unchanged', () => {
    expect(formatToolName('threads_create')).toBe('threads create');
    expect(formatToolName('obsidian:obsidian_search_vault')).toBe('search vault');
  });
});
