#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseDaemon, waitFor } from './codex-candidate-smoke.mjs';

const expected = process.argv[2];
assert.match(expected ?? '', /^\d+\.\d+\.\d+$/);
const home = await mkdtemp(join(tmpdir(), 'agent-threads-claude-candidate-'));
const workspace = join(home, 'workspace');
const turns = [
  { prompt: 'Candidate fixture first prompt.', reply: 'Candidate fixture first response.' },
  { prompt: 'Candidate fixture second prompt.', reply: 'Candidate fixture resumed response.' },
];
const requests = [];
const fixture = createServer(async (req, res) => {
  if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== '/v1/messages') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  if (!payload.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      id: 'msg_aux', type: 'message', role: 'assistant', model: payload.model,
      content: [{ type: 'text', text: 'Candidate fixture' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    return;
  }
  const turn = turns[requests.length];
  requests.push(payload);
  if (!turn) { res.writeHead(500).end(); return; }
  const events = [
    { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: payload.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.reply } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}).listen(0, '127.0.0.1');

let daemon;
let output = '';
try {
  await mkdir(workspace);
  if (!fixture.listening) await once(fixture, 'listening');
  const env = {
    PATH: process.env.PATH, HOME: home, DATA_DIR: join(home, 'data'),
    ANTHROPIC_API_KEY: 'fixture-only-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fixture.address().port}`,
    AGENT_THREADS_HARNESSES: 'claude', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const claude = '/opt/claude/.local/bin/claude';
  assert.equal(execFileSync(claude, ['--version'], { env, encoding: 'utf8', timeout: 5000 }).trim(), `${expected} (Claude Code)`);
  const { token } = JSON.parse(execFileSync('agent-threads', ['token', 'create', '--name', 'smoke', '--scope', 'control', '--json'], { env, encoding: 'utf8', timeout: 5000 }));
  daemon = spawn('agent-threads', ['serve', '--port', '0', '--workspace', workspace, '--claude-binary', claude], { env });
  daemon.stdout.on('data', (chunk) => { output += chunk; });
  daemon.stderr.on('data', (chunk) => { output += chunk; });
  const port = await waitFor(() => {
    assert.equal(daemon.exitCode, null, 'Claude candidate daemon exited');
    return /listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1];
  }, 'Claude candidate daemon to listen');
  await exerciseDaemon(port, token, workspace, turns, { harness: 'claude', model: 'sonnet' });
  assert.equal(requests.length, 2);
  const history = JSON.stringify(requests[1].messages);
  for (const text of [turns[0].prompt, turns[0].reply, turns[1].prompt]) assert.ok(history.includes(text), `missing transcript: ${text}`);
  console.log('PASS resumed Claude request includes prior user and assistant history');
} catch (error) {
  if (output) console.error(output);
  throw error;
} finally {
  if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, 'exit');
    daemon.kill('SIGKILL');
    await exited;
  }
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  await rm(home, { recursive: true, force: true });
}
