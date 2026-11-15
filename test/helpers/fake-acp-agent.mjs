#!/usr/bin/env node
/**
 * A fake ACP agent (NDJSON JSON-RPC over stdio) that plays back the frames recorded from the real Antigravity CLI
 * (`agy acp` 1.5.8, fixtures in test/fixtures/antigravity). Tests spawn it in place of `agy`.
 *
 * Which scenario runs is chosen by a marker in the prompt text, so one process can serve a whole conversation:
 *   TEXT (default)  thought + message chunks + usage, `end_turn`
 *   EDIT            a `write_file` tool with a diff, one `session/request_permission`, then completed (allow) or failed (deny)
 *   SHELL           a `run_command` tool with one permission request
 *   ASK_QUESTION    an `ask_question` tool that sends `elicitation/create` when `clientCapabilities.elicitation.form` is
 *                   advertised, or falls back to `[1]`/`[2]` bullets in chat when it is not
 *   HANG            streams one chunk, then waits for `session/cancel` and answers `stopReason: cancelled`
 *   CRASH           streams one chunk, then exits with code 1 mid-turn
 *
 * Environment:
 *   FAKE_ACP_LOG               file; every message received from the client is appended as one JSON line
 *   FAKE_ACP_START_DELAY_MS    delay before answering `initialize` (slow cold start)
 *   FAKE_ACP_KNOWN_SESSIONS    comma list of session ids `session/load` replays history for; any other id "succeeds"
 *                              with no replay, exactly like the real agent
 *   FAKE_ACP_NO_REPLY_TO       method name the agent never answers (hung request)
 *   FAKE_ACP_FAIL_LOAD         answer `session/load` with a JSON-RPC error
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'antigravity', name), 'utf8'));
const initializeResponse = fixture('initialize-response.json').result;
const sessionNewResponse = fixture('session-new-response.json').result;
const stream = fixture('prompt-edit-shell-stream.json');
const denyFixture = fixture('deny-and-mode.json');
const cancelFixture = fixture('cancel.json');
const loadReplay = fixture('load-replay.json');
const loadUnknown = fixture('load-unknown-id.json');
const askQuestionFixture = fixture('ask-question-elicitation.json');

const log = process.env.FAKE_ACP_LOG;
const known = new Set((process.env.FAKE_ACP_KNOWN_SESSIONS ?? '').split(',').filter(Boolean));
let counter = 0;
let currentSession = '';
let permissionId = 0;
let supportsFormElicitation = false;
let cancelledDuringPrompt = false;
const pendingClientReplies = new Map();
let cancelResolve = null;

function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function update(sessionId, body) { write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } }); }
const withSession = (value, sessionId) => JSON.parse(JSON.stringify(value).replaceAll('SESSION-ID', sessionId));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** First recorded `session/update` of a kind (and optionally a tool name), used as a template for a scenario. */
function recorded(sessionUpdate, predicate = () => true) {
  const frame = stream.find((m) => m.method === 'session/update' && m.params.update.sessionUpdate === sessionUpdate && predicate(m.params.update));
  if (!frame) throw new Error(`fixture has no ${sessionUpdate} frame`);
  return frame.params.update;
}
const toolFrame = (kind, name, status) => recorded(kind, (u) => u.name === name && (status === undefined || u.status === status));

function requestPermission(toolCall) {
  const id = String(++permissionId);
  write({
    jsonrpc: '2.0', id, method: 'session/request_permission',
    params: { sessionId: currentSession, toolCall, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] },
  });
  return new Promise((resolve) => pendingClientReplies.set(id, resolve));
}

function requestElicitation(params) {
  const id = String(++permissionId);
  write({ jsonrpc: '2.0', id, method: 'elicitation/create', params });
  return new Promise((resolve) => pendingClientReplies.set(id, resolve));
}

function hasPriorPromptInLog(sessionId) {
  if (!log || !fs.existsSync(log)) return false;
  try {
    return fs.readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        const entry = JSON.parse(line);
        return entry?.method === 'session/prompt' && entry?.params?.sessionId === sessionId;
      });
  } catch {
    return false;
  }
}

