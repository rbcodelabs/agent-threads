import { describe, expect, it, vi } from 'vitest';
import {
  buildContainerListArgs,
  selectOrphanedThreadContainers,
  sweepOrphanedThreadContainers,
} from '../../src/sandboxVmSweep';
import type { VmCommandRunner } from '../../src/sandboxVm';

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

function runnerFor(listing: string, rmExit: (name: string) => number = () => 0) {
  const calls: string[][] = [];
  const run: VmCommandRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return ok(listing);
    if (args[0] === 'rm') return { exitCode: rmExit(args[args.length - 1]), stdout: '', stderr: 'boom' };
    return ok();
  };
  return { run, calls, removed: () => calls.filter((a) => a[0] === 'rm').map((a) => a[a.length - 1]) };
}

describe('selectOrphanedThreadContainers', () => {
  it('selects only prefix-matching containers without a live thread', () => {
    const listing = [
      'claude-threads-vm-live-1',
      'claude-threads-vm-dead-2',
      'claude-threads-harness',
      'claude-threads-internal',
      'postgres',
      'claude-threads-vm-',
      'claude-threads-vm-Bad_Name',
      'other-claude-threads-vm-x',
      '',
    ].join('\n');
    expect(selectOrphanedThreadContainers(listing, ['live-1'])).toEqual(['claude-threads-vm-dead-2']);
  });

  it('matches live threads through the same sanitization as containerNameForThread', () => {
    expect(selectOrphanedThreadContainers('claude-threads-vm-my-thread', ['My Thread'])).toEqual([]);
  });
});

describe('sweepOrphanedThreadContainers', () => {
  it('removes orphaned matching containers and leaves live and unrelated ones alone', async () => {
    const r = runnerFor('claude-threads-vm-live\nclaude-threads-vm-orphan\nredis\nclaude-threads-coding\n');
    const result = await sweepOrphanedThreadContainers({ run: r.run, liveThreadIds: ['live'] });
    expect(r.calls[0]).toEqual(buildContainerListArgs());
    expect(r.removed()).toEqual(['claude-threads-vm-orphan']);
    expect(result.removed).toEqual(['claude-threads-vm-orphan']);
    expect(result.failed).toEqual([]);
  });

  it('removes nothing when there are no live threads (could be a state-load failure)', async () => {
    const r = runnerFor('claude-threads-vm-a\n');
    const result = await sweepOrphanedThreadContainers({ run: r.run, liveThreadIds: [] });
    expect(r.calls).toEqual([]);
    expect(result.skippedReason).toBeDefined();
  });

  it('skips when the list command fails', async () => {
    const run: VmCommandRunner = async () => ({ exitCode: 1, stdout: 'claude-threads-vm-a', stderr: 'xpc' });
    const result = await sweepOrphanedThreadContainers({ run, liveThreadIds: ['x'] });
    expect(result.removed).toEqual([]);
    expect(result.skippedReason).toMatch(/exited 1/);
  });

  it('does not throw when the runner rejects', async () => {
    const run: VmCommandRunner = async () => { throw new Error('ENOENT'); };
    await expect(sweepOrphanedThreadContainers({ run, liveThreadIds: ['x'] })).resolves.toMatchObject({
      removed: [],
      skippedReason: 'ENOENT',
    });
  });

  it('records a failed removal and continues with the rest', async () => {
    const r = runnerFor('claude-threads-vm-a\nclaude-threads-vm-b\n', (n) => (n.endsWith('-a') ? 1 : 0));
    const log = vi.fn();
    const result = await sweepOrphanedThreadContainers({ run: r.run, liveThreadIds: ['live'], log });
    expect(result.failed).toEqual(['claude-threads-vm-a']);
    expect(result.removed).toEqual(['claude-threads-vm-b']);
    expect(log).toHaveBeenCalledOnce();
  });

  it('treats a rejected rm as a failure, not a throw', async () => {
    const run: VmCommandRunner = async (args) => {
      if (args[0] === 'list') return ok('claude-threads-vm-a\n');
      throw new Error('spawn');
    };
    const result = await sweepOrphanedThreadContainers({ run, liveThreadIds: ['live'] });
    expect(result.failed).toEqual(['claude-threads-vm-a']);
  });
});
