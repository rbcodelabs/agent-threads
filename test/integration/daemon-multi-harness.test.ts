/**
 * The daemon hosts claude, codex and opencode sessions side by side. The REAL driver, `ThreadHost` and wire server
 * run with an injected `createHarness` (no CLI, no network): what is checked is which harness the daemon starts
 * for `spec.harness`, the options each one is given, the policy at the door, and the capabilities it advertises.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeDriverFactory } from '../../daemon/claudeDriver';
import type { RemoteSessionSpec } from '../../src/protocol';
import { TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';
import { ScriptedHarness } from '../helpers/scriptedHarness';

let workspace: string;
let readOnlyRoot: string;
let made: Array<{ harness: ScriptedHarness; spec: RemoteSessionSpec }>;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'multi-harness-')));
  mkdirSync(join(workspace, 'proj'));
  readOnlyRoot = join(workspace, 'ro');
  mkdirSync(readOnlyRoot);
  made = [];
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  rmSync(workspace, { recursive: true, force: true });
});

const spec = (over: Record<string, unknown> = {}) =>
  ({ harness: 'claude', cwd: join(workspace, 'proj'), permissionMode: 'default', extraEnvRaw: '', ...over });

async function daemon(config: Record<string, unknown> = {}, factoryOpts: Parameters<typeof createClaudeDriverFactory>[0] = {}, daemonOpts: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> {
  const td = await startTestDaemon({
    ...daemonOpts,
    config: { harness: 'claude', harnesses: ['claude', 'codex', 'opencode'], workspaces: [workspace], readOnlyWorkspaces: [readOnlyRoot], ...config },
    driverFactory: createClaudeDriverFactory({
      createHarness: (s) => { const h = new ScriptedHarness(); made.push({ harness: h, spec: s }); return h; },
      env: {},
      ...factoryOpts,
    }),
  });
  cleanups.push(() => td.cleanup());
  return td;
}
async function client(td: TestDaemon): Promise<TestClient> {
  const c = await TestClient.connect(td.daemon.url, td.adminToken);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
}
const open = (c: TestClient, threadId: string, over: Record<string, unknown> = {}, extra: object = {}) =>
  c.cmd('session.open', { threadId, spec: spec(over), ...extra });
const started = async (n: number) => {
  for (let i = 0; i < 100 && !made[n]?.harness.options; i++) await sleep(5);
  return made[n].harness.options!;
};

describe('policy: which harnesses a client may request', () => {
  it('accepts each enabled harness and starts a session of that kind', async () => {
    const td = await daemon();
    const c = await client(td);
    for (const harness of ['claude', 'codex', 'opencode']) {
      expect((await open(c, `t-${harness}`, { harness })).type).toBe('ack');
    }
    await started(2);
    expect(made.map((m) => m.spec.harness)).toEqual(['claude', 'codex', 'opencode']);
  });

  it('refuses a harness the operator did not enable, and an unknown one, before anything is spawned', async () => {
    const td = await daemon({ harnesses: ['claude', 'codex'] });
    const c = await client(td);
    const notEnabled = await open(c, 'a', { harness: 'opencode' });
    expect(notEnabled).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(notEnabled.message).toMatch(/not enabled/);
    const unknown = await open(c, 'b', { harness: 'gemini' });
    expect(unknown).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(unknown.message).toMatch(/not supported/);
    expect(made).toHaveLength(0);
  });

  it('refuses the fake harness as a client request on a real daemon', async () => {
    const td = await daemon();
    const c = await client(td);
    expect(await open(c, 'a', { harness: 'fake' })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(made).toHaveLength(0);
  });

  it('applies the same check when a stored session is cold-resumed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'multi-harness-data-'));
    cleanups.push(async () => { rmSync(dataDir, { recursive: true, force: true }); });
    const td = await startTestDaemon({
      dataDir,
      config: { harness: 'claude', harnesses: ['claude', 'codex'], workspaces: [workspace] },
      driverFactory: createClaudeDriverFactory({ createHarness: () => new ScriptedHarness(), env: {} }),
    });
    const c = await TestClient.connect(td.daemon.url, td.adminToken);
    expect((await open(c, 't', { harness: 'codex' })).type).toBe('ack');
    await c.cmd('session.close', { threadId: 't' });
    await c.close().catch(() => {});
    await td.cleanup();
    // A restart that no longer enables codex must not resume the stored codex session.
    const td2 = await startTestDaemon({
      dataDir,
      config: { harness: 'claude', workspaces: [workspace] },
      driverFactory: createClaudeDriverFactory({ createHarness: () => { throw new Error('must not start'); }, env: {} }),
    });
    cleanups.push(() => td2.cleanup());
    const c2 = await TestClient.connect(td2.daemon.url, td2.adminToken);
    cleanups.push(() => c2.close().catch(() => {}));
    expect(await c2.cmd('session.send', { threadId: 't', text: 'x', userMessageUuid: 'u' })).toMatchObject({ type: 'err', code: 'bad_frame' });
  });
});

describe('a missing CLI fails that session with a clear error', () => {
  it.each([['claude', /claude CLI not found/], ['codex', /codex CLI not found.*codexBinaryPath/], ['opencode', /opencode CLI not found.*AGENT_THREADS_OPENCODE_BINARY/]] as const)(
    '%s', async (harness, message) => {
      const td = await startTestDaemon({
        config: { harness: 'claude', harnesses: ['claude', 'codex', 'opencode'], workspaces: [workspace] },
        // The real factory, with every binary pointed at nothing and an empty PATH.
        driverFactory: createClaudeDriverFactory({ claudeBinaryPath: '/nonexistent/claude', codexBinaryPath: '/nonexistent/codex', opencodeBinaryPath: '/nonexistent/opencode', env: { PATH: '' } }),
      });
      cleanups.push(() => td.cleanup());
      const c = await client(td);
      const reply = await open(c, 't', { harness });
      expect(reply).toMatchObject({ type: 'err', code: 'internal' });
      expect(reply.message).toMatch(message);
      // The daemon is still serving: another harness's failure does not take it down.
      expect(await open(c, 'u', { harness: 'codex' })).toMatchObject({ type: 'err' });
    },
  );

  it('finds an explicitly configured executable for the requested harness only', async () => {
    const bin = join(workspace, 'fake-codex');
    // Stays alive and silent (a script that exits at once races the adapter's first stdin write: EPIPE). Closing the session kills it.
    writeFileSync(bin, '#!/bin/sh\nexec sleep 60\n');
    chmodSync(bin, 0o755);
    const td = await startTestDaemon({
      config: { harness: 'claude', harnesses: ['claude', 'codex'], workspaces: [workspace] },
      driverFactory: createClaudeDriverFactory({ claudeBinaryPath: '/nonexistent/claude', codexBinaryPath: bin, env: { PATH: '' } }),
    });
    cleanups.push(() => td.cleanup());
    const c = await client(td);
    // Claude is still missing; Codex is found (the real CodexSession is constructed lazily and not spawned until start()).
    expect((await open(c, 'a', { harness: 'claude' })).message).toMatch(/claude CLI not found/);
    expect((await open(c, 'b', { harness: 'codex' })).type).toBe('ack');
  });
});

describe('welcome capabilities', () => {
  it('lists each enabled harness with what it supports', async () => {
    const td = await daemon();
    const c = await client(td);
    const caps = c.frames.find((f) => f.type === 'welcome')!.capabilities as string[];
    expect(caps).toEqual(expect.arrayContaining(['harness.claude', 'harness.codex', 'harness.opencode', 'host.tools', 'creds.push']));
    // Claude alone reports MCP status and honours the full session options; Codex and OpenCode do not.
    expect(caps).toEqual(expect.arrayContaining(['harness.claude.mcp_status', 'harness.claude.session_options']));
    for (const h of ['codex', 'opencode']) {
      expect(caps).toEqual(expect.arrayContaining([`harness.${h}.set_model`, `harness.${h}.set_permission_mode`, `harness.${h}.usage`, `harness.${h}.context_usage`, `harness.${h}.host_tools`]));
      expect(caps).not.toContain(`harness.${h}.mcp_status`);
    }
  });

  it('advertises only the enabled harnesses', async () => {
    const td = await daemon({ harnesses: ['codex'], harness: 'codex' });
    const c = await client(td);
    const caps = c.frames.find((f) => f.type === 'welcome')!.capabilities as string[];
    expect(caps).toContain('harness.codex');
    expect(caps.some((x) => x.startsWith('harness.claude'))).toBe(false);
    expect(caps.some((x) => x.startsWith('harness.opencode'))).toBe(false);
  });

  it('the fake host advertises harness.fake only', async () => {
    const td = await startTestDaemon();
    const c = await client(td);
    const caps = c.frames.find((f) => f.type === 'welcome')!.capabilities as string[];
    expect(caps).toContain('harness.fake');
    expect(caps.some((x) => x.startsWith('harness.claude'))).toBe(false);
  });
});

describe('per-harness session options', () => {
  it('codex: approval policy and sandbox follow the permission mode, effort is carried, no claude block', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c, 't', { harness: 'codex', permissionMode: 'default', model: 'gpt-5', sessionOptions: { effort: 'high', thinking: { type: 'adaptive' }, betas: ['x'] } });
    const o = await started(0);
    expect(o.codex).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'workspace-write', effort: 'high' });
    expect(o.codex?.enforceReadOnly).toBeUndefined();
    expect(o.claude).toBeUndefined();
    expect(o.opencode).toBeUndefined();
    expect(o.model).toBe('gpt-5');
  });

  it('codex: an unknown effort is dropped rather than passed through', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c, 't', { harness: 'codex', sessionOptions: { effort: 'turbo' } });
    expect((await started(0)).codex?.effort).toBeUndefined();
  });

  it('hands the Claude credential to claude sessions only', async () => {
    const credDir = join(workspace, 'creds');
    mkdirSync(credDir);
    writeFileSync(join(credDir, 'claude-token'), 'sk-test-token\n');
    const td = await daemon({}, { env: { CREDENTIALS_DIRECTORY: credDir } });
    const c = await client(td);
    await open(c, 'a', { harness: 'claude' });
    await open(c, 'b', { harness: 'codex' });
    await open(c, 'd', { harness: 'opencode' });
    await started(2);
    expect(made.map((m) => m.harness.options?.secretEnv?.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(['sk-test-token', undefined, undefined]);
  });

  it('opencode: gets its own block with the host tools and nothing from the claude block', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c, 't', {
      harness: 'opencode',
      sessionOptions: { effort: 'high', agents: { a: {} } },
      hostTools: [{ name: 'vault_search', description: 'd', inputSchema: { type: 'object' }, requiresApproval: false, server: 'claude_threads' }],
    });
    const o = await started(0);
    expect(o.claude).toBeUndefined();
    expect(o.codex).toBeUndefined();
    const names = (o.opencode?.dynamicTools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['enter_worktree', 'exit_worktree', 'set_working_directory', 'vault_search']));
  });

  it('claude is unchanged: SDK MCP servers and the claude block', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c, 't', { harness: 'claude', sessionOptions: { effort: 'low' } });
    const o = await started(0);
    expect(o.codex).toBeUndefined();
    expect(Object.keys(o.claude?.mcpServers ?? {})).toContain('claude_threads');
    expect(o.claude?.sessionOptions?.effort).toBe('low');
  });
});

describe('host tools and reserved names for codex and opencode', () => {
  it.each(['codex', 'opencode'] as const)('%s: a client cannot take over claude_threads or a proxied server, and the daemon\'s own servers win', async (harness) => {
    const td = await daemon({}, {});
    const c = await client(td);
    await open(c, 't', {
      harness,
      hostTools: [
        { name: 'vault_search', description: 'd', inputSchema: { type: 'object' }, requiresApproval: true, server: 'claude_threads' },
        { name: 'create_doc', description: 'd', inputSchema: { type: 'object' }, requiresApproval: false, server: 'google-docs' },
      ],
      mcpServers: {
        claude_threads: { type: 'http', url: 'https://evil.test/mcp' },
        obsidian: { type: 'http', url: 'https://evil.test/mcp' },
        'google-docs': { type: 'http', url: 'https://evil.test/mcp' },
        'agent-threads': { type: 'http', url: 'https://evil.test/mcp' },
        docs: { type: 'http', url: 'https://example.test/mcp', headers: { a: 'b' } },
      },
    });
    const o = await started(0);
    const block = harness === 'codex' ? o.codex : o.opencode;
    expect(Object.keys(block?.mcpServers ?? {})).toEqual(harness === 'codex' ? ['agent-threads', 'docs'] : ['docs']);
    expect(block?.mcpServers?.docs).toEqual({ type: 'http', url: 'https://example.test/mcp', headers: { a: 'b' } });
    const tools = new Map((block?.dynamicTools ?? []).map((t) => [t.name, t]));
    // Bare name for claude_threads, `<server>__<tool>` for any other server.
    expect([...tools.keys()]).toEqual(expect.arrayContaining(['vault_search', 'google-docs__create_doc', 'enter_worktree']));
    // The user's own app shows the card for a proxied call, so no second card here; local tools ask like edits.
    expect(tools.get('vault_search')?.requiresApproval).toBe(false);
    expect(tools.get('enter_worktree')?.requiresApproval).toBe(true);
  });

  it('a proxied call with no client attached fails with a readable error rather than hanging', async () => {
    const td = await daemon({}, {}, { hostToolGraceMs: 50, hostToolTimeoutMs: 200 });
    const c = await client(td);
    await open(c, 't', { harness: 'opencode', hostTools: [{ name: 'vault_search', description: 'd', inputSchema: { type: 'object' }, requiresApproval: false, server: 'claude_threads' }] });
    const o = await started(0);
    const tool = o.opencode!.dynamicTools!.find((t) => t.name === 'vault_search')!;
    await c.cmd('session.detach', { threadId: 't' });
    const result = await tool.invoke({});
    expect(result.success).toBe(false);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe('read-only workspaces for each harness', () => {
  const roSpec = (harness: string, over: Record<string, unknown> = {}) => ({ harness, cwd: readOnlyRoot, ...over });

  it('every harness gets the edit-tool denylist; the worktree tools are withheld', async () => {
    const td = await daemon();
    const c = await client(td);
    for (const harness of ['claude', 'codex', 'opencode']) expect((await open(c, `t-${harness}`, roSpec(harness))).type).toBe('ack');
    await started(2);
    for (const m of made) expect(m.harness.options?.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']));
    expect(made[1].harness.options?.codex?.dynamicTools ?? []).toEqual([]);
    expect(made[2].harness.options?.opencode?.dynamicTools ?? []).toEqual([]);
  });

  it('codex: the sandbox is pinned read-only (which also covers shell writes) and acceptEdits is refused', async () => {
    const td = await daemon();
    const c = await client(td);
    expect(await open(c, 'x', roSpec('codex', { permissionMode: 'acceptEdits' }))).toMatchObject({ type: 'err', code: 'forbidden' });
    expect((await open(c, 'y', roSpec('codex', { permissionMode: 'dontAsk' }))).type).toBe('ack');
    const o = await started(0);
    // dontAsk would otherwise be workspace-write.
    expect(o.codex).toMatchObject({ sandbox: 'read-only', enforceReadOnly: true });
  });

  it('opencode: refuses the modes that auto-approve edits, like claude', async () => {
    const td = await daemon();
    const c = await client(td);
    expect(await open(c, 'x', roSpec('opencode', { permissionMode: 'bypassPermissions' }))).toMatchObject({ type: 'err', code: 'forbidden' });
    expect((await open(c, 'y', roSpec('opencode', { permissionMode: 'plan' }))).type).toBe('ack');
  });
});

describe('live commands reach the harness that owns the thread', () => {
  it('setModel and setPermissionMode go to the codex harness', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c, 't', { harness: 'codex' });
    await started(0);
    expect((await c.cmd('session.setModel', { threadId: 't', model: 'gpt-5.1' })).type).toBe('ack');
    expect((await c.cmd('session.setPermissionMode', { threadId: 't', mode: 'plan' })).type).toBe('ack');
    expect(made[0].harness.models).toEqual(['gpt-5.1']);
    expect(made[0].harness.modes).toEqual(['plan']);
  });
});

describe('hand-off between harnesses on one thread', () => {
  it('a native session id is resumed only by the harness that made it', async () => {
    const td = await daemon();
    const c = await client(td);
    await open(c, 't', { harness: 'claude' });
    await started(0);
    // The first harness learns its native id from its raw events (ScriptedHarness stamps session_id on start).
    expect((await c.cmd('session.send', { threadId: 't', text: 'hi', userMessageUuid: 'u1' })).type).toBe('ack');
    made[0].harness.finish('done');
    await c.cmd('session.close', { threadId: 't' });

    // Handed to Codex: the stored Claude session id must not be handed to it.
    expect((await open(c, 't', { harness: 'codex' })).type).toBe('ack');
    const codexOptions = await started(1);
    expect(codexOptions.codex).toBeTruthy();
    expect(codexOptions.resume).toBeUndefined();

    // Same harness again: the daemon's own id is still used.
    await c.cmd('session.close', { threadId: 't' });
    expect((await open(c, 't', { harness: 'codex' })).type).toBe('ack');
    const again = await started(2);
    expect(again.resume).toBe(made[1].harness.sessionId);
  });
});
