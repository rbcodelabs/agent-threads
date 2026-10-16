/**
 * A scripted in-memory daemon connection for DaemonClient unit tests: the
 * "server" side is driven by the test, frame by frame, with no network.
 */
import type { WebSocketFactory, WebSocketLike } from '../../src/remote/DaemonClient';

export type Json = Record<string, any>;

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  /** Everything the client sent, parsed. */
  readonly sent: Json[] = [];
  /** Called after each client frame; the test script answers here. */
  onClientFrame: ((frame: Json, socket: FakeSocket) => void) | null = null;
  terminated = false;

  constructor(readonly url: string) {}

  // client -> server
  send(data: string): void {
    const frame = JSON.parse(data) as Json;
    this.sent.push(frame);
    this.onClientFrame?.(frame, this);
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  // server -> client
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(frame: Json): void {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...frame }) });
  }
  /** The network or daemon went away. */
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  framesOfType(type: string): Json[] { return this.sent.filter((f) => f.type === type); }
}

export const WELCOME = {
  type: 'welcome',
  cmdId: 'hello',
  protocol: 1,
  daemonVersion: '0.62.2',
  minClientVersion: '0.0.0',
  capabilities: ['session.channel'],
  daemonId: 'daemon-1',
  epoch: 'epoch-1',
};

export interface FakeTransport {
  factory: WebSocketFactory;
  sockets: FakeSocket[];
  /** Latest socket. */
  readonly current: FakeSocket;
  /** Answer hello with a welcome and ack everything with `{}` unless `handler` says otherwise. */
  autoServe(handler?: (frame: Json, socket: FakeSocket) => boolean | void, welcome?: Partial<typeof WELCOME>): void;
}

export function fakeTransport(): FakeTransport {
  const sockets: FakeSocket[] = [];
  let auto: ((frame: Json, socket: FakeSocket) => void) | null = null;
  const t: FakeTransport = {
    sockets,
    get current() { return sockets[sockets.length - 1]; },
    factory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      s.onClientFrame = (f, sock) => auto?.(f, sock);
      queueMicrotask(() => { if (s.readyState === 0) s.open(); });
      return s;
    },
    autoServe(handler, welcome) {
      auto = (frame, socket) => {
        if (handler?.(frame, socket) === true) return; // handled by the test (it sees hello too)
        if (frame.type === 'hello') {
          socket.serverSend({ ...WELCOME, ...welcome });
          return;
        }
        socket.serverSend({ type: 'ack', cmdId: frame.cmdId, result: frame.type === 'attach' ? { lastSeq: 0, lowWater: 0, epoch: 'epoch-1', resync: false, controller: true } : {} });
      };
    },
  };
  return t;
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred` holds or fail with `what`. */
export async function until(pred: () => boolean, what = 'condition', timeoutMs = 4000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}
