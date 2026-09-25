import { describe, expect, it, vi } from 'vitest';
import {
  OpenCodeSession,
  openCodeAgentForMode,
  openCodeContextUsage,
  openCodeMcpServers,
  openCodePermissionConfig,
  openCodeToolName,
  openCodeToolSummary,
  parseOpenCodeModel,
  resolveOpenCodePermission,
  type OpenCodeEvent,
  type OpenCodeLauncher,
  type OpenCodeTransport,
} from '../../src/OpenCodeSession';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import type { SessionCallbacks } from '../../src/ClaudeSession';

// ── Pure mapping ───────────────────────────────────────────────────────────

describe('resolveOpenCodePermission', () => {
  it('always allows read-only tools', () => {
    for (const mode of ['default', 'plan', 'dontAsk'] as const) {
      expect(resolveOpenCodePermission(mode, 'read')).toBe('allow');
    }
  });

  it.each([
    ['default', 'edit', 'prompt'],
    ['default', 'bash', 'prompt'],
    ['acceptEdits', 'edit', 'allow'],
    ['acceptEdits', 'bash', 'prompt'],
    ['bypassPermissions', 'bash', 'allow'],
    ['auto', 'webfetch', 'allow'],
    ['dontAsk', 'bash', 'deny'],
    ['dontAsk', 'edit', 'deny'],
    ['plan', 'edit', 'deny'],
    ['plan', 'bash', 'prompt'],
  ] as const)('%s mode maps %s to %s', (mode, permission, expected) => {
    expect(resolveOpenCodePermission(mode, permission)).toBe(expected);
  });

  it('routes every non-read-only action to the adapter and pre-approves bridged host tools', () => {
    const config = openCodePermissionConfig();
    expect(config['*']).toBe('ask');
    expect(config.read).toBe('allow');
    expect(config['agent-threads_*']).toBe('allow');
    expect(config.bash).toBeUndefined();
  });
});

