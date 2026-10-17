/**
 * `enter_worktree` on a daemon: a relative repoPath is a clone under the repo root, the path AND the git root are
 * judged before anything is created, and the agent cannot pick where worktrees go.
 */
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertCwdAllowed } from '../../daemon/sessionPolicy';
import { createCwdTracker } from '../../src/tools/cwdTracker';
import { createWorktreeTools } from '../../src/tools/worktree';
import { git, makeRemote, tempDir } from '../helpers/gitFixtures';

let base: string;
let root: string;

beforeEach(() => {
  base = tempDir('wt-daemon-');
  root = join(base, 'workspace');
  mkdirSync(root);
  git(['clone', makeRemote(base), join(root, 'proj')]);
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

interface Result { success: boolean; worktreePath?: string; gitRoot?: string; error?: string }

function tools(opts: { allowed?: string[]; daemon?: boolean; configured?: string } = {}) {
  const allowed = opts.allowed ?? [root];
  const cwd = createCwdTracker(root);
  const defs = createWorktreeTools({
    cwd,
    options: {
      validateCwd: (p) => assertCwdAllowed(p, { workspaces: allowed, allowBypass: false }),
      getWorktreeRoot: () => opts.configured,
      ...(opts.daemon === false ? {} : { workspaceRoot: root, lockWorktreeRoot: true }),
    },
  });
  const enter = async (args: Record<string, unknown>): Promise<Result> => {
    const out = await (defs.enter_worktree as unknown as { handler(a: unknown, e: unknown): Promise<{ content: Array<{ text: string }> }> }).handler(args, {});
    return JSON.parse(out.content[0].text) as Result;
  };
  return { enter, cwd };
}

describe('enter_worktree on a daemon', () => {
  it('resolves a relative repoPath against the repo root and puts the worktree under <root>/.worktrees', async () => {
    const { enter, cwd } = tools();
    const r = await enter({ repoPath: 'proj', branch: 'feat/x' });
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.gitRoot).toBe(join(root, 'proj'));
    expect(r.worktreePath).toBe(join(root, '.worktrees', 'proj', 'feat', 'x'));
    expect(git(['branch', '--show-current'], r.worktreePath)).toBe('feat/x');
    expect(cwd.get()).toBe(r.worktreePath);
  });

  it('ignores a worktreeRoot the agent supplies', async () => {
    const evil = join(base, 'evil');
    const { enter } = tools();
    const r = await enter({ repoPath: 'proj', branch: 'a', worktreeRoot: evil });
    expect(r.success).toBe(true);
    expect(r.worktreePath!.startsWith(root)).toBe(true);
    expect(existsSync(evil)).toBe(false);
  });

  it('uses the configured root (not the agent\'s) for a repo outside the repo root', async () => {
    const elsewhere = join(base, 'other-ws');
    mkdirSync(elsewhere);
    git(['clone', makeRemote(base, 'second'), join(elsewhere, 'second')]);
    const configured = join(elsewhere, '.wt');
    const { enter } = tools({ allowed: [root, elsewhere], configured });
    const r = await enter({ repoPath: join(elsewhere, 'second'), branch: 'b', worktreeRoot: join(base, 'evil') });
    expect(r.worktreePath).toBe(join(configured, 'second', 'b'));
  });

  it('refuses an absolute repoPath outside the allowed folders without running git there', async () => {
    const outsideRepo = join(base, 'outside');
    git(['clone', makeRemote(base, 'o'), outsideRepo]);
    const { enter } = tools();
    const r = await enter({ repoPath: outsideRepo, branch: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/outside the folders/);
    expect(git(['worktree', 'list'], outsideRepo)).not.toContain('x');
  });

  it('refuses a ../ escape and a symlink that leads out of the workspace', async () => {
    const outsideRepo = join(base, 'outside');
    git(['clone', makeRemote(base, 'o'), outsideRepo]);
    symlinkSync(outsideRepo, join(root, 'link'));
    const { enter } = tools();
    expect((await enter({ repoPath: '../outside', branch: 'x' })).error).toMatch(/outside the folders/);
    expect((await enter({ repoPath: 'link', branch: 'x' })).error).toMatch(/outside the folders/);
    expect(existsSync(join(root, '.worktrees'))).toBe(false);
  });

  it('refuses when the git root lies outside the allowed folders even though the path is inside', async () => {
    // The allowed folder sits inside a repository whose root is above it.
    const outer = join(base, 'outer');
    mkdirSync(join(outer, 'ws', 'proj'), { recursive: true });
    git(['init', '-b', 'main', outer]);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init'], outer);
    const ws = realpathSync(join(outer, 'ws'));
    const cwd = createCwdTracker(ws);
    const defs = createWorktreeTools({ cwd, options: { workspaceRoot: ws, lockWorktreeRoot: true, validateCwd: (p) => assertCwdAllowed(p, { workspaces: [ws], allowBypass: false }) } });
    const out = await (defs.enter_worktree as unknown as { handler(a: unknown, e: unknown): Promise<{ content: Array<{ text: string }> }> }).handler({ repoPath: 'proj', branch: 'x' }, {});
    const r = JSON.parse(out.content[0].text) as Result;
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/outside the folders/);
    expect(existsSync(join(ws, '.worktrees'))).toBe(false);
  });

  it('keeps the old behaviour off the daemon: relative paths are not rewritten and worktreeRoot is honoured', async () => {
    const mine = join(base, 'mine');
    const { enter } = tools({ daemon: false, allowed: [root, mine] });
    const r = await enter({ repoPath: join(root, 'proj'), branch: 'z', worktreeRoot: mine });
    expect(r.worktreePath).toBe(join(mine, 'proj', 'z'));
  });
});
