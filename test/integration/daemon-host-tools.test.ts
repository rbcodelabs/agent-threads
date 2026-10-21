/**
 * Host-tool proxying over a real daemon and real sockets, with the scripted fake harness driving the SAME
 * MCP server handlers Claude reaches (`/mcp <server> <tool> <json>`): local worktree tools run on the
 * daemon, manifest tools are proxied to the attached client as `tool.call` -> `tool.result`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClient, sleep, startTestDaemon, type Frame, type TestDaemon } from '../helpers/daemonTestClient';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const track = async (opts?: Parameters<typeof startTestDaemon>[0]): Promise<TestDaemon> => {
  const td = await startTestDaemon(opts);
  cleanups.push(() => td.cleanup());
  return td;
};
const connect = async (td: TestDaemon, helloExtra: object = {}): Promise<TestClient> => {
  const c = await TestClient.connect(td.daemon.url, td.adminToken, {}, helloExtra);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
};

const SPEC = { harness: 'claude', cwd: '/srv/workspaces/x', permissionMode: 'default', extraEnvRaw: '' };
const tool = (name: string, server = 'claude_threads', requiresApproval = false) =>
  ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, requiresApproval, server });

async function open(c: TestClient, threadId: string, hostTools = [tool('vault_search')], spec: object = SPEC): Promise<void> {
  expect((await c.cmd('session.open', { threadId, spec: { ...spec, hostTools } })).type).toBe('ack');
  await c.cmd('attach', { ch: `t:${threadId}`, afterSeq: 0 });
}
let sendCounter = 0;
const send = (c: TestClient, threadId: string, text: string) => c.cmd('session.send', { threadId, text, userMessageUuid: `u-${++sendCounter}` });
const lastMessage = async (c: TestClient, after = 0): Promise<string> => (await c.waitFor((f) => f.name === 'onMessage' && f.seq > after, 8000, 'onMessage')).args[0] as string;

describe('host tool round trip', () => {
  it('lists local worktree tools plus the manifest tools under the claude_threads server', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't', [tool('vault_search'), tool('threads_list')]);
    await send(c, 't', '/mcp-list claude_threads');
    expect(await lastMessage(c)).toBe('tools: enter_worktree,exit_worktree,set_working_directory,threads_list,vault_search');
  });

  it('proxies a call to the attached client and returns its answer to the harness', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp claude_threads vault_search {"query":"alpha"}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    expect(call.args).toMatchObject({ threadId: 't', server: 'claude_threads', tool: 'vault_search', input: { query: 'alpha' } });
    expect(call.args.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'found: Daily/2026-10-14.md' })).type).toBe('ack');
    expect(await lastMessage(c)).toBe('mcp ok: found: Daily/2026-10-14.md');
    expect((await c.waitFor((f) => f.name === 'request_resolved' && f.args.requestId === call.args.callId)).args).toMatchObject({ outcome: 'resolved' });
  });

  it('reports a failed host tool as an error the model can read', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp claude_threads vault_search {}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: false, text: 'vault is locked' });
    expect(await lastMessage(c)).toBe('mcp error: vault is locked');
  });

  it('a second answer to the same call is refused', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp claude_threads vault_search {}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'one' });
    expect(await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'two' })).toMatchObject({ type: 'err', code: 'not_found' });
  });

  it('truncates an oversized result with a marker instead of passing it on whole', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp claude_threads vault_search {}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'x'.repeat(1_500_000) });
    const text = await lastMessage(c);
    expect(text.length).toBeLessThan(110_000); // cut at the 100K result limit plus the marker
    expect(text).toContain('output truncated');
  });

  it('refuses a tool that is not in the manifest, without ever asking the client', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp claude_threads threads_archive {}');
    expect(await lastMessage(c)).toContain('mcp error: Unknown tool: threads_archive');
    expect(c.events().some((f) => f.name === 'tool.call')).toBe(false);
  });

  it('proxies MCP resources of a proxied server end to end (list, templates, read) and advertises none for claude_threads', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't', [tool('get_doc', 'compass'), tool('vault_search')]);
    const answer = async (tl: string, text: string, success = true): Promise<Frame> => {
      const call = await c.waitFor((f) => f.name === 'tool.call' && f.args.tool === tl && !answered.has(f.seq as number));
      answered.add(call.seq as number);
      await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success, text });
      return call;
    };
    const answered = new Set<number>();

    await send(c, 't', '/mcp-res-list compass');
    const listCall = await answer('resources/list', JSON.stringify({ resources: [{ uri: 'docs://w/a%20b.md', name: 'A B', mimeType: 'text/markdown' }] }));
    expect(listCall.args).toMatchObject({ server: 'compass', input: {} });
    expect(await lastMessage(c)).toContain('"uri":"docs://w/a%20b.md"');

    let after = c.events().filter((f) => f.name === 'onMessage').length ? Math.max(...c.events().filter((f) => f.name === 'onMessage').map((f) => f.seq as number)) : 0;
    await send(c, 't', '/mcp-res-read compass docs://w/a%20b.md');
    const readCall = await answer('resources/read', JSON.stringify({ contents: [{ uri: 'docs://w/a%20b.md', mimeType: 'text/markdown', text: '# Hello' }] }));
    expect(readCall.args).toMatchObject({ server: 'compass', input: { uri: 'docs://w/a%20b.md' } });
    expect(await lastMessage(c, after)).toContain('# Hello');

    after = Math.max(...c.events().filter((f) => f.name === 'onMessage').map((f) => f.seq as number));
    await send(c, 't', '/mcp-res-read compass docs://w/missing');
    await answer('resources/read', 'Resource not found: docs://w/missing', false);
    expect(await lastMessage(c, after)).toMatch(/mcp error:.*Resource not found/);

    after = Math.max(...c.events().filter((f) => f.name === 'onMessage').map((f) => f.seq as number));
    await send(c, 't', '/mcp-res-list claude_threads');
    expect(await lastMessage(c, after)).toMatch(/mcp error:/);
  });

  it('follows a manifest update on a running session', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    const reply = await c.cmd('tool.manifest', { threadId: 't', servers: { claude_threads: [tool('vault_search'), tool('workspace_get_open_tabs')] } });
    expect(reply).toMatchObject({ type: 'ack', result: { changed: true, tools: 2 } });
    await send(c, 't', '/mcp-list claude_threads');
    expect(await lastMessage(c)).toContain('workspace_get_open_tabs');
    expect(await c.cmd('tool.manifest', { threadId: 't', servers: { claude_threads: [tool('vault_search'), tool('workspace_get_open_tabs')] } }))
      .toMatchObject({ result: { changed: false } });
  });

  it('proxies other servers under their own names', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't', [tool('vault_search'), tool('read_doc', 'google-docs')]);
    await send(c, 't', '/mcp google-docs read_doc {"query":"d1"}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    expect(call.args).toMatchObject({ server: 'google-docs', tool: 'read_doc' });
    await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'doc body' });
    expect(await lastMessage(c)).toBe('mcp ok: doc body');
  });

  it('sanitizes structured content: only bounded images reach the model', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp claude_threads vault_search {}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    const reply = await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'ok', content: [{ type: 'resource', uri: 'file:///etc/passwd' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    expect(reply.type).toBe('ack');
    expect(await lastMessage(c)).toBe('mcp ok: ok');
  });
});

describe('servers that appear after the session started', () => {
  it('a manifest naming a new server makes it reachable on the next send', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    // The fake harness builds its servers on first use; this send pins them to the opening manifest.
    await send(c, 't', '/mcp-list claude_threads');
    const seq = (await c.waitFor((f) => f.name === 'onMessage')).seq;
    const reply = await c.cmd('tool.manifest', { threadId: 't', servers: { claude_threads: [tool('vault_search')], vercel: [tool('list_projects', 'vercel')] } });
    expect(reply).toMatchObject({ type: 'ack', result: { changed: true } });
    await send(c, 't', '/mcp vercel list_projects {}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    expect(call.args).toMatchObject({ server: 'vercel', tool: 'list_projects' });
    await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'projects' });
    expect(await lastMessage(c, seq)).toBe('mcp ok: projects');
  });

  it('a new server arriving mid-turn applies to the following send, not the running turn', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp claude_threads vault_search {}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    await c.cmd('tool.manifest', { threadId: 't', servers: { claude_threads: [tool('vault_search')], vercel: [tool('list_projects', 'vercel')] } });
    await c.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'first' });
    const seq = (await c.waitFor((f) => f.name === 'onMessage')).seq;
    expect(await lastMessage(c)).toBe('mcp ok: first');
    await send(c, 't', '/mcp-list vercel');
    expect(await lastMessage(c, seq)).toContain('list_projects');
  });

  it('open() on a live session adopts server names it did not have', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp-list claude_threads');
    const seq = (await c.waitFor((f) => f.name === 'onMessage')).seq;
    await open(c, 't', [tool('vault_search'), tool('list_projects', 'vercel')]);
    await send(c, 't', '/mcp-list vercel');
    expect(await lastMessage(c, seq)).toContain('list_projects');
  });
});

describe('binding and authority', () => {
  it('a call id from another thread cannot be answered through a different thread', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 'a');
    await open(c, 'b');
    await send(c, 'a', '/mcp claude_threads vault_search {}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    expect(await c.cmd('tool.result', { threadId: 'b', callId: call.args.callId, success: true, text: 'spoof' })).toMatchObject({ type: 'err', code: 'not_found' });
    await c.cmd('tool.result', { threadId: 'a', callId: call.args.callId, success: true, text: 'real' });
    expect(await lastMessage(c)).toBe('mcp ok: real');
  });

  it('only the client holding the thread seat can answer or change the manifest', async () => {
    const td = await track();
    const owner = await connect(td, { instanceId: 'owner' });
    const other = await connect(td, { instanceId: 'other' });
    await open(owner, 't');
    await send(owner, 't', '/mcp claude_threads vault_search {}');
    const call = await owner.waitFor((f) => f.name === 'tool.call');
    expect(await other.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'spoof' })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect(await other.cmd('tool.manifest', { threadId: 't', servers: {} })).toMatchObject({ type: 'err', code: 'forbidden' });
    await owner.cmd('tool.result', { threadId: 't', callId: call.args.callId, success: true, text: 'real' });
    expect(await lastMessage(owner)).toBe('mcp ok: real');
  });

  it('once a terminal claims the seat, host tool calls fail fast instead of waiting for an answer that cannot come', async () => {
    const td = await track({ hostToolGraceMs: 200, hostToolTimeoutMs: 60_000 });
    const geode = await connect(td, { instanceId: 'geode' });
    await open(geode, 't'); // Geode holds the seat and sent the manifest
    // Geode goes away (its manifest stays on the daemon); `attach --claim` / `run --thread` then claims the free seat.
    await geode.cmd('session.detach', { threadId: 't' });
    const cli = await connect(td, { instanceId: 'cli-1' });
    const attached = await cli.cmd('attach', { ch: 't:t', afterSeq: 0 });
    expect(attached).toMatchObject({ type: 'ack', result: { controller: true } });
    expect(td.daemon.threads.hostTools.isAttached('t')).toBe(false); // the seat holder never offered these tools
    const started = Date.now();
    await send(cli, 't', '/mcp claude_threads vault_search {}');
    const msg = await lastMessage(cli);
    expect(msg).toContain("The user's Geode is not connected");
    expect(Date.now() - started).toBeLessThan(5000); // grace, not the 60 s answer timeout
    expect(cli.events().some((f) => f.name === 'tool.call')).toBe(false); // never issued to a client that cannot answer
    // Geode takes the seat back by re-attaching and sending its manifest: host tools work again.
    await cli.cmd('session.detach', { threadId: 't' });
    await geode.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await geode.cmd('tool.manifest', { threadId: 't', servers: { claude_threads: [tool('vault_search')] } });
    expect(td.daemon.threads.hostTools.isAttached('t')).toBe(true);
  });

  it('a read-scope token cannot send manifests or results', async () => {
    const td = await track();
    const read = td.daemon.tokens.create('r', 'read').token;
    const r = await TestClient.connect(td.daemon.url, read);
    cleanups.push(() => r.close().catch(() => {}));
    expect(await r.cmd('tool.result', { threadId: 't', callId: 'x', success: true, text: '' })).toMatchObject({ type: 'err', code: 'forbidden' });
    expect(await r.cmd('tool.manifest', { threadId: 't', servers: {} })).toMatchObject({ type: 'err', code: 'forbidden' });
  });

  it('rejects malformed manifests and results at the codec', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    const bad = [
      { servers: { 'bad name': [] } },
      { servers: { s: [{ ...tool('x'), server: 'other' }] } },
      { servers: { s: [{ ...tool('../x', 's'), name: '../x' }] } },
      { servers: { s: [{ ...tool('x', 's'), inputSchema: 'nope' }] } },
      { servers: { s: [{ ...tool('x', 's'), description: 'd'.repeat(9000) }] } },
    ];
    for (const b of bad) expect(await c.cmd('tool.manifest', { threadId: 't', ...b }), JSON.stringify(b).slice(0, 60)).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(await c.cmd('tool.result', { threadId: 't', callId: 'x', success: true, text: 'a'.repeat(8_000_001) })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(await c.cmd('tool.result', { threadId: 't', callId: 'x', success: true, text: 'a', content: [1] })).toMatchObject({ type: 'err', code: 'bad_frame' });
  });

  it('caps open calls per thread', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    for (let i = 0; i < 9; i++) td.daemon.threads.hostTools.call('t', 'claude_threads', 'vault_search', {}).catch(() => {});
    await sleep(100);
    expect(c.events().filter((f) => f.name === 'tool.call')).toHaveLength(8);
    const ninth = await td.daemon.threads.hostTools.call('t', 'claude_threads', 'vault_search', {});
    expect(ninth).toMatchObject({ success: false });
    expect(ninth.text).toContain('Too many host tool calls');
  });

  it('refuses an oversized input to the model instead of truncating it', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    const out = await td.daemon.threads.hostTools.call('t', 'claude_threads', 'vault_search', { query: 'q'.repeat(300_000) });
    expect(out).toMatchObject({ success: false });
    expect(out.text).toContain('too large');
    expect(c.events().some((f) => f.name === 'tool.call')).toBe(false);
  });
});

describe('detached grace', () => {
  it('fails after the grace period with a structured, readable error and journals tool.unavailable', async () => {
    const td = await track({ hostToolGraceMs: 200 });
    const c = await connect(td, { instanceId: 'g' });
    await open(c, 't');
    // The call happens 150 ms after the send; by then the client is gone.
    await send(c, 't', '/mcp delay=150 claude_threads vault_search {}');
    c.kill();
    await c.closed;
    const d = await connect(td, { instanceId: 'g' });
    const started = Date.now();
    await d.cmd('attach', { ch: 't:t', afterSeq: 0 });
    // Stay attached for the replay only: give the seat up so nobody serves host tools.
    await d.cmd('session.detach', { threadId: 't' });
    await sleep(80);
    const e = await connect(td, { instanceId: 'g' });
    await e.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await e.cmd('session.detach', { threadId: 't' });
    await sleep(500);
    const f = await connect(td, { instanceId: 'g' });
    await f.cmd('attach', { ch: 't:t', afterSeq: 0 }); // replay what happened while nobody was attached
    const msg = await lastMessage(f);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(msg).toContain("mcp error: The user's Geode is not connected");
    expect(msg).toContain('vault_search');
    expect(f.events().find((x) => x.name === 'tool.unavailable')?.args).toMatchObject({ server: 'claude_threads', tool: 'vault_search', reason: 'detached' });
  });

  it('waits for a reconnect inside the grace period and then serves the call', async () => {
    const td = await track({ hostToolGraceMs: 5000 });
    const a = await connect(td, { instanceId: 'g' });
    await open(a, 't');
    await send(a, 't', '/mcp claude_threads vault_search {"query":"z"}');
    const first = await a.waitFor((f) => f.name === 'tool.call');
    a.kill();
    await a.closed;
    await sleep(100);
    const b = await connect(td, { instanceId: 'g' });
    await b.cmd('attach', { ch: 't:t', afterSeq: 0 });
    // Like the plugin, the reconnected client re-sends its manifest on attach: that is what makes it the host.
    await b.cmd('tool.manifest', { threadId: 't', servers: { claude_threads: [tool('vault_search')] } });
    const again = await b.waitFor((f) => f.name === 'tool.call');
    expect(again.args.callId).toBe(first.args.callId); // the open call is shown again
    await b.cmd('tool.result', { threadId: 't', callId: again.args.callId, success: true, text: 'after reconnect' });
    expect(await lastMessage(b)).toBe('mcp ok: after reconnect');
  });

  it('an issued call whose client never returns fails after the grace period', async () => {
    const td = await track({ hostToolGraceMs: 200 });
    const a = await connect(td, { instanceId: 'g' });
    await open(a, 't');
    await send(a, 't', '/mcp claude_threads vault_search {}');
    const call = await a.waitFor((f) => f.name === 'tool.call');
    a.kill();
    await a.closed;
    const b = await connect(td, { instanceId: 'g' });
    await b.cmd('attach', { ch: 't:t', afterSeq: 0 });
    await b.cmd('session.detach', { threadId: 't' });
    await sleep(500);
    const f = await connect(td, { instanceId: 'g' });
    await f.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const msg = await lastMessage(f);
    expect(msg).toContain("The user's Geode is not connected");
    expect(f.events().some((x) => x.name === 'tool.cancel' && x.args.callId === call.args.callId)).toBe(true);
    expect(td.daemon.threads.hostTools.openCalls('t')).toBe(0);
  });

  it('times out an attached client that never answers', async () => {
    const td = await track({ hostToolTimeoutMs: 200 });
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp claude_threads vault_search {}');
    await c.waitFor((f) => f.name === 'tool.call');
    expect(await lastMessage(c)).toContain('did not answer in time');
    expect((await c.waitFor((f) => f.name === 'tool.unavailable')).args).toMatchObject({ reason: 'timeout' });
    expect(c.events().some((f) => f.name === 'tool.cancel')).toBe(true);
  });

  it('an interrupt cancels in-flight host tool calls', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/mcp claude_threads vault_search {}');
    const call = await c.waitFor((f) => f.name === 'tool.call');
    await c.cmd('session.interrupt', { threadId: 't' });
    expect((await c.waitFor((f) => f.name === 'tool.cancel')).args.callId).toBe(call.args.callId);
    expect(td.daemon.threads.hostTools.openCalls('t')).toBe(0);
  });

  it('reports hostAttached in the session state it emits, without emitting state just because a client attached', async () => {
    const td = await track();
    const c = await connect(td);
    await open(c, 't');
    await send(c, 't', '/tokens 1');
    await c.waitFor((f) => f.name === 'onDone');
    await sleep(50);
    expect(c.events().filter((f) => f.name === 'session.state').at(-1)!.args.hostAttached).toBe(true);
    const before = td.daemon.threads.journalFor('t')!.lastSeq;
    await c.cmd('session.detach', { threadId: 't' });
    const d = await connect(td);
    await d.cmd('attach', { ch: 't:t', afterSeq: before });
    await sleep(80);
    expect(td.daemon.threads.journalFor('t')!.lastSeq).toBe(before); // attach/detach added nothing to the journal
  });
});

describe('daemon-local tools', () => {
  let root: string;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function makeRepo(): { workspace: string; repo: string } {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'at-wt-')));
    const workspace = join(root, 'ws');
    const repo = join(workspace, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return { workspace, repo };
  }

  it('enter_worktree runs on the daemon: creates the worktree beside the repo, moves the session cwd, tells the client', async () => {
    const { workspace, repo } = makeRepo();
    const td = await track({ config: { harness: 'fake', workspaces: [workspace] } });
    const c = await connect(td);
    await open(c, 't', [], { ...SPEC, cwd: repo });
    await send(c, 't', '/mcp claude_threads enter_worktree {"branch":"feat/x"}');
    const text = await lastMessage(c);
    expect(text).toContain('mcp ok:');
    const result = JSON.parse(text.slice('mcp ok: '.length));
    expect(result).toMatchObject({ success: true, branch: 'feat/x' });
    expect(result.worktreePath.startsWith(join(workspace, '.worktrees'))).toBe(true);
    expect(existsSync(join(result.worktreePath, 'a.txt'))).toBe(true);
    expect(c.events().some((f) => f.name === 'tool.call')).toBe(false); // never left the daemon
    const moved = await c.waitFor((f) => f.name === 'session.cwd');
    expect(moved.args).toMatchObject({ cwd: result.worktreePath, originRepoPath: repo });
    // The recipe for a cold resume now points at the worktree.
    const meta = JSON.parse((await import('node:fs')).readFileSync(join(td.dataDir, 'sessions', 't.json'), 'utf8'));
    expect(meta.spec.cwd).toBe(result.worktreePath);

    await send(c, 't', '/mcp claude_threads exit_worktree {}');
    expect(await lastMessage(c, moved.seq + 1)).toContain('removedWorktree');
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it('refuses set_working_directory outside the workspaces', async () => {
    const { workspace, repo } = makeRepo();
    const td = await track({ config: { harness: 'fake', workspaces: [workspace] } });
    const c = await connect(td);
    await open(c, 't', [], { ...SPEC, cwd: repo });
    await send(c, 't', `/mcp claude_threads set_working_directory {"path":"${tmpdir()}"}`);
    expect(await lastMessage(c)).toContain('outside the folders this daemon allows');
    expect(c.events().some((f) => f.name === 'session.cwd')).toBe(false);
  });
});
