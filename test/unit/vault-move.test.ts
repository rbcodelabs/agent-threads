/**
 * vault-move.test.ts: the obsidian_move_path tool (canonical `vault_move`). Same capture strategy as
 * obsidian-tools-vault-bridges.test.ts: mock the SDK `tool` helper and call the handler directly.
 */
import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult>) => ({ _toolName: name, _handler: handler }),
  createSdkMcpServer: ({ tools }: { tools: CapturedTool[] }) => ({ tools }),
}));

import { createObsidianMcpServer } from '../../src/ObsidianTools';
import { validateMovePath } from '../../src/tools/vault';

interface ToolResult { content: [{ type: string; text: string }]; isError?: boolean }
interface CapturedTool { _toolName: string; _handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult> }

function makeApp(fileManager: unknown): App {
  return {
    plugins: { plugins: {} },
    workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { on: () => {} },
    fileManager,
  } as unknown as App;
}

function moveTool(fileManager: unknown): CapturedTool {
  const server = createObsidianMcpServer(makeApp(fileManager)) as unknown as { tools: CapturedTool[] };
  const t = server.tools.find((x) => x._toolName === 'obsidian_move_path');
  if (!t) throw new Error('obsidian_move_path not registered');
  return t;
}

describe('validateMovePath', () => {
  const bad: Array<[string, unknown]> = [
    ['absolute', '/etc/passwd'],
    ['parent segment', 'a/../b.md'],
    ['leading ..', '../b.md'],
    ['empty', ''],
    ['backslash', 'a\\b.md'],
    ['drive letter', 'C:\\x.md'],
    ['drive letter (forward)', 'C:/x.md'],
    ['double slash', 'a//b.md'],
    ['trailing slash', 'a/b/'],
    ['dot segment', 'a/./b.md'],
    ['hidden segment', '.geode/plugins.json'],
    ['hidden nested', 'a/.obsidian/x.md'],
    ['non-string', 42],
  ];
  it.each(bad)('rejects %s', (_label, value) => {
    expect(validateMovePath(value)).toEqual(expect.any(String));
  });
  it('accepts ordinary vault-relative paths', () => {
    expect(validateMovePath('Projects/Alpha')).toBeNull();
    expect(validateMovePath('Notes/a b.md')).toBeNull();
    expect(validateMovePath('a.b/c.md')).toBeNull();
  });
});

describe('obsidian_move_path handler', () => {
  const invalid: Array<[string, { from: string; to: string }]> = [
    ['absolute from', { from: '/abs.md', to: 'b.md' }],
    ['.. in to', { from: 'a.md', to: '../b.md' }],
    ['empty from', { from: '', to: 'b.md' }],
    ['backslash', { from: 'a.md', to: 'x\\b.md' }],
    ['drive', { from: 'a.md', to: 'C:\\b.md' }],
    ['double slash', { from: 'a.md', to: 'x//b.md' }],
    ['trailing slash', { from: 'a/', to: 'b' }],
    ['dot segment', { from: 'a.md', to: '.geode/b.md' }],
    ['same path', { from: 'a.md', to: 'a.md' }],
    ['folder into itself', { from: 'Projects/Alpha', to: 'Projects/Alpha/Sub' }],
  ];
  it.each(invalid)('rejects %s without calling the host', async (_l, args) => {
    const moveWithLinkUpdate = vi.fn();
    const r = await moveTool({ moveWithLinkUpdate })._handler(args);
    expect(r.isError).toBe(true);
    expect(moveWithLinkUpdate).not.toHaveBeenCalled();
  });

  it('returns a clear isError when the host lacks moveWithLinkUpdate (no silent fallback)', async () => {
    const renameFile = vi.fn();
    const r = await moveTool({ renameFile })._handler({ from: 'a.md', to: 'b.md' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/does not support link-updating moves/);
    expect(renameFile).not.toHaveBeenCalled();
  });

  it('is an isError (not a throw) when fileManager is missing entirely', async () => {
    const r = await moveTool(undefined)._handler({ from: 'a.md', to: 'b.md' });
    expect(r.isError).toBe(true);
  });

  it('calls the host with the paths as given and returns moved/updatedNotes', async () => {
    const result = { moved: [{ from: 'Projects/Alpha', to: 'Archive/Alpha' }], updatedNotes: ['Inbox/x.md'] };
    const moveWithLinkUpdate = vi.fn().mockResolvedValue(result);
    const r = await moveTool({ moveWithLinkUpdate })._handler({ from: 'Projects/Alpha', to: 'Archive/Alpha' });
    expect(r.isError).toBeUndefined();
    expect(moveWithLinkUpdate).toHaveBeenCalledExactlyOnceWith('Projects/Alpha', 'Archive/Alpha');
    expect(JSON.parse(r.content[0].text)).toEqual(result);
  });

  it('surfaces a host error as isError text', async () => {
    const moveWithLinkUpdate = vi.fn().mockRejectedValue(new Error('Target already exists: b.md'));
    const r = await moveTool({ moveWithLinkUpdate })._handler({ from: 'a.md', to: 'b.md' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Target already exists: b.md');
  });
});
