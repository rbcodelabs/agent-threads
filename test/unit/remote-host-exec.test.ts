/**
 * host_exec for a thread on the managed local daemon, through the real built-in tool roster and RemoteHostTools:
 * offered only when the daemon's routes turn the `exec` group on, always flagged as needing approval, and run with
 * the handler's validation (the approval card itself is shown by the host-tool executor before the call).
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
import { mapRemoteToLocal } from '../../src/remote/vaultMapping';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'hostexec-')));

function tools(routes: Record<string, 'host' | 'absent'> | undefined, run = vi.fn(async () => ({ exitCode: 0, signal: null, stdout: 'hi\n', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false }))) {
  const servers = createClaudeThreadsMcpServers(app, {
    initialCwd: cwd,
    hostExec: { isInteractive: () => true, requestApproval: async () => true, run },
  });
  const builtIn = (servers.claude_threads as unknown as { harnessTools: never[] }).harnessTools;
  return { host: new RemoteHostTools({ builtIn, overrides: routes }), run };
}

describe('host_exec on the managed daemon', () => {
  it('is not offered unless the exec group (or the tool) is switched on', async () => {
    for (const routes of [undefined, {}, { vault: 'host', misc: 'host', threads: 'host' }] as const) {
      const m = await tools(routes as never).host.manifest();
      expect((m.claude_threads ?? []).map((t) => t.name)).not.toContain('host_exec');
    }
  });

  it('is offered with the exec group and always flagged as requiring approval', async () => {
    const m = await tools({ exec: 'host' }).host.manifest();
    const spec = m.claude_threads.find((t) => t.name === 'host_exec')!;
    expect(spec).toBeDefined();
    expect(spec.requiresApproval).toBe(true);
    expect(m.claude_threads.map((t) => t.name)).toEqual(['host_exec']);
  });

  it('runs a command in the given Mac directory and returns its output; refuses a missing directory', async () => {
    const { host, run } = tools({ exec: 'host' });
    await host.manifest();
    const ok = await host.invoke('claude_threads', 'host_exec', { command: 'echo hi', cwd, reason: 'test' });
    expect(ok.success).toBe(true);
    expect(JSON.parse(ok.text)).toMatchObject({ status: 'approved', exitCode: 0, stdout: 'hi\n', cwd });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'echo hi', cwd }));

    const bad = await host.invoke('claude_threads', 'host_exec', { command: 'ls', cwd: '/nonexistent-dir-xyz', reason: 'test' });
    expect(bad.success).toBe(false);
    expect(JSON.parse(bad.text).error).toContain('not an existing directory');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('defaults the directory to the thread\'s Mac folder', async () => {
    const { host, run } = tools({ exec: 'host' });
    await host.manifest();
    await host.invoke('claude_threads', 'host_exec', { command: 'pwd', reason: 'test' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd }));
  });
});

describe('mapping a container path to the Mac', () => {
  const mapping = { localRoot: '/Users/me/Vault', remoteRoot: '/vault' };
  it('maps paths under the vault mount and nothing else', () => {
    expect(mapRemoteToLocal(mapping, undefined, '/vault/Projects/x')).toBe('/Users/me/Vault/Projects/x');
    expect(mapRemoteToLocal(mapping, undefined, '/vault')).toBe('/Users/me/Vault');
    expect(mapRemoteToLocal(mapping, undefined, '/srv/workspaces/y')).toBeUndefined();
    expect(mapRemoteToLocal(mapping, undefined, '/vault-other/x')).toBeUndefined();
    expect(mapRemoteToLocal(mapping, undefined, undefined)).toBeUndefined();
  });
});
