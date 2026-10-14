#!/usr/bin/env node
/**
 * Daemon smoke test: run the BUNDLE (dist/agent-threads.cjs) with plain `node`
 * in a throwaway data dir, then prove it serves /healthz and completes a
 * hello -> welcome -> session.open -> session.send -> done round trip.
 * Build first: `npm run build:daemon`.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist/agent-threads.cjs');
if (!existsSync(bundle)) { console.error('dist/agent-threads.cjs missing; run npm run build:daemon'); process.exit(1); }

const dataDir = mkdtempSync(join(tmpdir(), 'agent-threads-smoke-'));
const env = { ...process.env, DATA_DIR: dataDir };
let child;
try {
  const created = execFileSync(process.execPath, [bundle, 'token', 'create', '--name', 'smoke', '--scope', 'admin'], { env, encoding: 'utf8' });
  const token = /token:\s+(\S+)/.exec(created)?.[1];
  if (!token) throw new Error(`no token in output:\n${created}`);

  child = spawn(process.execPath, [bundle, 'serve', '--port', '0', '--fake-harness'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error(`daemon did not report a port:\n${buf}`)), 10_000);
    child.once('exit', (c) => rej(new Error(`daemon exited early (${c}):\n${buf}`)));
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buf);
      if (m) { clearTimeout(t); res(Number(m[1])); }
    });
  });

  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  if (health.ok !== true || health.protocol !== 1) throw new Error(`bad healthz: ${JSON.stringify(health)}`);
  console.log(`healthz ok on :${port} ->`, JSON.stringify(health));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (o) => ws.send(JSON.stringify({ v: 1, ...o }));
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 200; i++) { const f = frames.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  send({ cmdId: 'h', type: 'hello', protocol: 1, client: 'cli', clientVersion: 'smoke', token });
  await waitFor((f) => f.type === 'welcome', 'welcome');
  send({ cmdId: 'o', type: 'session.open', threadId: 'smoke1', spec: { harness: 'claude', cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '' } });
  await waitFor((f) => f.type === 'ack' && f.cmdId === 'o', 'open ack');
  send({ cmdId: 'a', type: 'attach', ch: 't:smoke1', afterSeq: 0 });
  send({ cmdId: 's', type: 'session.send', threadId: 'smoke1', text: '/tokens 20', userMessageUuid: 'u1' });
  await waitFor((f) => f.type === 'event' && f.name === 'onDone', 'onDone');
  const tokens = frames.filter((f) => f.name === 'onToken').length;
  if (tokens !== 20) throw new Error(`expected 20 tokens, saw ${tokens}`);
  console.log(`session round trip ok (${tokens} tokens then onDone)`);
  ws.close();
  console.log('daemon bundle starts and serves with plain node');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
  rmSync(dataDir, { recursive: true, force: true });
}
