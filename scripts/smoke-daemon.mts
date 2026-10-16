#!/usr/bin/env node
/**
 * Smoke test for a RUNNING daemon (a container, a systemd service, a VM): it proves the three things an
 * operator needs before trusting an install, without spending a token when the daemon runs the fake harness.
 *
 *   1. GET /healthz answers {"ok":true,"protocol":1}
 *   2. a wrong token is rejected (close 4401), and no session is reachable with it
 *   3. a short stream round trip with the right token: hello -> session.open -> attach -> session.send -> done
 *
 *   AGENT_THREADS_SMOKE_URL=http://127.0.0.1:7433 AGENT_THREADS_SMOKE_TOKEN=atd_... node scripts/smoke-daemon.mts
 *   (flags --url / --token also work; the token needs `control` scope or higher.)
 *
 * Step 3 sends `/tokens 20`, which only the scripted fake harness understands (`serve --fake-harness`); against
 * a real Claude daemon pass `--no-stream` to stop after the health and auth checks, or `--real` to send a real
 * one-line prompt (it spends a few tokens) and expect any completed turn. The session it opens is closed again.
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const base = (arg('url') ?? process.env.AGENT_THREADS_SMOKE_URL ?? 'http://127.0.0.1:7433').replace(/\/+$/, '').replace(/^ws/i, 'http').replace(/\/v1\/ws$/, '');
const token = arg('token') ?? process.env.AGENT_THREADS_SMOKE_TOKEN;
const wsUrl = `${base.replace(/^http/i, 'ws')}/v1/ws`;
const threadId = `smoke-${randomUUID().slice(0, 8)}`;

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

type Frame = Record<string, any>;

class Conn {
  readonly frames: Frame[] = [];
  closed: { code: number } | null = null;
  readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (d) => this.frames.push(JSON.parse(d.toString())));
    ws.on('close', (code) => { this.closed = { code }; });
    ws.on('error', () => {});
  }
  static open(): Promise<Conn> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.once('open', () => resolve(new Conn(ws)));
      ws.once('error', reject);
    });
  }
  send(o: object): void { this.ws.send(JSON.stringify({ v: 1, ...o })); }
  async until(pred: (f: Frame) => boolean, what: string, ms = 15000): Promise<Frame> {
    const end = Date.now() + ms;
    let from = 0;
    for (;;) {
      for (; from < this.frames.length; from++) if (pred(this.frames[from])) return this.frames[from];
      if (this.closed) throw new Error(`socket closed (${this.closed.code}) waiting for ${what}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

async function main(): Promise<void> {
  console.log(`smoke: ${base}`);

  // 1. health
  const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(8000) });
  const health = (await res.json()) as Frame;
  check('healthz', res.status === 200 && health.ok === true && health.protocol === 1, JSON.stringify(health));

  // 2. a bad token is rejected
  const bad = await Conn.open();
  bad.send({ cmdId: 'h', type: 'hello', protocol: 1, client: 'cli', clientVersion: 'smoke', token: 'atd_definitely-not-a-token' });
  const deadline = Date.now() + 8000;
  while (!bad.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  check('bad token rejected', bad.closed?.code === 4401 && !bad.frames.some((f) => f.type === 'welcome'), `close ${bad.closed?.code ?? 'none'}`);

  if (!token) {
    console.log('SKIP  stream round trip (no token: set AGENT_THREADS_SMOKE_TOKEN)');
    failures++;
    return;
  }
  if (flag('no-stream')) return;

  // 3. a short stream
  const c = await Conn.open();
  try {
    c.send({ cmdId: 'h', type: 'hello', protocol: 1, client: 'cli', clientVersion: 'smoke', token });
    const welcome = await c.until((f) => f.type === 'welcome' || f.type === 'err', 'welcome');
    check('good token accepted', welcome.type === 'welcome', welcome.type === 'welcome' ? `daemon ${welcome.daemonVersion}` : String(welcome.message));
    if (welcome.type !== 'welcome') return;

    const cwdReply = await (async () => {
      c.send({ cmdId: 'w', type: 'workspaces.list' });
      return c.until((f) => f.cmdId === 'w', 'workspaces.list');
    })();
    const workspaces = (cwdReply.result?.workspaces ?? []) as Array<{ path: string; readOnly: boolean; isDefault: boolean }>;
    const cwd = (workspaces.find((w) => w.isDefault) ?? workspaces.find((w) => !w.readOnly))?.path;
    check('a workspace is configured', !!cwd, cwd ?? 'none: pass --workspace to serve');
    if (!cwd) return;

    c.send({ cmdId: 'o', type: 'session.open', threadId, spec: { harness: 'claude', cwd, permissionMode: 'default', extraEnvRaw: '' } });
    const opened = await c.until((f) => f.cmdId === 'o', 'session.open');
    check('session opens', opened.type === 'ack', opened.type === 'ack' ? threadId : String(opened.message));
    if (opened.type !== 'ack') return;

    c.send({ cmdId: 'a', type: 'attach', ch: `t:${threadId}`, afterSeq: 0, observe: false });
    await c.until((f) => f.cmdId === 'a', 'attach');
    const text = flag('real') ? 'Reply with the single word: ok' : '/tokens 20';
    c.send({ cmdId: 's', type: 'session.send', threadId, text, userMessageUuid: randomUUID() });
    const sent = await c.until((f) => f.cmdId === 's', 'session.send');
    check('prompt accepted', sent.type === 'ack', sent.type === 'err' ? String(sent.message) : '');
    const done = await c.until((f) => f.type === 'event' && (f.name === 'onDone' || f.name === 'onError'), 'the turn to finish', flag('real') ? 120000 : 15000);
    const tokenEvents = c.frames.filter((f) => f.name === 'onToken').length;
    check('turn completes', done.name === 'onDone', done.name);
    if (!flag('real')) check('streamed tokens in order', tokenEvents === 20 && c.frames.filter((f) => f.name === 'onToken').every((f, i) => f.args[0].startsWith(`t${i}:`)), `${tokenEvents} tokens`);
    const seqs = c.frames.filter((f) => f.type === 'event').map((f) => f.seq as number);
    check('sequence numbers strictly increase', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `${seqs.length} events`);
  } finally {
    // Free the session (and its claude process, if real); the journal is kept until the daemon's retention drops it.
    try { c.send({ cmdId: 'x', type: 'session.close', threadId }); await new Promise((r) => setTimeout(r, 200)); } catch { /* socket gone */ }
    c.ws.close();
  }
}

main().catch((err) => { check('smoke run', false, err instanceof Error ? err.message : String(err)); }).finally(() => {
  console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
});
