import { describe, expect, it, vi, afterEach } from 'vitest';
import * as path from 'path';
import { AcpClient, AcpRpcError, spawnAcpChannel, type AcpChannel, type AcpLauncher } from '../../src/AcpClient';

/** An in-memory agent: lets a test see what the client wrote and feed back arbitrary chunks. */
function makeChannel() {
  const written: any[] = [];
  let data: (chunk: string) => void = () => undefined;
  let stderr: (chunk: string) => void = () => undefined;
  let exit: (info: { code: number | null; signal: string | null; error?: Error }) => void = () => undefined;
  let killed = 0;
  const channel: AcpChannel = {
    write: (line) => written.push(JSON.parse(line)),
    onData: (handler) => { data = handler; },
    onStderr: (handler) => { stderr = handler; },
    onExit: (handler) => { exit = handler; },
    kill: () => { killed++; },
  };
  const launcher: AcpLauncher = () => channel;
  return {
    launcher, written,
    feed: (chunk: string) => data(chunk),
    feedErr: (chunk: string) => stderr(chunk),
    exit: (info: { code: number | null; signal: string | null; error?: Error } = { code: 0, signal: null }) => exit(info),
    get killed() { return killed; },
  };
}

function makeClient(over: Partial<ConstructorParameters<typeof AcpClient>[0]> = {}) {
  const fake = makeChannel();
  const client = new AcpClient({ binaryPath: 'agy', args: ['acp'], env: {}, launcher: fake.launcher, label: 'Antigravity', ...over });
  client.spawn();
  return { fake, client };
}

afterEach(() => { vi.useRealTimers(); });

