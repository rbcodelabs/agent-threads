#!/usr/bin/env node
/**
 * Live driver for a running daemon with a REAL Claude session behind it. Uses
 * only Node's global WebSocket (Node >= 22), so it runs on the daemon box with
 * nothing installed:
 *
 *   node daemon-live-check.mts <ws-url> <token> <command> <threadId> [args...]
 *
 * Commands (each prints one compact line per wire event, as `[seq] name ...`):
 *   list-files  <thread> <cwd>             open (haiku, default permission mode), ask for the files in cwd, stream to done
 *   permission  <thread> <cwd> [--drop]    ask for a Bash call; on permission_request either allow at once, or with --drop
 *                                          close the socket, reconnect with afterSeq=<request seq>, and answer the replayed prompt
 *   remember    <thread> <cwd> <word>      tell the session a word (turn 1; leaves a resumable native session)
 *   long-turn   <thread> <cwd>             start a slow Bash turn (`touch flag && sleep 120`, which asks for permission), allow it, print READY-TO-KILL once the tool runs, then exit
 *                                          leaving the turn running (the caller kill -9s the daemon)
 *   after-kill  <thread>                   attach from 0, show daemon_restarted, send "what was the word?", stream the answer
 *   state       <thread>                   attach from 0 and print every event (no send)
 *
 * Exit code 0 only if the scenario's expectation held; the last line says PASS or FAIL.
 */
const [url, token, command, threadId, ...rest] = process.argv.slice(2);
if (!url || !token || !command || !threadId) {
  console.error('usage: daemon-live-check.mts <ws-url> <token> <command> <threadId> [args...]');
  process.exit(2);
}

