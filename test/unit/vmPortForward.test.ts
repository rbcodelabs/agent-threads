/**
 * Tests for vmPortForward — making a server the agent started inside the
 * sandbox container reachable from host-side browser tools.
 *
 * The container CLI is never invoked: the relay process is faked with a
 * function that connects straight to a real local TCP server, which exercises
 * the real listener/pipe/teardown logic against real sockets.
 */
import { afterEach, describe, expect, it } from 'vitest';
import net from 'net';
import { PassThrough } from 'stream';
import {
  GUEST_RELAY_SCRIPT,
  VmLoopbackError,
  VmPortForwarder,
  buildGuestRelayArgs,
  parseLoopbackHttpUrl,
  rewriteToHostPort,
  type RelayProcess,
} from '../../src/vmPortForward';

describe('parseLoopbackHttpUrl', () => {
  it.each([
    ['http://localhost:8765/index.html', 8765],
    ['http://127.0.0.1:3000', 3000],
    ['http://127.1.2.3:3000/x', 3000],
    ['http://[::1]:5173/', 5173],
    ['http://0.0.0.0:8000/', 8000],
    ['https://LOCALHOST:8443/a?b=1#c', 8443],
    ['http://localhost/', 80],
    ['https://localhost/', 443],
    ['http://foo.localhost:9000/', 9000],
  ])('treats %s as loopback on port %i', (url, port) => {
    expect(parseLoopbackHttpUrl(url)?.port).toBe(port);
  });

  it.each([
    'https://example.com/',
    'http://192.168.64.3:8000/',
    'http://10.0.0.1:80/',
    'http://localhost.example.com:3000/',
    'file:///tmp/x.html',
    'about:blank',
    'not a url',
    '',
  ])('leaves %s alone', (url) => {
    expect(parseLoopbackHttpUrl(url)).toBeNull();
  });
});

describe('rewriteToHostPort', () => {
  it('replaces host and port but keeps scheme, path, query, and hash', () => {
    const parsed = parseLoopbackHttpUrl('https://localhost:8443/a/b?x=1#frag')!;
    expect(rewriteToHostPort(parsed, 54321)).toBe('https://127.0.0.1:54321/a/b?x=1#frag');
  });

  it('handles IPv6 and default ports', () => {
    expect(rewriteToHostPort(parseLoopbackHttpUrl('http://[::1]/')!, 40000)).toBe('http://127.0.0.1:40000/');
  });

  it('drops credentials so they are never carried to a rewritten origin', () => {
    expect(rewriteToHostPort(parseLoopbackHttpUrl('http://u:p@localhost:80/')!, 40000)).toBe('http://127.0.0.1:40000/');
  });
});

describe('buildGuestRelayArgs', () => {
  it('execs the relay script with the port inside the named container, stdin attached', () => {
    const args = buildGuestRelayArgs('c1', 8000);
    expect(args.slice(0, 4)).toEqual(['exec', '--interactive', 'c1', 'node']);
    expect(args).toContain(GUEST_RELAY_SCRIPT);
    expect(args[args.length - 1]).toBe('8000');
  });

  it('adds the probe flag for a connect-only check', () => {
    expect(buildGuestRelayArgs('c1', 8000, { probe: true }).slice(-2)).toEqual(['8000', 'probe']);
  });

  it('rejects ports that are not integers in 1-65535', () => {
    expect(() => buildGuestRelayArgs('c1', 0)).toThrow();
    expect(() => buildGuestRelayArgs('c1', 70000)).toThrow();
    expect(() => buildGuestRelayArgs('c1', 1.5)).toThrow();
  });
});

// ── Forwarder against real sockets ──────────────────────────────────────────

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

function listen(handler?: (s: net.Socket) => void): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

/** A relay that connects to `target` on the test machine, standing in for `container exec ... node relay`. */
function fakeRelayTo(target: number): () => RelayProcess {
  return () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const exitCbs: Array<(code: number | null) => void> = [];
    const sock = net.connect(target, '127.0.0.1');
    stdin.pipe(sock);
    sock.pipe(stdout);
    sock.on('close', () => exitCbs.forEach((cb) => cb(0)));
    sock.on('error', () => undefined);
    return {
      stdin, stdout,
      kill: () => sock.destroy(),
      onExit: (cb) => { exitCbs.push(cb); },
    };
  };
}

function request(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(payload));
    let data = '';
    c.on('data', (d) => { data += d; });
    c.on('end', () => resolve(data));
    c.on('error', reject);
    setTimeout(() => { c.destroy(); resolve(data); }, 1500);
  });
}

function makeForwarder(over: Partial<ConstructorParameters<typeof VmPortForwarder>[0]> = {}) {
  return new VmPortForwarder({
    containerName: () => 'c1',
    probeGuestPort: async () => 'open',
    probeHostPort: async () => false,
    spawnRelay: () => { throw new Error('spawnRelay not scripted'); },
    ...over,
  });
}

