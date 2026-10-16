/**
 * Minimal `ws` client for daemon integration tests. Deliberately not the
 * production DaemonClient (PR 5): tests drive the wire exactly as written in
 * the protocol, so a bug in a shared client cannot hide a server bug.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { resolveConfig, type ConfigInputs } from '../../daemon/config';
import { startDaemon, type DaemonHandle, type DaemonOptions } from '../../daemon/server';

export type Frame = Record<string, any> & { type: string };

export const SPEC = { harness: 'claude', cwd: '/srv/workspaces/x', permissionMode: 'default', extraEnvRaw: '' } as const;

export interface TestDaemon {
  daemon: DaemonHandle;
  dataDir: string;
  adminToken: string;
  cleanup(): Promise<void>;
}

export async function startTestDaemon(
  opts: Partial<DaemonOptions> & { dataDir?: string; allowedOrigins?: string[]; config?: NonNullable<ConfigInputs['flags']> } = {},
): Promise<TestDaemon> {
  const ownsDir = !opts.dataDir;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'agent-threads-test-'));
  const { config: configFlags, dataDir: _d, allowedOrigins: _o, ...daemonOpts } = opts;
  const config = resolveConfig({ flags: { dataDir, port: 0, allowedOrigins: opts.allowedOrigins, harness: 'fake', maxLiveSessions: 10_000, ...configFlags }, env: {} });
  const daemon = await startDaemon({ config, journalFlushMs: 5, ...daemonOpts });
  const adminToken = daemon.tokens.create('test-admin', 'admin').token;
  let stopped = false;
  return {
    daemon,
    dataDir,
    adminToken,
    async cleanup() {
      if (!stopped) { stopped = true; await daemon.stop(); }
      if (ownsDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export class TestClient {
  readonly frames: Frame[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<() => void> = [];
  private n = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.frames.push(JSON.parse(d.toString()));
      this.waiters.splice(0).forEach((w) => w());
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        this.waiters.splice(0).forEach((w) => w());
        resolve(this.closeInfo);
      });
    });
    ws.on('error', () => { /* surfaced through close */ });
  }

  static open(url: string, wsOpts: WebSocket.ClientOptions = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, wsOpts);
      ws.once('open', () => resolve(new TestClient(ws)));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    });
  }

  /** Connect and complete hello; resolves with the welcome frame on the client. */
  static async connect(url: string, token: string, wsOpts: WebSocket.ClientOptions = {}, helloExtra: object = {}): Promise<TestClient> {
    const c = await TestClient.open(url, wsOpts);
    const reply = await c.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 'test', token, ...helloExtra });
    if (reply.type !== 'welcome') throw new Error(`hello failed: ${JSON.stringify(reply)}`);
    return c;
  }

  nextId(): string { return `c${++this.n}-${randomUUID().slice(0, 8)}`; }

  sendRaw(frame: object): void { this.ws.send(JSON.stringify({ v: 1, ...frame })); }

  /** Send a command and wait for the reply carrying its cmdId. */
  async cmd(type: string, payload: object = {}, cmdId = this.nextId()): Promise<Frame> {
    this.sendRaw({ cmdId, type, ...payload });
    return this.waitFor((f) => f.cmdId === cmdId && (f.type === 'ack' || f.type === 'err' || f.type === 'welcome'), 5000, `reply to ${type}`);
  }

  async waitFor(pred: (f: Frame) => boolean, timeoutMs = 5000, what = 'frame'): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    let scanned = 0;
    for (;;) {
      for (; scanned < this.frames.length; scanned++) if (pred(this.frames[scanned])) return this.frames[scanned];
      if (this.closeInfo) throw new Error(`socket closed (${this.closeInfo.code}) while waiting for ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }

  private evCursor = 0;

  /** Next unread event frame, in arrival order. */
  async nextEvent(timeoutMs = 5000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.evCursor < this.frames.length) {
        const f = this.frames[this.evCursor++];
        if (f.type === 'event' || f.type === 'resync') return f;
      }
      if (this.closeInfo) throw new Error(`socket closed (${this.closeInfo.code}) while waiting for an event`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for next event');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  events(): Frame[] { return this.frames.filter((f) => f.type === 'event'); }

  /** Abrupt TCP-level drop, like a laptop lid closing. */
  kill(): void { this.ws.terminate(); }

  async close(): Promise<void> {
    if (!this.closeInfo) this.ws.close();
    await this.closed;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Small deterministic PRNG so a failing randomized run can be replayed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