describe('AcpClient framing and correlation', () => {
  it('correlates responses to requests by id, whatever the order', async () => {
    const { fake, client } = makeClient();
    const a = client.request('a');
    const b = client.request('b', { x: 1 });
    expect(fake.written.map((m) => [m.id, m.method])).toEqual([[1, 'a'], [2, 'b']]);
    expect(fake.written[1].params).toEqual({ x: 1 });
    fake.feed('{"jsonrpc":"2.0","id":2,"result":"B"}\n{"jsonrpc":"2.0","id":1,"result":"A"}\n');
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('reassembles a line split across chunks and handles CRLF', async () => {
    const { fake, client } = makeClient();
    const p = client.request('a');
    fake.feed('{"jsonrpc":"2.0","id":1,');
    fake.feed('"result":{"ok":true}}\r');
    fake.feed('\n');
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('reports non-JSON lines without dying', async () => {
    const { fake, client } = makeClient();
    const bad: string[] = [];
    client.onProtocolError((line) => bad.push(line));
    const p = client.request('a');
    fake.feed('Loading...\n{"jsonrpc":"2.0","id":1,"result":1}\n');
    await expect(p).resolves.toBe(1);
    expect(bad).toEqual(['Loading...']);
  });

  it('rejects with an AcpRpcError carrying the code', async () => {
    const { fake, client } = makeClient();
    const p = client.request('a');
    fake.feed('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}\n');
    await expect(p).rejects.toMatchObject({ name: 'AcpRpcError', code: -32601, message: 'nope' });
    expect(AcpRpcError).toBeDefined();
  });

  it('delivers notifications and omits params when none are given', () => {
    const { fake, client } = makeClient();
    const seen: unknown[] = [];
    client.onNotification('session/update', (params) => seen.push(params));
    fake.feed('{"jsonrpc":"2.0","method":"session/update","params":{"n":1}}\n');
    client.notify('session/cancel', { sessionId: 's' });
    client.notify('ping');
    expect(seen).toEqual([{ n: 1 }]);
    expect(fake.written).toEqual([
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } },
      { jsonrpc: '2.0', method: 'ping' },
    ]);
  });
});

describe('AcpClient agent-initiated requests', () => {
  it('answers a registered request with the handler result, echoing the (string) id', async () => {
    const { fake, client } = makeClient();
    client.onRequest('session/request_permission', async (params) => ({ outcome: { outcome: 'selected', optionId: params.pick } }));
    fake.feed('{"jsonrpc":"2.0","id":"1","method":"session/request_permission","params":{"pick":"allow"}}\n');
    await vi.waitFor(() => expect(fake.written).toHaveLength(1));
    expect(fake.written[0]).toEqual({ jsonrpc: '2.0', id: '1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  });

  it('answers an unknown request with method-not-found, and a throwing handler with an error', async () => {
    const { fake, client } = makeClient();
    client.onRequest('boom', () => { throw new Error('bad'); });
    fake.feed('{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{}}\n{"jsonrpc":"2.0","id":8,"method":"boom"}\n');
    await vi.waitFor(() => expect(fake.written).toHaveLength(2));
    expect(fake.written[0]).toMatchObject({ id: 7, error: { code: -32601 } });
    expect(fake.written[1]).toMatchObject({ id: 8, error: { code: -32000, message: 'bad' } });
  });
});

describe('AcpClient lifecycle', () => {
  it('rejects pending requests and reports the failure when the agent exits', async () => {
    const { fake, client } = makeClient();
    const closes: Array<Error | undefined> = [];
    client.onClose((error) => closes.push(error));
    const p = client.request('session/prompt');
    fake.feedErr('boom: quota exceeded');
    fake.exit({ code: 1, signal: null });
    await expect(p).rejects.toThrow(/exited unexpectedly \(code 1\).*quota exceeded/);
    expect(closes).toHaveLength(1);
    expect(closes[0]?.message).toMatch(/exited unexpectedly/);
    await expect(client.request('x')).rejects.toThrow(/not running/);
  });

  it('turns ENOENT into an install hint', async () => {
    const { fake, client } = makeClient({ binaryPath: '/nope/agy', installHint: 'Install the Antigravity CLI.' });
    const p = client.request('initialize');
    fake.exit({ code: null, signal: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
    await expect(p).rejects.toThrow(/"\/nope\/agy" was not found\. Install the Antigravity CLI\./);
  });

  it('times a request out without poisoning later ones', async () => {
    vi.useFakeTimers();
    const { fake, client } = makeClient();
    const slow = client.request('slow', undefined, 60_000);
    const assertion = expect(slow).rejects.toThrow(/did not answer slow within 60s/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    const next = client.request('next');
    fake.feed('{"jsonrpc":"2.0","id":2,"result":"fine"}\n');
    await expect(next).resolves.toBe('fine');
  });

  it('close() kills the child, rejects pending requests and reports a clean close once', async () => {
    const { fake, client } = makeClient();
    const closes: unknown[] = [];
    client.onClose((error) => closes.push(error));
    const p = client.request('a');
    client.close();
    client.close();
    await expect(p).rejects.toThrow(/was closed/);
    expect(fake.killed).toBe(1);
    expect(closes).toEqual([undefined]);
    fake.exit(); // the process exit that follows a kill is not a second failure
    expect(closes).toHaveLength(1);
  });

  it('delivers a failure that happened before onClose was registered', () => {
    const { fake, client } = makeClient();
    fake.exit({ code: 2, signal: null });
    const seen: Array<Error | undefined> = [];
    client.onClose((error) => seen.push(error));
    expect(seen[0]?.message).toMatch(/code 2/);
  });
});

describe('spawnAcpChannel against a real process', () => {
  it('speaks to the fake ACP agent over real stdio, with the real child_process launcher', async () => {
    const agent = path.resolve(__dirname, '../helpers/fake-acp-agent.mjs');
    const client = new AcpClient({ binaryPath: process.execPath, args: [agent], env: { ...process.env }, label: 'Fake agent' });
    client.spawn();
    try {
      const init = await client.request('initialize', { protocolVersion: 1 }, 10_000);
      expect(init.agentInfo.name).toBe('Antigravity ACP Server');
      const created = await client.request('session/new', { cwd: process.cwd(), mcpServers: [] }, 10_000);
      expect(created.sessionId).toMatch(/^fake-session-/);
    } finally {
      client.close();
    }
  });

  it('reports a missing binary through onClose', async () => {
    const client = new AcpClient({ binaryPath: '/definitely/not/here/agy', args: ['acp'], env: {}, installHint: 'Install it.', label: 'Antigravity' });
    const closed = new Promise<Error | undefined>((resolve) => client.onClose(resolve));
    client.spawn();
    const error = await closed;
    expect(error?.message).toMatch(/was not found\. Install it\./);
    expect(spawnAcpChannel).toBeTypeOf('function');
  });
});
