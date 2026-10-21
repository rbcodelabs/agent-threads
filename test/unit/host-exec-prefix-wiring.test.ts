/**
 * Standing host_exec prefix approval, end to end through the real built-in roster, RemoteHostTools and the
 * HostToolExecutor gate: a saved prefix skips the card for a plain matching command and nothing else, every
 * other call still asks, and no daemon-supplied value can turn the skip on.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';
import { RemoteHostTools } from '../../src/remote/hostTools';
import { HostToolExecutor, HostToolSlots } from '../../src/remote/hostToolExecutor';
import { matchesHostExecPrefix } from '../../src/hostExecPrefix';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'hostexec-prefix-')));
const ran = { exitCode: 0, signal: null, stdout: 'ok', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false };

/** Mirrors the main.ts wiring: the same predicate shape, reading a mutable prefix list and scheduled flag. */
async function rig(state: { prefixes: string[]; scheduled?: boolean }) {
  const run = vi.fn(async () => ran);
  const servers = createClaudeThreadsMcpServers(app, {
    initialCwd: cwd,
    hostExec: { isInteractive: () => !state.scheduled, requestApproval: async () => true, run },
  });
  const builtIn = (servers.claude_threads as unknown as { harnessTools: never[] }).harnessTools;
  const host = new RemoteHostTools({
    builtIn,
    overrides: { exec: 'host' },
    preApprove: (tool, input) =>
      tool === 'host_exec' && !state.scheduled && typeof input.command === 'string' && matchesHostExecPrefix(input.command, state.prefixes),
  });
  const manifest = await host.manifest();
  const results: Array<{ success: boolean; text: string }> = [];
  const requestPermission = vi.fn(async () => false);
  const ex = new HostToolExecutor({
    manifest: () => manifest,
    invoke: (s, t, i, sig) => host.invoke(s, t, i, sig),
    requestPermission,
    isPreApproved: (s, t, i) => host.isPreApproved(s, t, i),
    slots: new HostToolSlots(),
    sendResult: async (_id, r) => { results.push(r); },
  });
  let n = 0;
  const call = async (command: string, extra: Record<string, unknown> = {}) => {
    ex.handleCall({ callId: `c${++n}`, threadId: 't', server: 'claude_threads', tool: 'host_exec', input: { command, cwd, reason: 'r', ...extra } });
    await new Promise((r) => setTimeout(r, 15));
    return results[results.length - 1];
  };
  return { call, run, requestPermission, host };
}

describe('host_exec saved-prefix approval on the managed daemon', () => {
  it('runs a matching plain command without a card', async () => {
    const t = await rig({ prefixes: ['git status'] });
    const r = await t.call('git status -sb');
    expect(r.success).toBe(true);
    expect(t.requestPermission).not.toHaveBeenCalled();
    expect(t.run).toHaveBeenCalledOnce();
  });

  it('still shows the card for non-matching, chained, quoted, env-prefixed, path-qualified or denylisted commands', async () => {
    const t = await rig({ prefixes: ['git status', 'ls', 'curl', 'bash'] });
    for (const cmd of ['git push', 'git status; id', 'git status "x"', 'FOO=1 ls', '/bin/ls', 'curl example.com', 'bash -c ls', 'gitk']) {
      const r = await t.call(cmd);
      expect(r.success).toBe(false);
      expect(r.text).toContain('denied');
    }
    expect(t.requestPermission).toHaveBeenCalledTimes(8);
    expect(t.run).not.toHaveBeenCalled();
  });

  it('a revoke applies to the next call', async () => {
    const state = { prefixes: ['ls'] };
    const t = await rig(state);
    expect((await t.call('ls')).success).toBe(true);
    state.prefixes = [];
    expect((await t.call('ls')).success).toBe(false);
    expect(t.requestPermission).toHaveBeenCalledOnce();
  });

  it('scheduled or headless threads get no pre-approval, and the handler still refuses them', async () => {
    const t = await rig({ prefixes: ['ls'], scheduled: true });
    const r = await t.call('ls');
    expect(r.success).toBe(false);
    expect(t.requestPermission).toHaveBeenCalledOnce();
    expect(t.run).not.toHaveBeenCalled();
  });

  it('is only ever consulted for the built-in claude_threads server', async () => {
    const t = await rig({ prefixes: ['ls'] });
    expect(t.host.isPreApproved('claude_threads', 'host_exec', { command: 'ls' })).toBe(true);
    expect(t.host.isPreApproved('google-docs', 'host_exec', { command: 'ls' })).toBe(false);
    expect(t.host.isPreApproved('claude_threads', 'vault_write_file', { command: 'ls' })).toBe(false);
  });

  it('an executor without the hook, or one that throws, falls back to the card', async () => {
    const manifest = { claude_threads: [{ name: 'host_exec', description: 'd', inputSchema: { type: 'object' }, requiresApproval: true, server: 'claude_threads' }] };
    const requestPermission = vi.fn(async () => true);
    const invoke = vi.fn(async () => ({ success: true, text: 'x' }));
    for (const isPreApproved of [undefined, () => { throw new Error('boom'); }]) {
      requestPermission.mockClear();
      const ex = new HostToolExecutor({
        manifest: () => manifest, invoke, requestPermission, slots: new HostToolSlots(), sendResult: async () => {},
        ...(isPreApproved ? { isPreApproved } : {}),
      });
      ex.handleCall({ callId: `x${String(isPreApproved)}`, threadId: 't', server: 'claude_threads', tool: 'host_exec', input: { command: 'ls' } });
      await new Promise((r) => setTimeout(r, 10));
      expect(requestPermission).toHaveBeenCalledOnce();
    }
  });

  it('input too long for any card still runs when its prefix is saved: no card is shown, so nothing is unseen', async () => {
    const t = await rig({ prefixes: ['echo'] });
    const r = await t.call('echo ' + 'x'.repeat(100_000));
    expect(r.success).toBe(true);
    expect(t.run).toHaveBeenCalledOnce();
  });
});