describe('OpenCode option mapping', () => {
  it('uses the read-only plan agent only in plan mode', () => {
    expect(openCodeAgentForMode('plan')).toBe('plan');
    expect(openCodeAgentForMode('default')).toBe('build');
    expect(openCodeAgentForMode('bypassPermissions')).toBe('build');
  });

  it('parses provider/model IDs, keeping slashes inside the model ID', () => {
    expect(parseOpenCodeModel('openai/gpt-5')).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(parseOpenCodeModel('openrouter/anthropic/claude-sonnet-4')).toEqual({ providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' });
    expect(parseOpenCodeModel('opus')).toBeUndefined();
    expect(parseOpenCodeModel('/gpt')).toBeUndefined();
    expect(parseOpenCodeModel(undefined)).toBeUndefined();
  });

  it('mirrors stdio and remote MCP servers into OpenCode config', () => {
    expect(openCodeMcpServers({
      local: { type: 'stdio', command: 'node', args: ['server.js'], env: { A: '1' }, timeout: 5000 },
      remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer x' } },
    })).toEqual({
      local: { type: 'local', command: ['node', 'server.js'], enabled: true, environment: { A: '1' }, timeout: 5000 },
      remote: { type: 'remote', url: 'https://mcp.example.test', enabled: true, headers: { Authorization: 'Bearer x' } },
    });
    expect(openCodeMcpServers(undefined)).toEqual({});
  });

  it('maps step tokens into the neutral context snapshot', () => {
    expect(openCodeContextUsage({ total: 1000, input: 100, output: 50, reasoning: 10, cache: { read: 840, write: 0 } }, 10_000, 'openai/gpt-5')).toMatchObject({
      totalTokens: 1000, maxTokens: 10_000, percentage: 10, model: 'openai/gpt-5',
      categories: [
        { name: 'Input', tokens: 100, kind: 'used' },
        { name: 'Cached input', tokens: 840, kind: 'used' },
        { name: 'Output', tokens: 50, kind: 'used' },
        { name: 'Reasoning', tokens: 10, kind: 'used' },
      ],
    });
    expect(openCodeContextUsage({ total: 1 }, undefined, 'x')).toBeNull();
  });

  it('names tools for the shared tool renderer', () => {
    expect(openCodeToolName('bash')).toBe('Bash');
    expect(openCodeToolName('agent-threads_threads_get_current')).toBe('threads_get_current');
    expect(openCodeToolName('github_create_issue')).toBe('github_create_issue');
    expect(openCodeToolSummary('bash', { command: 'ls -la' })).toBe('ls -la');
    expect(openCodeToolSummary('edit', { filePath: '/w/a.ts' })).toBe('/w/a.ts');
    expect(openCodeToolSummary('agent-threads_threads_list', {})).toBe('threads_list');
  });
});

// ── Session with a fake transport ──────────────────────────────────────────

const SID = 'ses_root';

function harness(options: { resumeStatus?: number } = {}) {
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  let emit: (event: OpenCodeEvent) => void = () => {};
  let launchConfig: Record<string, unknown> | undefined;
  const transport: OpenCodeTransport = {
    request: vi.fn(async (method, path, body) => {
      requests.push({ method, path, body });
      if (method === 'POST' && path === '/session') return { status: 200, body: { id: SID } };
      if (method === 'GET' && path.startsWith('/session/')) {
        const status = options.resumeStatus ?? 200;
        return status === 200 ? { status, body: { id: decodeURIComponent(path.split('/')[2]) } } : { status, body: { name: 'NotFoundError' } };
      }
      if (path === '/config/providers') {
        return { status: 200, body: { providers: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-5': { id: 'gpt-5', name: 'GPT-5', limit: { context: 10_000 } } } }] } };
      }
      if (path.endsWith('/prompt_async')) return { status: 204, body: undefined };
      return { status: 200, body: true };
    }),
    subscribe: (onEvent) => { emit = onEvent; },
    close: vi.fn(),
  };
  const launcher: OpenCodeLauncher = async ({ config }) => { launchConfig = config; return transport; };
  const callbacks = {
    onToken: vi.fn(), onToolUse: vi.fn(), onMessage: vi.fn(), onRecap: vi.fn(), onDone: vi.fn(),
    onInterrupted: vi.fn(), onError: vi.fn(),
    onPermissionRequest: vi.fn(async () => true),
    onAskUserQuestion: vi.fn(async () => ({ '0': 'Blue' })),
    onAskUserQuestionCanceled: vi.fn(),
    onOpenNewTab: vi.fn(), onToolResult: vi.fn(), onFilesEdited: vi.fn(), onTaskEvent: vi.fn(),
    onUsage: vi.fn(), onCapabilitiesDiscovered: vi.fn(), onCompact: vi.fn(), onEnterPlanMode: vi.fn(), onApiRetry: vi.fn(),
  } as unknown as SessionCallbacks & Record<string, ReturnType<typeof vi.fn>>;
  const session = new OpenCodeSession('/bin/opencode', launcher);
  const baseOptions: HarnessSessionOptions = {
    cwd: '/work', permissionMode: 'default', extraEnvRaw: '', callbacks,
    model: 'openai/gpt-5', appendSystemPrompt: 'env context',
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { session, callbacks, requests, emit: (e: OpenCodeEvent) => emit(e), baseOptions, flush, launchConfig: () => launchConfig };
}

const assistant = (id = 'msg_a', sessionID = SID) => ({ type: 'message.updated', properties: { sessionID, info: { id, role: 'assistant', providerID: 'openai', modelID: 'gpt-5' } } });
const busy = { type: 'session.status', properties: { sessionID: SID, status: { type: 'busy' } } };
const idle = { type: 'session.idle', properties: { sessionID: SID } };

describe('OpenCodeSession lifecycle', () => {
  it('creates a session and sends a prompt with agent, model, system prompt and images', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    await h.flush();
    expect(h.requests.find((r) => r.path === '/session')?.method).toBe('POST');
    expect(h.launchConfig()).toMatchObject({ permission: { '*': 'ask' } });
    h.session.send('hello', [{ mediaType: 'image/png', base64: 'AAAA' } as any]);
    const prompt = h.requests.find((r) => r.path === `/session/${SID}/prompt_async`)!;
    expect(prompt.body).toEqual({
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'file', mime: 'image/png', filename: 'image-1', url: 'data:image/png;base64,AAAA' },
      ],
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      system: 'env context',
    });
    expect(h.session.turnInFlight).toBe(true);
    expect(h.callbacks.onCapabilitiesDiscovered).toHaveBeenCalledWith([{ value: 'openai/gpt-5', displayName: 'OpenAI: GPT-5', description: '' }], []);
  });

  it('resumes an existing session and falls back to canonical history once when it is gone', async () => {
    const resumed = harness();
    await resumed.session.start({ ...resumed.baseOptions, resume: 'ses_old' });
    resumed.session.send('next');
    expect(resumed.requests.some((r) => r.path === '/session' && r.method === 'POST')).toBe(false);
    expect(resumed.requests.at(-1)?.path).toBe('/session/ses_old/prompt_async');

    const missing = harness({ resumeStatus: 404 });
    await missing.session.start({ ...missing.baseOptions, resume: 'ses_gone', resumeFallbackHistory: '[history]\n\n' });
    missing.session.send('first');
    expect(missing.requests.at(-1)?.body.parts[0].text).toBe('[history]\n\nfirst');
    missing.emit(busy); missing.emit(idle);
    missing.session.send('second');
    expect(missing.requests.at(-1)?.body.parts[0].text).toBe('second');
  });

  it('streams assistant text only, then completes the turn with the summed cost', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('hi');
    h.emit({ type: 'message.updated', properties: { sessionID: SID, info: { id: 'msg_u', role: 'user' } } });
    h.emit({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p_u', messageID: 'msg_u', type: 'text', text: 'hi', time: { end: 1 } } } });
    h.emit(busy);
    h.emit(assistant());
    h.emit({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p_r', messageID: 'msg_a', type: 'reasoning', text: '' } } });
    h.emit({ type: 'message.part.delta', properties: { sessionID: SID, messageID: 'msg_a', partID: 'p_r', field: 'text', delta: 'thinking' } });
    h.emit({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p_t', messageID: 'msg_a', type: 'text', text: '' } } });
    h.emit({ type: 'message.part.delta', properties: { sessionID: SID, messageID: 'msg_a', partID: 'p_t', field: 'text', delta: 'Hel' } });
    h.emit({ type: 'message.part.delta', properties: { sessionID: SID, messageID: 'msg_a', partID: 'p_t', field: 'text', delta: 'lo' } });
    h.emit({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p_t', messageID: 'msg_a', type: 'text', text: 'Hello', time: { end: 2 } } } });
    h.emit({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p_s', messageID: 'msg_a', type: 'step-finish', cost: 0.01, tokens: { total: 500, input: 400, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } } });
    h.emit(idle);
    expect(h.callbacks.onToken.mock.calls.map((c) => c[0])).toEqual(['Hel', 'lo']);
    expect(h.callbacks.onMessage).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onMessage).toHaveBeenCalledWith('Hello', []);
    expect(h.callbacks.onDone).toHaveBeenCalledWith(SID, 0.01, 1);
    expect(h.session.turnInFlight).toBe(false);
    expect(await h.session.getContextUsage()).toMatchObject({ totalTokens: 500, maxTokens: 10_000, model: 'openai/gpt-5' });
    expect(h.callbacks.onUsage).toHaveBeenCalled();
  });

  it('ignores a stale idle that arrives before the new turn goes busy', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('hi');
    h.emit(idle);
    expect(h.callbacks.onDone).not.toHaveBeenCalled();
    expect(h.session.turnInFlight).toBe(true);
  });

  it('maps the tool lifecycle, including edited files', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('edit');
    h.emit(busy); h.emit(assistant());
    const tool = (status: string, extra: Record<string, unknown> = {}) => ({
      type: 'message.part.updated',
      properties: { sessionID: SID, part: { id: 'p_tool', messageID: 'msg_a', type: 'tool', tool: 'edit', callID: 'call_1', state: { status, input: { filePath: '/work/a.ts' }, ...extra } } },
    });
    h.emit(tool('pending'));
    expect(h.callbacks.onToolUse).not.toHaveBeenCalled();
    h.emit(tool('running'));
    h.emit(tool('running'));
    h.emit(tool('completed', { time: { start: 10, end: 35 } }));
    expect(h.callbacks.onToolUse).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onToolUse).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'call_1', name: 'Edit', summary: '/work/a.ts', status: 'pending' }));
    expect(h.callbacks.onFilesEdited).toHaveBeenCalledWith(['/work/a.ts']);
    expect(h.callbacks.onToolResult).toHaveBeenCalledWith('call_1', 'success', 25);
  });

  it('reports an interrupt as interrupted and drops the late partial message', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('long');
    h.session.send('queued');
    h.emit(busy); h.emit(assistant());
    h.emit({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p_t', messageID: 'msg_a', type: 'text', text: '' } } });
    await h.session.interrupt();
    expect(h.requests.at(-1)).toMatchObject({ method: 'POST', path: `/session/${SID}/abort` });
    h.emit({ type: 'session.error', properties: { sessionID: SID, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } });
    h.emit(idle);
    h.emit({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p_t', messageID: 'msg_a', type: 'text', text: 'partial', time: { end: 3 } } } });
    expect(h.callbacks.onInterrupted).toHaveBeenCalledWith(SID);
    expect(h.callbacks.onDone).not.toHaveBeenCalled();
    expect(h.callbacks.onMessage).not.toHaveBeenCalled();
    expect(h.requests.filter((r) => r.path.endsWith('/prompt_async'))).toHaveLength(1);
  });

  it('surfaces a provider error, including one raised before the turn went busy', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('bad model');
    h.emit({ type: 'session.error', properties: { sessionID: SID, error: { name: 'ProviderModelNotFoundError', data: { message: 'Model not found: openai/nope' } } } });
    expect(h.callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Model not found: openai/nope' }));
    expect(h.session.turnInFlight).toBe(false);
  });

  it('runs a queued follow-up after the turn completes', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.session.send('one');
    h.session.send('two');
    expect(h.requests.filter((r) => r.path.endsWith('/prompt_async'))).toHaveLength(1);
    h.emit(busy); h.emit(idle);
    const prompts = h.requests.filter((r) => r.path.endsWith('/prompt_async'));
    expect(prompts).toHaveLength(2);
    expect(prompts[1].body.parts[0].text).toBe('two');
  });

  it('ignores unrelated sessions but follows child sessions spawned by the task tool', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.emit({ type: 'permission.asked', properties: { id: 'per_other', sessionID: 'ses_other', permission: 'bash', patterns: ['rm -rf /'], metadata: {} } });
    expect(h.callbacks.onPermissionRequest).not.toHaveBeenCalled();
    h.emit({ type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: SID } } });
    h.emit({ type: 'permission.asked', properties: { id: 'per_child', sessionID: 'ses_child', permission: 'bash', patterns: ['ls'], metadata: { command: 'ls' } } });
    expect(h.callbacks.onPermissionRequest).toHaveBeenCalledWith('OpenCode: Bash', 'ls');
  });

  it('maps todos into the task tracker', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.emit({ type: 'todo.updated', properties: { sessionID: SID, todos: [
      { content: 'a', status: 'pending' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'cancelled' },
    ] } });
    expect(h.callbacks.onTaskEvent).toHaveBeenCalledWith({ kind: 'replace', tasks: [
      { content: 'a', status: 'pending' }, { content: 'b', status: 'in_progress' },
    ] });
  });

  it('uses the plan agent and validates provider/model IDs', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    await h.session.setPermissionMode('plan');
    h.session.send('plan it');
    expect(h.requests.at(-1)?.body.agent).toBe('plan');
    expect(h.callbacks.onEnterPlanMode).toHaveBeenCalled();
    await expect(h.session.setModel('opus')).rejects.toThrow(/provider\/model/);
    await h.session.setModel(undefined);
    h.emit(busy); h.emit(idle);
    h.session.send('default model');
    expect(h.requests.at(-1)?.body.model).toBeUndefined();
  });
});

describe('OpenCodeSession permissions and questions', () => {
  const ask = (permission: string, metadata: Record<string, unknown> = {}) => ({
    type: 'permission.asked',
    properties: { id: `per_${permission}`, sessionID: SID, permission, patterns: ['p'], metadata },
  });
  const replies = (h: ReturnType<typeof harness>) => h.requests.filter((r) => r.path.startsWith('/permission/'));

  it('prompts in default mode and forwards the decision', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    (h.callbacks.onPermissionRequest as any).mockResolvedValueOnce(false);
    h.emit(ask('bash', { command: 'rm -rf build' }));
    expect(h.session.hasPendingPermission).toBe(true);
    expect(h.callbacks.onPermissionRequest).toHaveBeenCalledWith('OpenCode: Bash', 'rm -rf build');
    await h.flush();
    expect(replies(h)).toEqual([{ method: 'POST', path: '/permission/per_bash/reply', body: { reply: 'reject', message: 'Denied by the user.' } }]);
    expect(h.session.hasPendingPermission).toBe(false);
  });

  it('applies the live permission mode without prompting', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    await h.session.setPermissionMode('bypassPermissions');
    h.emit(ask('bash'));
    await h.session.setPermissionMode('dontAsk');
    h.emit(ask('edit'));
    await h.flush();
    expect(h.callbacks.onPermissionRequest).not.toHaveBeenCalled();
    expect(replies(h).map((r) => r.body.reply)).toEqual(['once', 'reject']);
  });

  it('maps OpenCode questions to the shared question card and replies by label', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    h.emit({ type: 'question.asked', properties: { id: 'que_1', sessionID: SID, questions: [
      { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] },
    ] } });
    expect(h.callbacks.onAskUserQuestion).toHaveBeenCalledWith([expect.objectContaining({
      id: '0', question: 'Which color?', header: 'Color', multiSelect: false, allowOther: true, source: 'opencode',
    })]);
    await h.flush();
    expect(h.requests.at(-1)).toEqual({ method: 'POST', path: '/question/que_1/reply', body: { answers: [['Blue']] } });
  });

  it('cancels the question card when OpenCode resolves it elsewhere', async () => {
    const h = harness();
    await h.session.start(h.baseOptions);
    (h.callbacks.onAskUserQuestion as any).mockReturnValueOnce(new Promise(() => {}));
    h.emit({ type: 'question.asked', properties: { id: 'que_2', sessionID: SID, questions: [{ question: 'Q?', header: '', options: [] }] } });
    h.emit({ type: 'question.rejected', properties: { sessionID: SID, requestID: 'que_2' } });
    expect(h.callbacks.onAskUserQuestionCanceled).toHaveBeenCalled();
  });
});