describe('VmPortForwarder.resolve', () => {
  it('passes non-loopback URLs through untouched without probing anything', async () => {
    const f = makeForwarder({ probeGuestPort: async () => { throw new Error('should not probe'); } });
    expect(await f.resolve('https://example.com/x')).toEqual({ kind: 'passthrough' });
  });

  it('forwards a guest server: the rewritten URL reaches it through the relay', async () => {
    const guest = await listen((s) => s.on('data', (d) => s.end(`echo:${d}`)));
    const f = makeForwarder({ spawnRelay: fakeRelayTo(guest.port) });
    const res = await f.resolve(`http://localhost:${guest.port}/hello`);
    expect(res.kind).toBe('forwarded');
    if (res.kind !== 'forwarded') return;
    const url = new URL(res.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/hello');
    expect(res.hostPort).not.toBe(0);
    expect(res.note).toMatch(/sandbox/i);
    expect(await request(res.hostPort, 'ping')).toBe('echo:ping');
    f.close();
  });

  it('listens on loopback only, never on all interfaces', async () => {
    const guest = await listen((s) => s.end('x'));
    const f = makeForwarder({ spawnRelay: fakeRelayTo(guest.port) });
    const res = await f.resolve(`http://127.0.0.1:${guest.port}/`);
    expect(res.kind).toBe('forwarded');
    const bound = f.listeningAddresses();
    expect(bound.length).toBe(1);
    expect(bound[0].address).toBe('127.0.0.1');
    f.close();
  });

  it('reuses one listener per guest port', async () => {
    const guest = await listen((s) => s.end('x'));
    const f = makeForwarder({ spawnRelay: fakeRelayTo(guest.port) });
    const a = await f.resolve(`http://localhost:${guest.port}/a`);
    const b = await f.resolve(`http://127.0.0.1:${guest.port}/b`);
    expect(a.kind === 'forwarded' && b.kind === 'forwarded' && a.hostPort === b.hostPort).toBe(true);
    expect(f.listeningAddresses().length).toBe(1);
    f.close();
  });

  it('handles several concurrent connections independently', async () => {
    const guest = await listen((s) => s.on('data', (d) => s.end(`#${d}`)));
    const f = makeForwarder({ spawnRelay: fakeRelayTo(guest.port) });
    const res = await f.resolve(`http://localhost:${guest.port}/`);
    if (res.kind !== 'forwarded') throw new Error('expected forwarded');
    const out = await Promise.all(['a', 'b', 'c'].map((p) => request(res.hostPort, p)));
    expect(out).toEqual(['#a', '#b', '#c']);
    f.close();
  });

  it('close() stops the listener', async () => {
    const guest = await listen((s) => s.end('x'));
    const f = makeForwarder({ spawnRelay: fakeRelayTo(guest.port) });
    const res = await f.resolve(`http://localhost:${guest.port}/`);
    if (res.kind !== 'forwarded') throw new Error('expected forwarded');
    f.close();
    await expect(request(res.hostPort, 'x')).rejects.toBeTruthy();
    expect(f.listeningAddresses()).toEqual([]);
  });

  it('falls through to the host when nothing listens in the guest but the host has a server there', async () => {
    const f = makeForwarder({ probeGuestPort: async () => 'closed', probeHostPort: async () => true });
    expect(await f.resolve('http://localhost:3000/')).toEqual({ kind: 'passthrough' });
  });

  it('fails with an actionable error when neither side listens', async () => {
    const f = makeForwarder({ probeGuestPort: async () => 'closed', probeHostPort: async () => false });
    const err = await f.resolve('http://localhost:3000/').catch((e) => e);
    expect(err).toBeInstanceOf(VmLoopbackError);
    expect(err.message).toMatch(/nothing is listening on port 3000 inside the sandbox/i);
    expect(err.hint).toMatch(/background|nohup|&/);
  });

  it('fails clearly when the guest cannot be probed (e.g. no node in a custom image)', async () => {
    const f = makeForwarder({ probeGuestPort: async () => 'error' });
    const err = await f.resolve('http://localhost:3000/').catch((e) => e);
    expect(err).toBeInstanceOf(VmLoopbackError);
    expect(err.message).toMatch(/could not check/i);
  });
});

// ── The guest relay script itself, run under real node ──────────────────────
// (regression: a failed first attempt's `close` event used to exit 0 before the
// IPv6 fallback ran, so a closed port probed as "open")

import { spawn, spawnSync } from 'child_process';

describe('GUEST_RELAY_SCRIPT under node', () => {
  const run = (port: number, probe: boolean) =>
    spawnSync(process.execPath, ['-e', GUEST_RELAY_SCRIPT, String(port), ...(probe ? ['probe'] : [])], { timeout: 10_000 });

  it('probe exits 3 for a closed port', async () => {
    const { port } = await listen();
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    expect(run(port, true).status).toBe(3);
  });

  it('probe exits 0 for an open port', async () => {
    const { port } = await listen();
    expect(run(port, true).status).toBe(0);
  });

  it('pipes bytes both ways to the target', async () => {
    const { port } = await listen((s) => s.on('data', (d) => s.end(`got:${d}`)));
    const child = spawn(process.execPath, ['-e', GUEST_RELAY_SCRIPT, String(port)]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.write('abc');
    const code = await new Promise((r) => child.on('close', r));
    expect(out).toBe('got:abc');
    expect(code).toBe(0);
  });
});
