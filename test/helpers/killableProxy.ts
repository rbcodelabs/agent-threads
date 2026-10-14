/**
 * A TCP proxy whose connections can be cut on demand: the "network dropped
 * mid-turn" lever for resume tests (integration and the Geode e2e).
 */
import net from 'node:net';

export interface KillableProxy {
  port: number;
  /** Abruptly destroy every open connection; new ones are still accepted. */
  killAll(): number;
  /** Stop accepting and drop everything. */
  close(): Promise<void>;
  readonly connections: number;
}

export async function startKillableProxy(targetHost: string, targetPort: number, listenPort = 0): Promise<KillableProxy> {
  const open = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    open.add(client);
    open.add(upstream);
    const done = (): void => { client.destroy(); upstream.destroy(); open.delete(client); open.delete(upstream); };
    client.on('error', done).on('close', done);
    upstream.on('error', done).on('close', done);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    get connections() { return open.size / 2; },
    killAll() {
      const n = open.size / 2;
      for (const s of [...open]) s.destroy();
      open.clear();
      return n;
    },
    close() {
      for (const s of [...open]) s.destroy();
      open.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