function appendBrainSteps(brainDir, conversationId, steps) {
  const dir = path.join(brainDir, conversationId, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'transcript_full.jsonl');
  const payload = steps.map((step) => JSON.stringify(step)).join('\n') + '\n';
  fs.appendFileSync(file, payload, 'utf8');
}

async function runPrompt(sessionId, text) {
  update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
  update(sessionId, { sessionUpdate: 'usage_update', used: 100, size: 1048576 });
  if (text.includes('SUBAGENT')) {
    const subTool = {
      toolCallId: 'sub-call-1',
      name: 'invoke_subagent',
      kind: 'other',
      title: 'Invoke subagent',
      rawInput: { TypeName: 'research', Role: 'Auth Researcher', Prompt: 'Inspect auth flow', Model: 'flash' },
    };
    update(sessionId, { sessionUpdate: 'tool_call', ...subTool, status: 'in_progress' });
    if (text.includes('SUBAGENT_BRAIN') && process.env.FAKE_ACP_BRAIN_DIR) {
      appendBrainSteps(process.env.FAKE_ACP_BRAIN_DIR, sessionId, [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: text },
        {
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: '',
          tool_calls: [{ id: 'sub-call-1', name: 'invoke_subagent', args: subTool.rawInput }],
        },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          content: 'Created the following subagent:\n{\n  "conversationId": "child-sub-1",\n  "logAbsoluteUri": "file:///tmp/transcript.jsonl"\n}',
        },
        {
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'Waiting on Auth Researcher.',
        },
      ]);
    }
    update(sessionId, { sessionUpdate: 'tool_call_update', ...subTool, status: 'completed' });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting on Auth Researcher.' } });
    return stream.find((m) => m.result?.stopReason).result;
  }
  if (text.includes('CRASH')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to crash' } });
    await sleep(20);
    process.exit(1);
  }
  if (text.includes('HANG')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
    await new Promise((resolve) => { cancelResolve = resolve; });
    return withSession(cancelFixture.response, sessionId).result;
  }
  if (text.includes('ASK_QUESTION')) {
    const start = withSession(askQuestionFixture.toolCall.params.update, sessionId);
    const pending = withSession(askQuestionFixture.toolPending.params.update, sessionId);
    update(sessionId, start);
    update(sessionId, pending);
    if (!supportsFormElicitation) {
      update(sessionId, { ...start, sessionUpdate: 'tool_call_update', status: 'completed' });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Which events should pop a live alert?\n\n- [1] (Recommended) Direct personal triggers only\n- [2] All unread notifications' },
      });
      return stream.find((m) => m.result?.stopReason).result;
    }
    const elicitationParams = withSession(askQuestionFixture.elicitationRequest.params, sessionId);
    if (text.includes('CRASH_DURING_ELICITATION')) {
      const id = String(++permissionId);
      write({ jsonrpc: '2.0', id, method: 'elicitation/create', params: elicitationParams });
      await sleep(30);
      process.exit(1);
    }
    const reply = await Promise.race([
      requestElicitation(elicitationParams),
      new Promise((resolve) => { cancelResolve = () => resolve({ __cancelled: true }); }),
    ]);
    cancelResolve = null;
    if (cancelledDuringPrompt || reply?.__cancelled) {
      return withSession(cancelFixture.response, sessionId).result;
    }
    update(sessionId, { ...start, sessionUpdate: 'tool_call_update', status: 'in_progress' });
    update(sessionId, withSession(askQuestionFixture.toolCompleted.params.update, sessionId));
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Elicitation result: ${JSON.stringify(reply)}` },
    });
    return stream.find((m) => m.result?.stopReason).result;
  }
  if (text.includes('EDIT')) {
    const start = toolFrame('tool_call', 'write_file');
    update(sessionId, start);
    update(sessionId, { ...start, sessionUpdate: 'tool_call_update', status: 'pending' });
    const permissionTool = withSession(stream.find((m) => m.method === 'session/request_permission' && m.params.toolCall.name === 'write_file').params.toolCall, sessionId);
    const reply = await requestPermission(permissionTool);
    if (reply?.outcome?.outcome === 'selected' && reply.outcome.optionId === 'allow') {
      update(sessionId, { ...start, sessionUpdate: 'tool_call_update', status: 'in_progress' });
      update(sessionId, { ...toolFrame('tool_call_update', 'write_file', 'completed') });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Created the file.' } });
    } else {
      // Recorded from the real agent: a refused edit ends as a `failed` tool update, then the agent explains.
      const failed = denyFixture.stream.find((m) => m.params.update.sessionUpdate === 'tool_call_update' && m.params.update.status === 'failed');
      update(sessionId, { ...start, sessionUpdate: 'tool_call_update', status: 'failed', ...(failed ? { rawOutput: failed.params.update.rawOutput } : {}) });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The edit was refused.' } });
    }
    return stream.find((m) => m.result?.stopReason).result;
  }
  if (text.includes('SHELL') || (process.env.FAKE_ACP_WAKEUP_RESUME_MODE === 'SHELL' && text.includes('Resuming background wakeup'))) {
    const start = toolFrame('tool_call', 'run_command');
    update(sessionId, start);
    update(sessionId, { ...start, sessionUpdate: 'tool_call_update', status: 'pending' });
    const permissionFrame = stream.find((m) => m.method === 'session/request_permission' && m.params.toolCall.kind === 'execute');
    const reply = await requestPermission(withSession(permissionFrame.params.toolCall, sessionId));
    if (reply?.outcome?.outcome === 'selected' && reply.outcome.optionId === 'allow') {
      update(sessionId, { ...toolFrame('tool_call_update', 'run_command', 'completed') });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Ran the command.' } });
    } else {
      update(sessionId, { ...start, sessionUpdate: 'tool_call_update', status: 'failed' });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The command was refused.' } });
    }
    return stream.find((m) => m.result?.stopReason).result;
  }
  update(sessionId, recorded('agent_thought_chunk'));
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from Antigravity.' } });
  update(sessionId, { sessionUpdate: 'usage_update', used: 12463, size: 1048576 });
  return stream.find((m) => m.result?.stopReason).result;
}

async function handle(message) {
  if (log) fs.appendFileSync(log, `${JSON.stringify(message)}\n`);
  if (message.method === undefined && message.id !== undefined) {
    // A reply to one of our requests (permission).
    pendingClientReplies.get(String(message.id))?.(message.result);
    pendingClientReplies.delete(String(message.id));
    return;
  }
  if (process.env.FAKE_ACP_NO_REPLY_TO === message.method) return;
  const { id, method, params } = message;
  const ok = (result) => write({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      supportsFormElicitation = Boolean(params?.clientCapabilities?.elicitation?.form);
      await sleep(Number(process.env.FAKE_ACP_START_DELAY_MS ?? 0));
      ok(initializeResponse);
      return;
    case 'session/new': {
      currentSession = `fake-session-${++counter}`;
      ok(withSession(sessionNewResponse, currentSession));
      update(currentSession, { sessionUpdate: 'usage_update', used: 0, size: 1048576 });
      return;
    }
    case 'session/load': {
      if (process.env.FAKE_ACP_FAIL_LOAD) { write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'session not found' } }); return; }
      currentSession = String(params.sessionId);
      if (known.has(currentSession) || hasPriorPromptInLog(currentSession)) {
        // Real behaviour: history replays BEFORE the load response arrives.
        for (const frame of loadReplay.replay) update(currentSession, frame.params.update);
        ok(withSession(loadReplay.response.result, currentSession));
      } else {
        ok(withSession(loadUnknown.response.result, currentSession));
      }
      return;
    }
    case 'session/set_mode':
      ok({});
      update(String(params.sessionId), { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
      return;
    case 'session/set_config_option':
    case 'session/set_model':
      ok(method === 'session/set_model' ? {} : { configOptions: sessionNewResponse.configOptions });
      return;
    case 'session/prompt': {
      cancelledDuringPrompt = false;
      const text = (params.prompt ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const result = await runPrompt(String(params.sessionId), text);
      ok(result);
      return;
    }
    case 'session/cancel':
      cancelledDuringPrompt = true;
      cancelResolve?.();
      cancelResolve = null;
      return;
    case 'session/close':
      ok({});
      return;
    default:
      if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  void handle(message);
});
rl.on('close', () => process.exit(0));
