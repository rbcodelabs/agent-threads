/**
 * Each domain module of the split ObsidianTools is a factory over a narrow port. These tests build every
 * factory with only its own port (no App where it does not take one), check it returns exactly the tools
 * toolNames.ts assigns to the domain, and exercise the pieces that moved or gained a seam.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createMiscTools } from '../../src/tools/misc';
import { createScheduleTools } from '../../src/tools/schedule';
import { createSkillsTools } from '../../src/tools/skills';
import { createThreadTools } from '../../src/tools/threads';
import { createVaultTools } from '../../src/tools/vault';
import { createWorkspaceTools } from '../../src/tools/workspace';
import { createWorktreeTools } from '../../src/tools/worktree';
import { createCwdTracker } from '../../src/tools/cwdTracker';
import { TOOL_NAMES_BY_DOMAIN } from '../../src/tools/toolNames';

const app = {
  plugins: { plugins: {} }, secretStorage: { getSecret: () => null },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb(), getActiveFile: () => null, iterateAllLeaves: () => undefined },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;
const sorted = (o: Record<string, unknown>): string[] => Object.keys(o).sort();
const domain = (d: keyof typeof TOOL_NAMES_BY_DOMAIN, drop: string[] = []): string[] => TOOL_NAMES_BY_DOMAIN[d].filter((n) => !drop.includes(n)).sort();
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
const run = async (tools: Record<string, unknown>, name: string, args: Record<string, unknown> = {}) =>
  (tools[name] as { handler: Handler }).handler(args, {});

describe('domain factories return exactly their domain', () => {
  it('worktree', () => expect(sorted(createWorktreeTools({ cwd: createCwdTracker(), options: {} }))).toEqual(domain('worktree')));
  it('vault', () => expect(sorted(createVaultTools({ app, options: {} }))).toEqual(domain('vault')));
  it('workspace', () => expect(sorted(createWorkspaceTools({ app, options: {} }))).toEqual(domain('workspace')));
  it('threads', () => expect(sorted(createThreadTools({ options: {} }))).toEqual(domain('threads')));
  it('schedule', () => expect(sorted(createScheduleTools({ options: {} }))).toEqual(domain('schedule')));
  it('skills', () => expect(sorted(createSkillsTools({ options: {} }))).toEqual(domain('skills')));
  it('misc', () => expect(sorted(createMiscTools({ app, cwd: createCwdTracker(), options: {} }))).toEqual(domain('misc')));
});

describe('degrade cleanly without their callbacks', () => {
  it('thread tools report an unavailable context instead of throwing', async () => {
    const t = createThreadTools({ options: {} });
    const r = await run(t, 'obsidian_list_threads');
    expect(r.isError).toBe(true);
  });
  it('schedule tools say the scheduler is unavailable', async () => {
    const r = await run(createScheduleTools({ options: {} }), 'CronList');
    expect(r.isError).toBe(true);
  });
  it('vault_list works against a stubbed vault with no host plugin', async () => {
    const r = await run(createVaultTools({ app, options: {} }), 'vault_list', {});
    expect(r.content[0].text).toBeDefined();
  });
});

describe('worktree tools (moved verbatim; now over a cwd tracker and hooks)', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

  function repo(): string {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'at-wt-unit-')));
    const dir = join(root, 'repo');
    mkdirSync(dir);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
    writeFileSync(join(dir, 'f'), '1'); git('add', '.'); git('commit', '-q', '-m', 'i');
    return dir;
  }

  it('enter then exit: tracker, onSetCwd, onWorktreeChanged and the disk all agree', async () => {
    const dir = repo();
    const cwd = createCwdTracker(dir);
    const onSetCwd = vi.fn();
    const onWorktreeChanged = vi.fn();
    const tools = createWorktreeTools({ cwd, options: { onSetCwd, getWorktreeRoot: () => join(root, 'wts') }, onWorktreeChanged });
    const entered = JSON.parse((await run(tools, 'enter_worktree', { branch: 'feat/y' })).content[0].text!);
    expect(entered.success).toBe(true);
    expect(existsSync(join(entered.worktreePath, 'f'))).toBe(true);
    expect(cwd.get()).toBe(entered.worktreePath);
    expect(onSetCwd).toHaveBeenLastCalledWith(entered.worktreePath, dir);
    expect(onWorktreeChanged).toHaveBeenLastCalledWith({ repoPath: dir, worktreePath: entered.worktreePath, branch: 'feat/y' });
    const exited = JSON.parse((await run(tools, 'exit_worktree', {})).content[0].text!);
    expect(exited).toMatchObject({ success: true, restoredCwd: dir });
    expect(existsSync(entered.worktreePath)).toBe(false);
    expect(onSetCwd).toHaveBeenLastCalledWith(dir, null);
    expect(cwd.get()).toBe(dir);
  });

  it('validateCwd can refuse a directory before it is adopted', async () => {
    const dir = repo();
    const cwd = createCwdTracker(dir);
    const onSetCwd = vi.fn();
    const tools = createWorktreeTools({ cwd, options: { onSetCwd, validateCwd: () => { throw new Error('not allowed here'); } } });
    const r = await run(tools, 'set_working_directory', { path: root });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not allowed here');
    expect(cwd.get()).toBe(dir);
    expect(onSetCwd).not.toHaveBeenCalled();
    const e = await run(tools, 'enter_worktree', { branch: 'b' });
    expect(e.isError).toBe(true);
    expect(existsSync(join(root, 'wts'))).toBe(false);
  });

  it('the tracker is shared state with a worktree registry', () => {
    const c = createCwdTracker('/a');
    c.set('/b');
    c.activeWorktrees.set('/b', '/a');
    expect(c.get()).toBe('/b');
    expect(createCwdTracker().get()).toBe('');
  });
});
