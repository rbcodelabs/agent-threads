/**
 * SandboxVmManager.resolveLoopbackUrl — the seam host-side browser tools use to
 * turn a loopback URL into one that reaches a server running in the thread's
 * sandbox container. The container CLI is faked; the relay connects to a real
 * local socket so the forwarding path is exercised for real.
 */
import { afterEach, describe, expect, it } from 'vitest';
import net from 'net';
import { PassThrough } from 'stream';
import {
  SandboxVmManager,
  VmUnavailableError,
  type VmCommandRunner,
} from '../../src/sandboxVm';
import { VmLoopbackError, type RelayProcess } from '../../src/vmPortForward';

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

function listen(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => sock.on('data', (d) => sock.end(`ok:${d}`)));
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port));
  });
}

function relayTo(port: number) {
  return (): RelayProcess => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const cbs: Array<(c: number | null) => void> = [];
    const sock = net.connect(port, '127.0.0.1');
    stdin.pipe(sock);
    sock.pipe(stdout);
    sock.on('close', () => cbs.forEach((cb) => cb(0)));
    sock.on('error', () => undefined);
    return { stdin, stdout, kill: () => sock.destroy(), onExit: (cb) => { cbs.push(cb); } };
  };
}

function fakeRunner(opts: { inspectExit?: number; probeExit?: number; reject?: Error } = {}) {
  const calls: string[][] = [];
  const run: VmCommandRunner = async (args) => {
    calls.push([...args]);
    if (opts.reject) throw opts.reject;
    if (args[0] === 'inspect') return { exitCode: opts.inspectExit ?? 0, stdout: '[]', stderr: '' };
    if (args[0] === 'exec' && args.includes('probe')) return { exitCode: opts.probeExit ?? 0, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function manager(run: VmCommandRunner, spawnRelay?: () => RelayProcess) {
  return new SandboxVmManager({ containerName: () => 'claude-threads-vm-t1', run, spawnRelay });
}

async function request(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(payload));
    let data = '';
    c.on('data', (d) => { data += d; });
    c.on('end', () => resolve(data));
    c.on('error', () => resolve(data));
  });
}

describe('SandboxVmManager.resolveLoopbackUrl', () => {
  it('does nothing — and runs no command — for a non-loopback URL', async () => {
    const { run, calls } = fakeRunner();
    expect(await manager(run).resolveLoopbackUrl('https://example.com/')).toEqual({ kind: 'passthrough' });
    expect(calls).toEqual([]);
  });

  it('leaves loopback URLs alone for a thread with no sandbox container (host-local threads unchanged)', async () => {
    const { run, calls } = fakeRunner({ inspectExit: 1 });
    expect(await manager(run).resolveLoopbackUrl('http://localhost:3000/')).toEqual({ kind: 'passthrough' });
    expect(calls.map((c) => c[0])).toEqual(['inspect']);
  });

  it('leaves loopback URLs alone when the container runtime is not installed', async () => {
    const { run } = fakeRunner({ reject: new VmUnavailableError('ENOENT') });
    expect(await manager(run).resolveLoopbackUrl('http://localhost:3000/')).toEqual({ kind: 'passthrough' });
  });

  it('forwards to a server inside the container and the rewritten URL really connects', async () => {
    const guestPort = await listen();
    const { run, calls } = fakeRunner({ probeExit: 0 });
    const m = manager(run, relayTo(guestPort));
    const res = await m.resolveLoopbackUrl(`http://127.0.0.1:${guestPort}/x`);
    expect(res.kind).toBe('forwarded');
    if (res.kind !== 'forwarded') return;
    expect(new URL(res.url).hostname).toBe('127.0.0.1');
    expect(await request(res.hostPort, 'hi')).toBe('ok:hi');
    // The probe targets the thread's container, not a hard-coded one.
    const probe = calls.find((c) => c.includes('probe'))!;
    expect(probe).toContain('claude-threads-vm-t1');
    expect(probe).toContain(String(guestPort));
    m.closePortForwards();
  });

  it('raises an actionable error when nothing listens in the container or on the host', async () => {
    const { run } = fakeRunner({ probeExit: 3 });
    const err = await manager(run).resolveLoopbackUrl('http://localhost:59123/').catch((e) => e);
    expect(err).toBeInstanceOf(VmLoopbackError);
    expect(err.message).toMatch(/nothing is listening on port 59123 inside the sandbox/i);
  });

  it('treats a host server on that port as the intended target when the guest has none', async () => {
    const hostPort = await listen();
    const { run } = fakeRunner({ probeExit: 3 });
    expect(await manager(run).resolveLoopbackUrl(`http://localhost:${hostPort}/`)).toEqual({ kind: 'passthrough' });
  });

  it('closePortForwards() stops forwarding listeners', async () => {
    const guestPort = await listen();
    const { run } = fakeRunner({ probeExit: 0 });
    const m = manager(run, relayTo(guestPort));
    const res = await m.resolveLoopbackUrl(`http://localhost:${guestPort}/`);
    if (res.kind !== 'forwarded') throw new Error('expected forwarded');
    m.closePortForwards();
    expect(await request(res.hostPort, 'x')).toBe('');
  });

  it('exit() closes forwarders along with the container', async () => {
    const guestPort = await listen();
    const { run } = fakeRunner({ probeExit: 0 });
    const m = manager(run, relayTo(guestPort));
    const res = await m.resolveLoopbackUrl(`http://localhost:${guestPort}/`);
    if (res.kind !== 'forwarded') throw new Error('expected forwarded');
    const exited = await m.exit({ force: true });
    expect(exited.success).toBe(true);
    expect(await request(res.hostPort, 'x')).toBe('');
  });
});