type Frame = Record<string, any> & { type: string };
const MODEL = process.env.LIVE_MODEL ?? 'haiku';
let n = 0;
// The daemon caches replies by (token, cmdId) for 10 minutes, so ids must be unique per process.
const RUN = globalThis.crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Conn {
  frames: Frame[] = [];
  closed = false;
  private waiters: Array<() => void> = [];
  readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data)) as Frame;
      this.frames.push(f);
      if (f.type === 'event' || f.type === 'resync') print(f);
      this.waiters.splice(0).forEach((w) => w());
    };
    ws.onclose = () => { this.closed = true; this.waiters.splice(0).forEach((w) => w()); };
  }
  static async open(): Promise<Conn> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error(`cannot connect to ${url}`)); });
    const c = new Conn(ws);
    const r = await c.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 'live-check', token });
    if (r.type !== 'welcome') throw new Error(`hello failed: ${JSON.stringify(r)}`);
    return c;
  }
  async cmd(type: string, payload: object = {}): Promise<Frame> {
    const cmdId = `lc-${RUN}-${++n}`;
    this.ws.send(JSON.stringify({ v: 1, cmdId, type, ...payload }));
    return this.waitFor((f) => f.cmdId === cmdId && ['ack', 'err', 'welcome'].includes(f.type), 20_000, `reply to ${type}`);
  }
  async waitFor(pred: (f: Frame) => boolean, ms = 120_000, what = 'frame'): Promise<Frame> {
    const deadline = Date.now() + ms;
    let i = 0;
    for (;;) {
      for (; i < this.frames.length; i++) if (pred(this.frames[i])) return this.frames[i];
      if (this.closed) throw new Error(`socket closed while waiting for ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((res) => { const t = setTimeout(res, left); this.waiters.push(() => { clearTimeout(t); res(); }); });
    }
  }
  events(): Frame[] { return this.frames.filter((f) => f.type === 'event' || f.type === 'resync'); }
  drop(): void { this.ws.close(); }
}

function summarize(f: Frame): string {
  const a = f.args;
  const clip = (s: unknown, k = 110) => { const t = typeof s === 'string' ? s : (JSON.stringify(s) ?? String(s)); return t.length > k ? `${t.slice(0, k)}...` : t; };
  switch (f.name) {
    case 'onToken': return `token ${JSON.stringify(a[0])}`;
    case 'onMessage': return `message ${clip(a[0], 160)}`;
    case 'onToolUse': return `tool_use ${a[0]?.name}: ${clip(a[0]?.summary, 90)}`;
    case 'onDone': return `done session=${a[0]} turns=${a[2]}`;
    case 'onError': return `ERROR ${clip(a[0], 140)}`;
    case 'onInterrupted': return `interrupted session=${a[0]}`;
    case 'session.state': return `state ${clip(a, 160)}`;
    case 'permission_request': return `permission_request id=${a.requestId} tool=${a.toolName} detail=${clip(a.detail, 90)}${f.reopen ? ' [REOPEN]' : ''}`;
    case 'request_resolved': return `request_resolved ${clip(a)}`;
    case 'onRecap': case 'onUsage': case 'onActiveModel': case 'onVmRouting': case 'onCapabilitiesDiscovered': case 'onStatus':
    case 'onToolResult': case 'onCommandsChanged': case 'onNotification':
      return `${f.name.replace(/^on/, '').toLowerCase()} ${clip(a, 70)}`;
    default: return `${f.name} ${clip(a, 100)}`;
  }
}
function print(f: Frame): void {
  if (f.type === 'resync') { console.log(`[${f.seq}] RESYNC`); return; }
  console.log(`[${f.seq}] ${summarize(f)}`);
}

const spec = (cwd: string, extra: object = {}) => ({ harness: 'claude', cwd, permissionMode: 'default', extraEnvRaw: '', model: MODEL, ...extra });
/** The last assistant message with text (earlier ones may just carry tool calls). */
const lastMessage = (c: Conn): string => String(c.events().filter((f) => f.name === 'onMessage' && f.args[0]).at(-1)?.args[0] ?? '');
const idleAfterDone = (c: Conn) => (f: Frame) => f.name === 'session.state' && f.args.turnInFlight === false
  && c.events().some((e) => e.name === 'onDone' && e.seq < f.seq);

function verdict(ok: boolean, why: string): never {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${why}`);
  process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
  const c = await Conn.open();
  const sendAndWatch = async (text: string) => {
    const r = await c.cmd('session.send', { threadId, text, userMessageUuid: `u-${Date.now()}` });
    if (r.type !== 'ack') throw new Error(`send refused: ${JSON.stringify(r)}`);
  };

  switch (command) {
    case 'list-files': {
      const [cwd] = rest;
      console.log(`# open: ${JSON.stringify((await c.cmd('session.open', { threadId, spec: spec(cwd) })).result)}`);
      await c.cmd('attach', { ch: `t:${threadId}`, afterSeq: 0 });
      await sendAndWatch(`List the files in ${cwd}. Use the ls command, then reply with just the file names, comma separated.`);
      // default mode may ask before running ls; allow it so the scenario is "stream token...done"
      const stop = (async () => {
        for (;;) {
          const req = await c.waitFor((f) => f.name === 'permission_request' && !f.__answered, 120_000, 'permission or done').catch(() => null);
          if (!req) return;
          (req as any).__answered = true;
          await c.cmd('resolve.permission', { threadId, requestId: req.args.requestId, allow: true });
        }
      })();
      await c.waitFor(idleAfterDone(c), 120_000, 'done + idle');
      void stop;
      const tokens = c.events().filter((f) => f.name === 'onToken').length;
      const msg = lastMessage(c);
      verdict(tokens > 0 && /alpha\.txt/.test(msg) && /beta\.md/.test(msg), `streamed ${tokens} token events then done; final message names the workspace files (${JSON.stringify(msg).slice(0, 120)})`);
      break;
    }

    case 'permission': {
      const [cwd] = rest;
      const drop = rest.includes('--drop');
      await c.cmd('session.open', { threadId, spec: spec(cwd) });
      await c.cmd('attach', { ch: `t:${threadId}`, afterSeq: 0 });
      await sendAndWatch('Use the Bash tool to run exactly: echo hello-from-bash > bash-out.txt && cat bash-out.txt . Then reply with what it printed.');
      const req = await c.waitFor((f) => f.name === 'permission_request', 120_000, 'permission_request');
      console.log(`# permission_request seen (seq ${req.seq}, id ${req.args.requestId}); mode=default so the Bash call is blocked on a human`);
      let answerOn = c;
      let requestId = req.args.requestId as string;
      if (drop) {
        const cursor = c.events().at(-1)!.seq as number;
        console.log(`# DISCONNECT mid-prompt (client cursor = ${cursor}); the turn stays blocked on the daemon`);
        c.drop();
        await sleep(1500);
        answerOn = await Conn.open();
        const att = await answerOn.cmd('attach', { ch: `t:${threadId}`, afterSeq: cursor });
        console.log(`# RECONNECT attach afterSeq=${cursor} -> ${JSON.stringify(att.result)}`);
        const again = await answerOn.waitFor((f) => f.name === 'permission_request', 20_000, 'replayed permission_request');
        requestId = again.args.requestId;
        console.log(`# replayed prompt id ${requestId} (same as before: ${requestId === req.args.requestId}, reopen flag: ${again.reopen === true})`);
        if (requestId !== req.args.requestId || again.reopen !== true) verdict(false, 'prompt was not replayed with the same id');
      }
      const res = await answerOn.cmd('resolve.permission', { threadId, requestId, allow: true });
      console.log(`# resolve.permission allow -> ${res.type}`);
      await answerOn.waitFor(idleAfterDone(answerOn), 120_000, 'done + idle');
      const msg = lastMessage(answerOn);
      const ran = [c, answerOn].some((x) => x.events().some((f) => f.name === 'onToolUse' && f.args[0]?.name === 'Bash'));
      verdict(res.type === 'ack' && /hello-from-bash/.test(msg), `allow resolved the ${drop ? 'replayed ' : ''}prompt and the turn proceeded (Bash tool_use seen: ${ran}; reply: ${JSON.stringify(msg).slice(0, 100)})`);
      break;
    }

    case 'remember': {
      const [cwd, word] = rest;
      console.log(`# open: ${JSON.stringify((await c.cmd('session.open', { threadId, spec: spec(cwd) })).result)}`);
      await c.cmd('attach', { ch: `t:${threadId}`, afterSeq: 0 });
      await sendAndWatch(`Remember this: the secret word is ${word}. Reply with only the word "noted".`);
      await c.waitFor(idleAfterDone(c), 120_000, 'done + idle');
      const sid = c.events().find((f) => f.name === 'onDone')?.args[0];
      verdict(!!sid, `turn 1 done, native session ${sid}`);
      break;
    }

    case 'long-turn': {
      const [cwd] = rest;
      await c.cmd('session.open', { threadId, spec: spec(cwd) });
      await c.cmd('attach', { ch: `t:${threadId}`, afterSeq: 0 });
      await sendAndWatch('Use the Bash tool to run exactly: touch long-started.flag && sleep 120 . Do nothing else. When it finishes reply "slept".');
      const req = await c.waitFor((f) => f.name === 'permission_request', 120_000, 'permission_request');
      await c.cmd('resolve.permission', { threadId, requestId: req.args.requestId, allow: true });
      await c.waitFor((f) => f.name === 'onToolUse' && f.args[0]?.name === 'Bash', 60_000, 'Bash tool_use');
      await sleep(1500);
      console.log('READY-TO-KILL: turn is mid-flight (Bash `sleep 120` running)');
      process.exit(0);
      break;
    }

    case 'after-kill': {
      const att = await c.cmd('attach', { ch: `t:${threadId}`, afterSeq: 0 });
      console.log(`# attach afterSeq=0 -> ${JSON.stringify(att.result)}`);
      await sleep(800);
      const restarted = c.events().find((f) => f.name === 'onError' && f.args[0]?.name === 'daemon_restarted');
      const interrupted = c.events().some((f) => f.name === 'onInterrupted');
      console.log(`# daemon_restarted seen: ${!!restarted}; interrupted seen: ${interrupted}`);
      const before = c.events().length;
      await sendAndWatch('What was the secret word I told you earlier? Reply with only the word.');
      await c.waitFor((f) => f.name === 'onDone' && f.seq > (c.events()[before - 1]?.seq ?? 0), 120_000, 'done after resume');
      const msg = lastMessage(c);
      const expectWord = rest[0] ?? 'pomegranate-42';
      verdict(!!restarted && interrupted && new RegExp(expectWord, 'i').test(msg), `restart surfaced as daemon_restarted+interrupted, follow-up resumed the native session and answered ${JSON.stringify(msg)}`);
      break;
    }

    case 'state': {
      await c.cmd('attach', { ch: `t:${threadId}`, afterSeq: 0 });
      await sleep(1000);
      verdict(true, `${c.events().length} events replayed`);
      break;
    }

    default:
      console.error(`unknown command ${command}`);
      process.exit(2);
  }
}

main().catch((err) => verdict(false, err instanceof Error ? err.message : String(err)));
