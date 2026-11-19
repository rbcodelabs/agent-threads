#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function assertSmokeTurn(frames, expectedText) {
  const error = frames.find((frame) => frame.type === 'event' && frame.name === 'onError');
  assert.ok(!error, `Codex turn failed: ${JSON.stringify(error?.args)}`);
  const events = frames.filter((frame) => frame.type === 'event');
  const done = events.find((frame) => frame.name === 'onDone');
  const nativeId = done?.args?.[0];
  assert.ok(typeof nativeId === 'string' && nativeId, 'completed turn must include a native Codex session ID');
  const streamedText = events.filter((frame) => frame.name === 'onToken').map((frame) => frame.args[0]).join('');
  assert.equal(streamedText, expectedText, 'daemon must stream the model fixture response');
  return nativeId;
}

const model = 'codex-smoke-fixture';

function startModelFixture(turns, requests) {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end();
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const turn = turns[requests.length];
      requests.push(payload);
      assert.equal(payload.model, model);
      assert.ok(turn, 'unexpected request to fixture');
      const item = {
        type: 'message',
        role: 'assistant',
        id: `msg_${requests.length}`,
        content: [{ type: 'output_text', text: turn.reply }],
      };
      const id = `resp_${requests.length}`;
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.added', item: { ...item, content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: turn.reply },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
      ];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  }).listen(0, '127.0.0.1');
}

async function waitFor(read, description) {
  const deadline = Date.now() + 25_000;
  do {
    const result = read();
    if (result) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}.`);
}

async function exerciseDaemon(port, token, workspace, turns) {
  const baseUrl = `127.0.0.1:${port}`;
  const health = await fetch(`http://${baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.ok((await health.json()).ok, 'candidate daemon health check must pass');

  const ws = new WebSocket(`ws://${baseUrl}/v1/ws`);
  const frames = [];
  ws.addEventListener('message', ({ data }) => frames.push(JSON.parse(data)));
  await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
  const threadId = randomUUID();
  async function command(type, details, expected = 'ack') {
    const cmdId = randomUUID();
    const from = frames.length;
    ws.send(JSON.stringify({ v: 1, cmdId, type, ...details }));
    const reply = await waitFor(() => {
      assert.equal(ws.readyState, WebSocket.OPEN, `socket closed waiting for ${type}`);
      return frames.slice(from).find((frame) => frame.cmdId === cmdId || (type === 'hello' && frame.type === 'welcome'));
    }, type);
    assert.equal(reply.type, expected, `${type}: ${reply.message ?? reply.type}`);
    return reply;
  }

  try {
    const welcome = await command('hello', { protocol: 1, client: 'cli', clientVersion: 'smoke', token }, 'welcome');
    assert.ok(welcome.capabilities.includes('harness.codex'), 'candidate daemon must advertise Codex');
    await command('session.open', { threadId, spec: { cwd: workspace, harness: 'codex', model, permissionMode: 'default', extraEnvRaw: '' } });
    await command('attach', { ch: `t:${threadId}`, afterSeq: 0 });
    const sessionIds = [];
    for (const turn of turns) {
      const from = frames.length;
      await command('session.send', { threadId, text: turn.prompt, userMessageUuid: randomUUID() });
      await waitFor(() => frames.slice(from).find((frame) => frame.type === 'event' && ['onDone', 'onError'].includes(frame.name)), 'Codex turn completion');
      sessionIds.push(assertSmokeTurn(frames.slice(from), turn.reply));
      await command('session.close', { threadId });
    }
    assert.equal(sessionIds[0], sessionIds[1], 'cold resume must retain the native Codex session ID');
    console.log('PASS candidate daemon health, Codex start, streamed turn, and cold resume');
  } finally {
    ws.close();
  }
}

async function main(expectedVersion) {
  assert.ok(expectedVersion, 'Usage: node scripts/codex-candidate-smoke.mjs <expected-version>');
  const data = await mkdtemp(join(tmpdir(), 'agent-threads-codex-smoke-'));
  const workspace = join(data, 'workspace');
  const codexHome = join(data, 'codex');
  const env = {
    PATH: process.env.PATH,
    HOME: data,
    CODEX_HOME: codexHome,
    CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1',
    DATA_DIR: data,
    AGENT_THREADS_HARNESSES: 'codex',
  };
  const codex = '/opt/harnesses/bin/codex';
  const turns = [
    { prompt: 'Candidate smoke first prompt.', reply: 'Candidate smoke first response.' },
    { prompt: 'Candidate smoke second prompt.', reply: 'Candidate smoke resumed response.' },
  ];
  const requests = [];
  let fixture;
  let daemon;
  let output = '';
  try {
    const actual = execFileSync(codex, ['--version'], { env, encoding: 'utf8', timeout: 5000 }).trim();
    assert.equal(actual, `codex-cli ${expectedVersion}`, 'candidate image must carry the reviewed exact version');
    console.log(`PASS ${actual}`);
    await mkdir(workspace);
    await mkdir(codexHome);
    fixture = startModelFixture(turns, requests);
    await once(fixture, 'listening');
    await writeFile(join(codexHome, 'config.toml'), [
      `model = "${model}"`,
      'model_provider = "fixture"',
      '[model_providers.fixture]',
      'name = "Codex smoke fixture"',
      `base_url = "http://127.0.0.1:${fixture.address().port}/v1"`,
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      '',
    ].join('\n'));
    const created = execFileSync('agent-threads', ['token', 'create', '--name', 'smoke', '--scope', 'control', '--json'], { env, encoding: 'utf8', timeout: 5000 });
    const { token } = JSON.parse(created);
    daemon = spawn('agent-threads', ['serve', '--port', '0', '--workspace', workspace, '--codex-binary', codex], { env });
    daemon.stdout.on('data', (chunk) => { output += chunk; });
    daemon.stderr.on('data', (chunk) => { output += chunk; });
    let daemonError;
    daemon.on('error', (error) => { daemonError = error; });
    const port = await waitFor(() => {
      if (daemonError) throw daemonError;
      assert.equal(daemon.exitCode, null, 'candidate daemon exited before listening');
      return /listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1];
    }, 'candidate daemon to listen');

    await exerciseDaemon(port, token, workspace, turns);
    assert.equal(requests.length, 2, 'both turns must reach the loopback model fixture');
    const resumedInput = JSON.stringify(requests[1].input);
    for (const text of [turns[0].prompt, turns[0].reply, turns[1].prompt]) {
      assert.ok(resumedInput.includes(text), `resumed turn must carry transcript: ${text}`);
    }
    console.log('PASS resumed model request includes prior user and assistant history');
  } catch (error) {
    if (output) console.error(output);
    throw error;
  } finally {
    if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit');
      daemon.kill('SIGKILL');
      await exited;
    }
    if (fixture) {
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
    await rm(data, { force: true, recursive: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main(process.argv[2]);
}
