import { describe, it, expect } from 'vitest';
import type { VmCommandResult, VmCommandRunner } from '../../src/containerCli';
import { LocalDaemonAbortedError, pruneStaleDaemonImages, type StepDeps } from '../../src/localDaemon/provision';

const GHCR = 'ghcr.io/rbcodelabs/agent-threads-daemon';
const LOCAL = 'agent-threads-daemon-local';
const ok = (stdout = ''): VmCommandResult => ({ exitCode: 0, stdout, stderr: '' });

function setup(listing: string, rm: (ref: string) => VmCommandResult | Promise<VmCommandResult> = () => ok(), signal?: AbortSignal) {
  const calls: string[] = [];
  const runner: VmCommandRunner = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'image' && args[1] === 'list') return ok(listing);
    if (args[0] === 'image' && args[1] === 'rm') return rm(args[2]);
    return { exitCode: 1, stdout: '', stderr: 'unexpected' };
  };
  const d = { runner, report: () => undefined, ...(signal ? { signal } : {}) } as unknown as StepDeps;
  return { d, calls, removed: () => calls.filter((c) => c.startsWith('image rm ')).map((c) => c.slice('image rm '.length)) };
}

describe('pruneStaleDaemonImages', () => {
  it('removes old published and local images and keeps the current ones and unrelated repos', async () => {
    const listing = [
      `${GHCR}:0.69.0`, `${GHCR}:0.70.2`, `${LOCAL}:0.69.0`, `${LOCAL}:0.68.0-claude-codex`,
      `${LOCAL}:0.70.2`, `${LOCAL}:0.70.2-claude-codex-opencode`, `${LOCAL}:0.70.20`, 'node:22', 'claude-threads-sandbox:1',
      'ghcr.io/apple/container-builder-shim/builder:0.6.1', '',
    ].join('\n');
    const t = setup(listing);
    const removed = await pruneStaleDaemonImages(t.d, '0.70.2');
    const expected = [`${GHCR}:0.69.0`, `${LOCAL}:0.69.0`, `${LOCAL}:0.68.0-claude-codex`, `${LOCAL}:0.70.20`];
    expect(removed).toEqual(expected);
    expect(t.removed()).toEqual(expected);
  });

  it('does not throw when an image rm fails (in use), and reports only what was removed', async () => {
    const t = setup(`${LOCAL}:0.1.0\n${GHCR}:0.1.0\n`, (ref) => (ref.startsWith(LOCAL)
      ? { exitCode: 1, stdout: '', stderr: 'image in use' }
      : ok()));
    await expect(pruneStaleDaemonImages(t.d, '0.70.2')).resolves.toEqual([`${GHCR}:0.1.0`]);
    expect(t.removed()).toHaveLength(2);
  });

  it('does not throw when image rm itself throws, or when the listing fails', async () => {
    const t = setup(`${LOCAL}:0.1.0\n`, () => { throw new Error('spawn failed'); });
    await expect(pruneStaleDaemonImages(t.d, '0.70.2')).resolves.toEqual([]);
    const d = { runner: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }), report: () => undefined } as unknown as StepDeps;
    await expect(pruneStaleDaemonImages(d, '0.70.2')).resolves.toEqual([]);
  });

  it('still honours an abort', async () => {
    const ac = new AbortController();
    ac.abort();
    const t = setup(`${LOCAL}:0.1.0\n`, () => ok(), ac.signal);
    await expect(pruneStaleDaemonImages(t.d, '0.70.2')).rejects.toBeInstanceOf(LocalDaemonAbortedError);
  });
});
