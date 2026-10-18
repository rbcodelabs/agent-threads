import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  OPENCODE_VERIFIED_VERSION,
  OpenCodeSession,
  OpenCodeV2EventAdapter,
  openCodeAuthHeader,
  openCodeConfigV2,
  openCodeSkillsConfig,
  openCodeGenerationFromVersion,
  openCodePermissionRules,
  openCodeSseData,
  openCodeToolName,
  openCodeToolSummary,
  parseOpenCodeBanner,
  type OpenCodeEvent,
  type OpenCodeLauncher,
  type OpenCodeTransport,
} from '../../src/OpenCodeSession';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import type { SessionCallbacks } from '../../src/ClaudeSession';

/** Frames recorded from a live opencode 2.0.32 server (see test/fixtures/opencode-v2). */
function fixture(name: string): OpenCodeEvent[] {
  return JSON.parse(readFileSync(join(__dirname, '../fixtures/opencode-v2', `${name}.json`), 'utf8'));
}

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('OpenCode v2 launch helpers', () => {
  it('verifies against the v2 release the fixtures were recorded on', () => {
    expect(OPENCODE_VERIFIED_VERSION).toBe('2.0.32');
  });

  it('parses the v2 banner (URL plus Basic-auth password) and the v1 banner (URL only)', () => {
    expect(parseOpenCodeBanner('server listening on http://127.0.0.1:50178\nserver password koM4wk_JK2l-Bs\n')).toEqual({
      baseUrl: 'http://127.0.0.1:50178', password: 'koM4wk_JK2l-Bs',
    });
    expect(parseOpenCodeBanner('opencode server listening on http://127.0.0.1:4096')).toEqual({ baseUrl: 'http://127.0.0.1:4096', password: undefined });
    expect(parseOpenCodeBanner('starting...')).toEqual({ baseUrl: undefined, password: undefined });
  });

  it('builds the Basic auth header for user opencode', () => {
    expect(openCodeAuthHeader('pw')).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`);
  });

  it('picks the API generation from the CLI version', () => {
    expect(openCodeGenerationFromVersion('opencode v2.0.32\n')).toBe('v2');
    expect(openCodeGenerationFromVersion('1.18.32')).toBe('v1');
    expect(openCodeGenerationFromVersion('3.1.0')).toBe('v2');
    expect(openCodeGenerationFromVersion('garbage')).toBeUndefined();
  });

  it('extracts SSE data and skips heartbeat comments', () => {
    expect(openCodeSseData(': heartbeat')).toBeUndefined();
    expect(openCodeSseData('data: {"type":"server.connected"}')).toBe('{"type":"server.connected"}');
    expect(openCodeSseData('id: 1\ndata: a\ndata: b')).toBe('a\nb');
  });

  it('expresses the permission policy as ordered v2 rules (last match wins)', () => {
    const rules = openCodePermissionRules();
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'ask' });
    expect(rules).toContainEqual({ action: 'read', resource: '*', effect: 'allow' });
    expect(rules).toContainEqual({ action: 'agent-threads_*', resource: '*', effect: 'allow' });
    expect(rules.some((rule) => rule.effect === 'deny')).toBe(false);
    const denied = openCodePermissionRules(['Bash']);
    expect(denied.slice(-2)).toEqual([
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'bash', resource: '*', effect: 'deny' },
    ]);
  });

  it('converts MCP entries to the v2 mcp.servers schema', () => {
    const config = openCodeConfigV2(undefined, {
      local: { type: 'local', command: ['node', 's.js'], enabled: true, environment: { A: '1' }, timeout: 5000 },
      remote: { type: 'remote', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' }, oauth: false, enabled: true },
      off: { type: 'remote', url: 'http://x', enabled: false },
    });
    expect(config.mcp).toEqual({ servers: {
      local: { type: 'local', command: ['node', 's.js'], environment: { A: '1' } },
      remote: { type: 'remote', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' }, oauth: false },
      off: { type: 'remote', url: 'http://x', disabled: true },
    } });
    expect(openCodeConfigV2(undefined, {})).not.toHaveProperty('mcp');
  });

  it('registers skill roots through the native skills.paths key, deduplicated, and omits it when empty', () => {
    expect(openCodeSkillsConfig(['/a/skills', '/b/skills', '/a/skills', ''])).toEqual({ skills: { paths: ['/a/skills', '/b/skills'] } });
    expect(openCodeSkillsConfig([])).toEqual({});
    expect(openCodeConfigV2(undefined, {}, ['/a/skills']).skills).toEqual({ paths: ['/a/skills'] });
    expect(openCodeConfigV2(undefined, {})).not.toHaveProperty('skills');
  });

  it('names v2 tools for the shared renderer', () => {
    expect(openCodeToolName('shell')).toBe('Bash');
    expect(openCodeToolName('execute')).toBe('Execute');
    expect(openCodeToolSummary('execute', { code: '\nreturn "hi";\nmore' })).toBe('return "hi";');
  });
});

// ── Adapter ────────────────────────────────────────────────────────────────

describe('OpenCodeV2EventAdapter', () => {
  it('maps execution lifecycle events onto v1 status/idle/error events', () => {
    const adapter = new OpenCodeV2EventAdapter();
    expect(adapter.adapt({ type: 'session.execution.started', data: { sessionID: 's' } })).toEqual([
      { type: 'session.status', properties: { sessionID: 's', status: { type: 'busy' } } },
    ]);
    expect(adapter.adapt({ type: 'session.execution.succeeded', data: { sessionID: 's' } })).toEqual([
      { type: 'session.idle', properties: { sessionID: 's' } },
    ]);
    expect(adapter.adapt({ type: 'session.execution.failed', data: { sessionID: 's', error: { type: 'provider.no-route', message: 'Model unavailable' } } })).toEqual([
      { type: 'session.error', properties: { sessionID: 's', error: { name: 'provider.no-route', message: 'Model unavailable' } } },
      { type: 'session.idle', properties: { sessionID: 's' } },
    ]);
    expect(adapter.adapt({ type: 'session.execution.interrupted', data: { sessionID: 's', reason: 'user' } })[0].properties.error.name).toBe('MessageAbortedError');
  });

  it('drops housekeeping events', () => {
    const adapter = new OpenCodeV2EventAdapter();
    for (const type of ['server.connected', 'project.updated', 'session.inbox.enqueued', 'session.reasoning.delta', 'session.usage.updated', 'session.step.streamed']) {
      expect(adapter.adapt({ type, data: { sessionID: 's' } })).toEqual([]);
    }
  });

  it('remembers the tool name from input.started and the input from called', () => {
    const adapter = new OpenCodeV2EventAdapter();
    adapter.adapt({ type: 'session.tool.input.started', data: { sessionID: 's', assistantMessageID: 'm', id: 'c1', name: 'shell' } });
    const [called] = adapter.adapt({ type: 'session.tool.called', created: 100, data: { sessionID: 's', assistantMessageID: 'm', id: 'c1', input: { command: 'ls' } } });
    expect(called.properties.part).toMatchObject({ type: 'tool', tool: 'shell', callID: 'c1', state: { status: 'running', input: { command: 'ls' } } });
    const [done] = adapter.adapt({ type: 'session.tool.success', created: 130, data: { sessionID: 's', assistantMessageID: 'm', id: 'c1', content: [] } });
    expect(done.properties.part.state).toEqual({ status: 'completed', input: { command: 'ls' }, time: { start: 100, end: 130 } });
  });

  it('ignores forms that are not questions', () => {
    const adapter = new OpenCodeV2EventAdapter();
    expect(adapter.adapt({ type: 'form.created', data: { form: { id: 'frm_1', sessionID: 's', title: 'Other', metadata: {}, fields: [] } } })).toEqual([]);
  });
});

// ── Session with a fake v2 transport ───────────────────────────────────────

const SID = 'ses_root';

function harness(options: { resumeStatus?: number } = {}) {
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  let emit: (event: OpenCodeEvent) => void = () => {};
  let launched: Parameters<OpenCodeLauncher>[0] | undefined;
  const transport: OpenCodeTransport = {
    generation: 'v2',
    request: vi.fn(async (method, path, body) => {
      requests.push({ method, path, body });
      if (method === 'POST' && path === '/api/session') return { status: 200, body: { data: { id: SID } } };
      if (method === 'GET' && path.startsWith('/api/session/')) {
        const status = options.resumeStatus ?? 200;
        return status === 200 ? { status, body: { data: { id: decodeURIComponent(path.split('/')[3]) } } } : { status, body: { _tag: 'SessionNotFoundError' } };
      }
      if (path === '/api/model') {
        return { status: 200, body: { data: [
          { id: 'qwen3.8:27b', providerID: 'llm-server', name: 'Qwen 3.8 27B', enabled: true, limit: { context: 200_000, output: 32_000 } },
          { id: 'off', providerID: 'llm-server', name: 'Off', enabled: false, limit: { context: 1 } },
        ] } };
      }
      if (path === '/api/provider') return { status: 200, body: { data: [{ id: 'llm-server', name: 'Homelab GPU (Ollama)' }] } };
      if (method === 'POST' && path.endsWith('/prompt')) return { status: 200, body: { data: { id: 'msg_1' } } };
      return { status: 204, body: undefined };
    }),
    subscribe: (onEvent) => { emit = onEvent; },
    close: vi.fn(),
  };
  const launcher: OpenCodeLauncher = async (opts) => { launched = opts; return transport; };
  const callbacks = {
    onToken: vi.fn(), onToolUse: vi.fn(), onMessage: vi.fn(), onRecap: vi.fn(), onDone: vi.fn(),
    onInterrupted: vi.fn(), onError: vi.fn(),
    onPermissionRequest: vi.fn(async () => true),
    onAskUserQuestion: vi.fn(async () => ({ '0': 'Blue' })),
    onAskUserQuestionCanceled: vi.fn(),
    onOpenNewTab: vi.fn(), onToolResult: vi.fn(), onFilesEdited: vi.fn(), onTaskEvent: vi.fn(),
    onUsage: vi.fn(), onCapabilitiesDiscovered: vi.fn(), onCompact: vi.fn(), onEnterPlanMode: vi.fn(), onApiRetry: vi.fn(),
    onRawEvent: vi.fn(),
  } as unknown as SessionCallbacks & Record<string, ReturnType<typeof vi.fn>>;
  const session = new OpenCodeSession('/bin/opencode', launcher);
  const baseOptions: HarnessSessionOptions = {
    cwd: '/work', permissionMode: 'default', extraEnvRaw: '', callbacks,
    model: 'llm-server/qwen3.8:27b', appendSystemPrompt: 'env context',
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const replay = (events: OpenCodeEvent[]) => { for (const event of events) emit(event); };
  return { session, callbacks, requests, emit: (e: OpenCodeEvent) => emit(e), replay, baseOptions, flush, launched: () => launched };
}

describe('OpenCodeSession against the v2 API', () => {
  it('passes skill roots to the v2 server as skills.paths', async () => {
    const h = harness();
    await h.session.start({ ...h.baseOptions, opencode: { skillRoots: ['/vault/skill-sources/cos/skills'] } });
    expect(h.launched()?.configV2).toMatchObject({ skills: { paths: ['/vault/skill-sources/cos/skills'] } });
  });

  it('launches with the v2 config, creates a located session and discovers models', async () => {
    const h = harness();
    await h.session.start({ ...h.baseOptions, disallowedTools: ['Bash'] });
    await h.flush();
    expect(h.launched()?.configV2).toMatchObject({ permissions: expect.arrayContaining([{ action: 'shell', resource: '*', effect: 'deny' }]) });
    expect(h.requests.find((r) => r.path === '/api/session')).toEqual({
      method: 'POST', path: '/api/session',
      body: { title: 'Agent Threads', agent: 'build', model: { providerID: 'llm-server', id: 'qwen3.8:27b' }, location: { directory: '/work' } },
    });
    expect(h.callbacks.onCapabilitiesDiscovered).toHaveBeenCalledWith(
      [{ value: 'llm-server/qwen3.8:27b', displayName: 'Homelab GPU (Ollama): Qwen 3.8 27B', description: '' }], [],
    );
  });

  it('surfaces a create failure with a version hint', async () => {
    const h = harness();
    const failing = h.launched; void failing;
    const session = new OpenCodeSession('/bin/opencode', async () => ({
      generation: 'v2', subscribe: () => {}, close: () => {},
      request: async () => ({ status: 405, body: '<html>ui</html>' }),
    }));
    await expect(session.start(h.baseOptions)).rejects.toThrow(/could not create a session \(405\).*2\.0\.32/s);
  });

  it('sends the prompt with images and pushes the system prompt once', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.requests.length = 0;
    h.session.send('hello', [{ mediaType: 'image/png', base64: 'AAAA' } as any]);
    await h.flush(); await h.flush();
    expect(h.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'PUT /api/experimental/session/ses_root/instructions/entries/agent-threads',
      'POST /api/session/ses_root/prompt',
    ]);
    expect(h.requests[0].body).toEqual({ value: 'env context' });
    expect(h.requests[1].body).toEqual({
      text: expect.stringMatching(/^hello\n\n\[Current local time: /),
      files: [{ uri: 'data:image/png;base64,AAAA', name: 'image-1' }],
    });
    expect(h.session.turnInFlight).toBe(true);

    // Second turn: agent, model and system prompt are unchanged, so only the prompt is sent.
    h.replay([{ type: 'session.execution.started', data: { sessionID: SID } }, { type: 'session.execution.succeeded', data: { sessionID: SID } }]);
    h.requests.length = 0;
    h.session.send('again');
    await h.flush();
    expect(h.requests.map((r) => r.path)).toEqual(['/api/session/ses_root/prompt']);
  });

  it('switches agent and model between turns', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    await h.session.setPermissionMode('plan');
    await h.session.setModel('llm-server/gemma4:12b');
    h.requests.length = 0;
    h.session.send('plan it');
    await h.flush(); await h.flush(); await h.flush();
    expect(h.requests.slice(0, 2)).toEqual([
      { method: 'POST', path: '/api/session/ses_root/agent', body: { agent: 'plan' } },
      { method: 'POST', path: '/api/session/ses_root/model', body: { model: { providerID: 'llm-server', id: 'gemma4:12b' } } },
    ]);
    expect(h.callbacks.onEnterPlanMode).toHaveBeenCalled();
  });

  it('resumes through GET /api/session and applies settings on the first turn', async () => {
    const resumed = harness();
    await resumed.session.start({ ...resumed.baseOptions, resume: 'ses_old' });
    expect(resumed.requests.some((r) => r.path === '/api/session' && r.method === 'POST')).toBe(false);
    resumed.requests.length = 0;
    resumed.session.send('next');
    await resumed.flush(); await resumed.flush(); await resumed.flush(); await resumed.flush();
    expect(resumed.requests.map((r) => r.path)).toContain('/api/session/ses_old/prompt');
    expect(resumed.requests.map((r) => r.path)).toContain('/api/session/ses_old/agent');

    const missing = harness({ resumeStatus: 404 });
    await missing.session.start({ ...missing.baseOptions, resume: 'ses_gone', resumeFallbackHistory: '[history]\n\n' });
    missing.session.send('first');
    await missing.flush(); await missing.flush();
    expect(missing.requests.find((r) => r.path.endsWith('/prompt'))?.body.text).toMatch(/^\[history\]\n\nfirst/);
  });

  it('streams a recorded text turn and completes it with usage', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    await h.flush(); // model discovery supplies the context limit
    h.session.send('hi');
    h.replay(fixture('text-turn'));
    expect(h.callbacks.onToken.mock.calls.map((c) => c[0]).join('')).toContain('Hello');
    expect(h.callbacks.onMessage).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onMessage.mock.calls[0][0]).toContain('PINEAPPLE');
    expect(h.callbacks.onDone).toHaveBeenCalledWith(SID, 0, 1);
    expect(h.session.turnInFlight).toBe(false);
    expect(h.callbacks.onUsage).toHaveBeenCalled();
    expect((await h.session.getUsageSnapshot())?.lastTurnTokens).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
    expect(await h.session.getContextUsage()).toMatchObject({ maxTokens: expect.any(Number), model: 'llm-server/qwen3.8:27b' });
  });

  it('runs a recorded tool turn: announce, ask permission, reply once, settle', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('run echo hello');
    h.requests.length = 0;
    h.replay(fixture('tool-permission-allowed'));
    expect(h.callbacks.onToolUse).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bash', summary: 'echo hello', status: 'pending' }));
    expect(h.callbacks.onPermissionRequest).toHaveBeenCalledWith('OpenCode: Bash', 'echo hello');
    await h.flush();
    const reply = h.requests.find((r) => r.path.includes('/permission/'))!;
    expect(reply.method).toBe('POST');
    expect(reply.path).toMatch(/^\/api\/session\/ses_root\/permission\/per_[^/]+\/reply$/);
    expect(reply.body).toEqual({ decision: 'once' });
    expect(h.callbacks.onToolResult).toHaveBeenCalledWith(expect.any(String), 'success', expect.any(Number));
    expect(h.callbacks.onDone).toHaveBeenCalledTimes(1);
  });

  it('rejects permissions per mode and the thread denylist without prompting', async () => {
    const h = harness();
    await h.session.start({ ...h.baseOptions, permissionMode: 'bypassPermissions', disallowedTools: ['Bash'] });
    h.requests.length = 0;
    h.emit({ type: 'permission.asked', data: { id: 'per_a', sessionID: SID, action: 'shell', resources: ['rm -rf /'] } });
    h.emit({ type: 'permission.asked', data: { id: 'per_b', sessionID: SID, action: 'edit', resources: ['a.ts'] } });
    h.emit({ type: 'permission.asked', data: { id: 'per_c', sessionID: SID, action: 'agent-threads_threads_list', resources: ['*'] } });
    await h.flush();
    expect(h.callbacks.onPermissionRequest).not.toHaveBeenCalled();
    expect(h.requests.map((r) => r.body.decision)).toEqual(['reject', 'once', 'once']);
    expect(h.requests[0].path).toBe('/api/session/ses_root/permission/per_a/reply');
  });

  it('records a denied permission as a failed tool (recorded payload)', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('run echo hello');
    h.emit({ type: 'session.execution.started', data: { sessionID: SID } });
    h.emit({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'msg_a', model: { id: 'qwen3.8:27b', providerID: 'llm-server' } } });
    h.emit({ type: 'session.tool.input.started', data: { sessionID: SID, assistantMessageID: 'msg_a', id: 'call_1', name: 'shell' } });
    h.emit({ type: 'session.tool.called', created: 1, data: { sessionID: SID, assistantMessageID: 'msg_a', id: 'call_1', input: { command: 'echo hello' }, executed: false } });
    h.emit({ type: 'session.tool.failed', created: 2, data: { sessionID: SID, assistantMessageID: 'msg_a', id: 'call_1', error: { type: 'permission.rejected', message: 'Denied by the user.' }, executed: false } });
    expect(h.callbacks.onToolResult).toHaveBeenCalledWith('call_1', 'error', 1);
  });

  it('reports a recorded interrupt as interrupted and posts to /interrupt', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('long essay');
    h.session.send('queued');
    await h.session.interrupt();
    expect(h.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/session/ses_root/interrupt' });
    h.replay(fixture('interrupt'));
    expect(h.callbacks.onInterrupted).toHaveBeenCalledWith(SID);
    expect(h.callbacks.onDone).not.toHaveBeenCalled();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    expect(h.requests.filter((r) => r.path.endsWith('/prompt'))).toHaveLength(1);
  });

  it('surfaces a recorded provider failure that has no step events', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('hi');
    h.replay(fixture('execution-failed'));
    expect(h.callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Model unavailable: llm-server/nonexistent' }));
    expect(h.session.turnInFlight).toBe(false);
  });

  it('maps a recorded question form, replies by field key, and cancels the card when dismissed', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('ask me');
    const frames = fixture('question-cancelled');
    const created = frames.find((e) => e.type === 'form.created')!;
    const formId = created.data.form.id;
    h.emit(created);
    expect(h.callbacks.onAskUserQuestion).toHaveBeenCalledWith([expect.objectContaining({
      id: '0', header: 'Color preference', question: 'Which color do you prefer: red or blue?', multiSelect: false, allowOther: true, source: 'opencode',
      options: [{ label: 'Red', description: 'You prefer red.' }, { label: 'Blue', description: 'You prefer blue.' }],
    })]);
    await h.flush();
    expect(h.requests.at(-1)).toEqual({ method: 'POST', path: `/api/session/ses_root/form/${formId}/reply`, body: { answer: { q0: 'Blue' } } });

    // A second form that the user dismisses elsewhere.
    (h.callbacks.onAskUserQuestion as any).mockReturnValueOnce(new Promise(() => {}));
    h.emit({ ...created, data: { form: { ...created.data.form, id: 'frm_2' } } });
    expect(h.session.hasPendingPermission).toBe(true);
    h.emit({ type: 'form.cancelled', data: { id: 'frm_2', sessionID: SID } });
    expect(h.callbacks.onAskUserQuestionCanceled).toHaveBeenCalled();
    expect(h.session.hasPendingPermission).toBe(false);
  });

  it('dismisses a question with DELETE when the card is rejected', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    (h.callbacks.onAskUserQuestion as any).mockRejectedValueOnce(new Error('closed'));
    h.emit(fixture('question-cancelled').find((e) => e.type === 'form.created')!);
    await h.flush();
    expect(h.requests.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(h.requests.at(-1)?.path).toMatch(/^\/api\/session\/ses_root\/form\/frm_/);
  });

  it('logs raw v2 events without streaming noise', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('hi');
    h.replay(fixture('text-turn'));
    const types = h.callbacks.onRawEvent.mock.calls.map((c) => c[0].type);
    expect(types).toContain('opencode/session.execution.succeeded');
    expect(types).not.toContain('opencode/session.text.delta');
    expect(h.callbacks.onRawEvent.mock.calls.find((c) => c[0].type === 'opencode/session.step.ended')?.[0]).toMatchObject({ sessionID: SID });
  });

  it('ignores events from unrelated sessions', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.emit({ type: 'permission.asked', data: { id: 'per_x', sessionID: 'ses_other', action: 'shell', resources: ['ls'] } });
    expect(h.callbacks.onPermissionRequest).not.toHaveBeenCalled();
  });
});
