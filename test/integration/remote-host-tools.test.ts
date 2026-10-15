/**
 * Host tools end to end on the plugin side: real daemon (scripted harness driving the real MCP handlers),
 * real DaemonClient, real RemoteHarnessSession + HostToolExecutor, a fake in-process "vault" behind
 * RemoteHostTools. Covers: the call executing in the plugin handler and the answer returning, approval
 * gating, a call outside the manifest, caps, detach/reconnect, and the unavailable notice.
 */
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { HarnessDynamicTool, HarnessSessionOptions } from '../../src/HarnessSession';
import { CALLBACK_DISPOSITION } from '../../src/protocol';
import { DaemonClient, type WebSocketFactory } from '../../src/remote/DaemonClient';
import { RemoteHarnessSession, type RemoteSessionDeps } from '../../src/remote/RemoteHarnessSession';
import { RemoteHostTools } from '../../src/remote/hostTools';
import type { HostMcpSource } from '../../src/remote/hostMcpClient';
import type { Thread } from '../../src/types';
import { startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const wsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const daemon = async (opts: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> => {
  const td = await startTestDaemon(opts);
  cleanups.push(() => td.cleanup());
  return td;
};
const client = (td: TestDaemon, instanceId = 'geode-1'): DaemonClient => {
  const c = new DaemonClient({
    url: td.daemon.url, getToken: () => td.adminToken, createSocket: wsFactory, clientVersion: '0.62.2',
    backoffMs: [20, 40, 80], ackDebounceMs: 20, idleProbeMs: 60_000, instanceId,
  });
  cleanups.push(() => c.dispose());
  return c;
};
const thread = (id: string): Thread => ({
  id, title: id, cwd: '/srv/workspaces/x', messages: [], createdAt: 0, updatedAt: 0, status: 'waiting', agentHarness: 'claude',
  remote: { daemonId: 'd1', ownership: 'client', remoteCwd: '/srv/workspaces/x', lastSeq: 0, ownerClientId: 'geode-test' },
} as Thread);

interface Rec { messages: string[]; prompts: Array<{ toolName: string; detail: string; answer(allow: boolean): void }>; autoAllow: boolean; callbacks: SessionCallbacks; done: number }
function recorder(): Rec {
  const r: Rec = { messages: [], prompts: [], autoAllow: false, done: 0, callbacks: {} as SessionCallbacks };
  const cb: Record<string, unknown> = {};
  for (const name of Object.keys(CALLBACK_DISPOSITION)) cb[name] = () => undefined;
  r.callbacks = {
    ...cb,
    onMessage: (content: string) => { r.messages.push(content); },
    onDone: () => { r.done++; },
    onPermissionRequest: (toolName: string, detail: string) => new Promise<boolean>((resolve) => {
      if (r.autoAllow) { resolve(true); return; }
      r.prompts.push({ toolName, detail, answer: resolve });
    }),
  } as unknown as SessionCallbacks;
  return r;
}
const options = (r: Rec): HarnessSessionOptions => ({ cwd: '/srv/workspaces/x', permissionMode: 'default', extraEnvRaw: '', callbacks: r.callbacks });
async function until(pred: () => boolean, what: string, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The groups these tests exercise, switched on explicitly: host tools are opt-in per group. */
const ON = { vault: 'host', threads: 'host', workspace: 'host', mcp: 'host' } as const;
const dyn = (name: string, requiresApproval: boolean, invoke: HarnessDynamicTool['invoke']): HarnessDynamicTool =>
  ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, requiresApproval, invoke });

function make(td: TestDaemon, id: string, tools: HarnessDynamicTool[], extra: Partial<RemoteSessionDeps> = {}, mcpSources: Record<string, HostMcpSource> = {}) {
  const t = thread(id);
  const r = recorder();
  const hostTools = new RemoteHostTools({ builtIn: tools, mcpSources, overrides: ON });
  const notices: string[] = [];
  const session = new RemoteHarnessSession(client(td), t, { hostTools, onNotice: (_s, text) => notices.push(text), replayedCallSettleMs: 30, ...extra });
  return { t, r, session, notices, hostTools };
}

describe('host tools: plugin executes what the daemon proxies', () => {
  it('runs a vault search in the plugin handler and the model gets the answer', async () => {
    const td = await daemon();
    const invoke = vi.fn(async (args: Record<string, unknown>) => ({ success: true, text: `hits for ${String(args.query)}: Daily/2026-10-14.md` }));
    const { r, session } = make(td, 'h1', [dyn('vault_search', false, invoke)]);
    await session.start(options(r));
    session.send('/mcp claude_threads vault_search {"query":"alpha"}', undefined, 'u1');
    await until(() => r.messages.length > 0, 'the model-visible answer');
    expect(invoke).toHaveBeenCalledWith({ query: 'alpha' });
    expect(r.messages[0]).toBe('mcp ok: hits for alpha: Daily/2026-10-14.md');
    session.close();
  });

  it('offers only host-routed tools: worktree tools stay on the daemon, VM tools are absent, unknown tools are absent', async () => {
    const td = await daemon();
    const noop = async () => ({ success: true, text: '' });
    const { r, session } = make(td, 'h2', [dyn('vault_search', false, noop), dyn('enter_worktree', false, noop), dyn('enter_vm', false, noop), dyn('my_peer_tool', false, noop)]);
    await session.start(options(r));
    session.send('/mcp-list claude_threads', undefined, 'u1');
    await until(() => r.messages.length > 0, 'tool list');
    // enter_worktree is the daemon's own local tool; enter_vm / my_peer_tool never reach the manifest.
    expect(r.messages[0]).toBe('tools: enter_worktree,exit_worktree,set_working_directory,vault_search');
    session.close();
  });

  it('a tool that requires approval prompts in Geode, and a denial reaches the model', async () => {
    const td = await daemon();
    const invoke = vi.fn(async () => ({ success: true, text: 'archived' }));
    const { r, session } = make(td, 'h3', [dyn('threads_get_log', true, invoke)]);
    await session.start(options(r));
    session.send('/mcp claude_threads threads_get_log {}', undefined, 'u1');
    await until(() => r.prompts.length === 1, 'the approval card');
    expect(r.prompts[0].toolName).toBe('mcp__claude_threads__threads_get_log');
    r.prompts[0].answer(false);
    await until(() => r.messages.length > 0, 'answer');
    expect(r.messages[0]).toBe('mcp error: The user denied this tool call.');
    expect(invoke).not.toHaveBeenCalled();
    session.close();
  });

  it('an approved call runs once; a second call asks again', async () => {
    const td = await daemon();
    const invoke = vi.fn(async () => ({ success: true, text: 'archived' }));
    const { r, session } = make(td, 'h4', [dyn('threads_get_log', true, invoke)]);
    await session.start(options(r));
    session.send('/mcp claude_threads threads_get_log {}', undefined, 'u1');
    await until(() => r.prompts.length === 1, 'card 1');
    r.prompts[0].answer(true);
    await until(() => r.messages.length === 1, 'first answer');
    expect(r.messages[0]).toBe('mcp ok: archived');
    await until(() => !session.turnInFlight, 'turn end');
    session.send('/mcp claude_threads threads_get_log {}', undefined, 'u2');
    await until(() => r.prompts.length === 2, 'card 2');
    r.prompts[1].answer(true);
    await until(() => r.messages.length === 2, 'second answer');
    expect(invoke).toHaveBeenCalledTimes(2);
    session.close();
  });

  it('a permission card the daemon wrote can never authorize a host tool: the plugin still shows its own card', async () => {
    const td = await daemon();
    const invoke = vi.fn(async () => ({ success: true, text: 'ok' }));
    const { r, session } = make(td, 'h5', [dyn('threads_get_log', true, invoke)]);
    await session.start(options(r));
    // The daemon (or whatever drives it) opens a card and the user clicks Allow on it.
    session.send('/permission', undefined, 'u0');
    await until(() => r.prompts.length === 1, 'daemon-side card');
    r.prompts[0].answer(true);
    await until(() => !session.turnInFlight, 'turn end');
    session.send('/mcp claude_threads threads_get_log {}', undefined, 'u1');
    await until(() => r.prompts.length === 2, 'the plugin\'s own card');
    expect(r.prompts[1].toolName).toBe('mcp__claude_threads__threads_get_log');
    expect(invoke).not.toHaveBeenCalled(); // nothing ran on the strength of the first click
    r.prompts[1].answer(true);
    await until(() => r.messages.length === 2, 'tool answer');
    expect(invoke).toHaveBeenCalledTimes(1);
    session.close();
  });

  it('refuses, and never runs, an approval-gated call whose input is longer than the card can show', async () => {
    const td = await daemon();
    const invoke = vi.fn(async () => ({ success: true, text: 'RAN' }));
    const { r, session } = make(td, 'h5b', [dyn('threads_get_log', true, invoke)]);
    await session.start(options(r));
    session.send(`/mcp claude_threads threads_get_log ${JSON.stringify({ query: 'x'.repeat(5000) })}`, undefined, 'u1');
    await until(() => r.messages.length > 0, 'the refusal');
    expect(r.messages[0]).toMatch(/too long to show the user in full/);
    expect(r.prompts).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
    session.close();
  });

  it('an observer (a second install without the seat) neither executes tool.call nor overwrites the manifest', async () => {
    const td = await daemon();
    const inv1 = vi.fn(async () => ({ success: true, text: 'from controller' }));
    const inv2 = vi.fn(async () => ({ success: true, text: 'from observer' }));
    const a = make(td, 'h5c', [dyn('vault_search', false, inv1)]);
    await a.session.start(options(a.r));
    // A different install, same thread and token: it attaches read-only and must stay passive.
    const t2 = thread('h5c');
    const r2 = recorder();
    const obsTools = new RemoteHostTools({ builtIn: [dyn('vault_search', false, inv2), dyn('vault_list', false, inv2)], overrides: ON });
    const obs = new RemoteHarnessSession(client(td, 'geode-2'), t2, { hostTools: obsTools, replayedCallSettleMs: 30 });
    await obs.start(options(r2), { attachOnly: true });
    await until(() => (obs as unknown as { controller: boolean | null }).controller === false, 'observer attach');
    a.session.send('/mcp claude_threads vault_search {}', undefined, 'u1');
    await until(() => a.r.messages.length > 0, 'controller answer');
    await new Promise((res) => setTimeout(res, 200));
    expect(inv1).toHaveBeenCalledTimes(1);
    expect(inv2).not.toHaveBeenCalled();
    expect(td.daemon.threads.hostTools.manifest('h5c').claude_threads.map((t) => t.name)).toEqual(['vault_search']);
    obs.close();
    a.session.close();
  });

  it('refuses a tool.call for something outside the manifest it sent, even though the daemon asked', async () => {
    const td = await daemon();
    const invoke = vi.fn(async () => ({ success: true, text: 'SHOULD NOT RUN' }));
    const { r, session } = make(td, 'h6', [dyn('vault_search', false, async () => ({ success: true, text: 'fine' }))]);
    await session.start(options(r));
    // A compromised daemon forges a call for a tool the plugin never offered (including a dangerous-looking one).
    const evil = dyn('threads_get_log', true, invoke);
    void evil;
    td.daemon.threads.hostTools.setManifest('h6', { claude_threads: [{ name: 'threads_get_log', description: '', inputSchema: {}, requiresApproval: false, server: 'claude_threads' }] });
    const outcome = await td.daemon.threads.hostTools.call('h6', 'claude_threads', 'threads_get_log', {});
    expect(outcome.success).toBe(false);
    expect(outcome.text).toContain('is not offered in this session');
    expect(invoke).not.toHaveBeenCalled();
    expect(r.prompts).toHaveLength(0);
    session.close();
  });

  it('proxies a Google broker tool under its own server name; the loopback source never leaks', async () => {
    const td = await daemon();
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'doc body' }] }));
    const source: HostMcpSource = {
      listTools: async () => [{ name: 'read_doc', description: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
      callTool, close: async () => undefined,
    };
    const { r, session } = make(td, 'h7', [], {}, { 'google-docs': source });
    await session.start(options(r));
    session.send('/mcp google-docs read_doc {"query":"d1"}', undefined, 'u1');
    await until(() => r.messages.length > 0, 'answer');
    expect(r.messages[0]).toBe('mcp ok: doc body');
    expect(callTool).toHaveBeenCalledWith('read_doc', { query: 'd1' }, expect.anything());
    session.close();
  });

  it('shows one inline notice when Geode was away and a host tool could not run', async () => {
    const td = await daemon({ hostToolGraceMs: 150 });
    const { r, session, notices } = make(td, 'h8', [dyn('vault_search', false, async () => ({ success: true, text: 'x' }))]);
    await session.start(options(r));
    session.send('/mcp delay=100 claude_threads vault_search {}', undefined, 'u1');
    await until(() => session.turnInFlight, 'turn start');
    session.detach(); // Geode quits mid-turn
    await new Promise((res) => setTimeout(res, 600));

    // Reopen Geode: a fresh session re-attaches and replays what happened meanwhile.
    const t2 = { ...thread('h8'), remote: { ...thread('h8').remote!, turnPending: true, lastSeq: 0 } } as Thread;
    const r2 = recorder();
    const s2 = new RemoteHarnessSession(client(td, 'geode-1'), t2, {
      hostTools: new RemoteHostTools({ builtIn: [dyn('vault_search', false, async () => ({ success: true, text: 'x' }))], overrides: ON }),
      onNotice: (_s, text) => notices.push(text), replayedCallSettleMs: 30, hostName: 'Geode',
    });
    await s2.start(options(r2), { attachOnly: true });
    await until(() => notices.length > 0, 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Host tools unavailable');
    expect(notices[0]).toContain('claude_threads/vault_search');
    expect(notices[0]).toContain('Geode');
    expect(r.messages).toHaveLength(0);
    s2.close();
  });

  it('does not re-run a call that already finished when its history is replayed', async () => {
    const td = await daemon();
    const invoke = vi.fn(async () => ({ success: true, text: 'once' }));
    const first = make(td, 'h9', [dyn('vault_search', false, invoke)]);
    await first.session.start(options(first.r));
    first.session.send('/mcp claude_threads vault_search {}', undefined, 'u1');
    await until(() => first.r.messages.length > 0, 'answer');
    first.session.detach();
    // A new session with NO cursor replays the whole journal, tool.call included.
    const t2 = thread('h9');
    const r2 = recorder();
    const s2 = new RemoteHarnessSession(client(td, 'geode-1'), t2, { hostTools: new RemoteHostTools({ builtIn: [dyn('vault_search', false, invoke)], overrides: ON }), replayedCallSettleMs: 80 });
    await s2.start(options(r2), { attachOnly: true });
    await until(() => r2.messages.length > 0, 'replayed message');
    await new Promise((res) => setTimeout(res, 250));
    expect(invoke).toHaveBeenCalledTimes(1);
    s2.close();
  });
});
