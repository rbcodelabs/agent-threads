import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodexSession, applyCodexResumeFallback, codexContextUsage, codexDeveloperInstructions, codexDynamicToolDefinitions, codexMcpServers, codexResumeInstructions } from '../../src/CodexSession';

describe('Codex built-in tools', () => {
  it('registers one reserved EnterPlanMode definition ahead of canonical tools', () => {
    const tools = codexDynamicToolDefinitions([
      { name: 'EnterPlanMode', description: 'collision', inputSchema: {}, requiresApproval: true, invoke: vi.fn() },
      { name: 'vault_search', description: 'Search notes', inputSchema: { type: 'object' }, requiresApproval: false, invoke: vi.fn() },
    ]);

    expect(tools.map((tool) => tool.name)).toEqual(['EnterPlanMode', 'vault_search']);
    expect(tools[0]).toMatchObject({
      description: expect.stringContaining('read-only planning turn'),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
  });
});

describe('codexMcpServers', () => {
  it('translates stdio and remote MCP transports to Codex config keys', () => {
    expect(codexMcpServers({
      local: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'secret' }, timeout: 5_000 },
      remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer secret' } },
    })).toEqual({
      local: { command: 'node', args: ['server.js'], env: { TOKEN: 'secret' }, tool_timeout_sec: 5 },
      remote: { url: 'https://mcp.example.test', http_headers: { Authorization: 'Bearer secret' } },
    });
  });

  it('skips in-process SDK servers that cannot cross the app-server boundary', () => {
    expect(codexMcpServers({
      obsidian: { type: 'sdk', name: 'obsidian', instance: {} as any },
    })).toEqual({});
  });
});

describe('Codex agent profile instructions', () => {
  it('replaces goal developer instructions on both thread start and thread resume', () => {
    const refreshed = {
      appendSystemPrompt: 'Vault root (filesystem path): /vault\nWorking directory: /work\n\n## Active Goal\nShip the latest release',
      codex: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
    } as any;

    expect(codexDeveloperInstructions(refreshed)).toContain('Ship the latest release');
    expect(codexDeveloperInstructions(refreshed)).toContain('Vault root (filesystem path): /vault');
    expect(codexDeveloperInstructions(refreshed)).not.toContain('Old goal');
    expect(codexResumeInstructions(refreshed)).toEqual({
      developerInstructions: 'Vault root (filesystem path): /vault\nWorking directory: /work\n\n## Active Goal\nShip the latest release',
    });
  });

  it('preserves existing developer context and adds the configured role prompts', () => {
    const instructions = codexDeveloperInstructions({
      appendSystemPrompt: 'Existing project context.',
      codex: {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        agentProfiles: {
          qa: { description: 'Adversarial verification.', prompt: 'Find edge cases.' },
        },
      },
    } as any);

    expect(instructions).toContain('Existing project context.');
    expect(instructions).toContain('Profile: qa');
    expect(instructions).toContain('Find edge cases.');
  });

  it('uses the same composed instructions when resuming a thread', () => {
    const options = {
      appendSystemPrompt: 'Existing project context.',
      codex: {
        approvalPolicy: 'on-request', sandbox: 'workspace-write',
        agentProfiles: { qa: { description: 'Verify.', prompt: 'Find edge cases.' } },
      },
    } as any;

    expect(codexResumeInstructions(options)).toEqual({
      developerInstructions: expect.stringContaining('Find edge cases.'),
    });
  });
});

describe('codexContextUsage', () => {
  it('maps app-server token usage into the shared context snapshot', () => {
    const result = codexContextUsage({
      total: {
        totalTokens: 24_000,
        inputTokens: 20_000,
        cachedInputTokens: 5_000,
        cacheWriteInputTokens: 0,
        outputTokens: 4_000,
        reasoningOutputTokens: 1_500,
      },
      last: {
        totalTokens: 4_000,
        inputTokens: 3_000,
        cachedInputTokens: 500,
        cacheWriteInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 250,
      },
      modelContextWindow: 120_000,
    }, 'gpt-5.6-codex');

    expect(result).toMatchObject({
      totalTokens: 24_000,
      maxTokens: 120_000,
      percentage: 20,
      model: 'gpt-5.6-codex',
      categories: [
        { name: 'Input', tokens: 15_000 },
        { name: 'Cached input', tokens: 5_000 },
        { name: 'Output', tokens: 2_500 },
        { name: 'Reasoning', tokens: 1_500 },
      ],
    });
  });

  it('returns null until Codex reports a context-window size', () => {
    expect(codexContextUsage({
      total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: null,
    }, '')).toBeNull();
  });
});

describe('Codex resume fallback', () => {
  it('replays canonical history exactly once when thread/resume is replaced by thread/start', () => {
    const fallback = '[canonical prior history]\n\n';

    expect(applyCodexResumeFallback('Continue', fallback, true)).toBe(`${fallback}Continue`);
    expect(applyCodexResumeFallback('Continue', fallback, false)).toBe('Continue');
  });

  it('consumes fallback history on the replacement session first turn only', () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'replacement-thread';
    internal.options = { resumeFallbackHistory: '[canonical prior history]\n\n', callbacks: {} };
    internal.resumeFallbackPending = true;
    const startTurn = vi.spyOn(internal, 'startTurn').mockImplementation(() => undefined);

    session.send('First continuation');
    session.send('Second continuation');

    expect(startTurn).toHaveBeenNthCalledWith(1, '[canonical prior history]\n\nFirst continuation', undefined, 'First continuation');
    expect(startTurn).toHaveBeenNthCalledWith(2, 'Second continuation', undefined, 'Second continuation');
  });
});

describe('CodexSession protocol notifications', () => {
  it('round-trips requestUserInput through the shared question callback using stable IDs', async () => {
    const onAskUserQuestion = vi.fn().mockResolvedValue({ target: 'Core', token: 's3cret' });
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'root-thread';
    internal.activeTurnId = 'root-turn';
    internal._turnInFlight = true;
    internal.options = { callbacks: { onAskUserQuestion } };
    const respond = vi.spyOn(internal, 'respond');

    internal.handle({
      id: 'question-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'root-thread', turnId: 'root-turn', itemId: 'call-1', isBlocking: true,
        questions: [
          {
            id: 'target', header: 'Target', question: 'Which target?', isOther: true, isSecret: false,
            options: [{ label: 'Core', description: 'Inspect core.' }],
          },
          { id: 'token', header: 'Token', question: 'Enter token', isOther: true, isSecret: true },
        ],
      },
    });

    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(onAskUserQuestion).toHaveBeenCalledWith([
      {
        id: 'target', header: 'Target', question: 'Which target?', options: [{ label: 'Core', description: 'Inspect core.' }],
        multiSelect: false, allowOther: true, isSecret: false, source: 'codex',
        requestItemId: 'call-1', isBlocking: true, autoResolutionMs: undefined,
      },
      {
        id: 'token', header: 'Token', question: 'Enter token', options: [], multiSelect: false,
        allowOther: true, isSecret: true, source: 'codex',
        requestItemId: 'call-1', isBlocking: true, autoResolutionMs: undefined,
      },
    ]);
    expect(respond).toHaveBeenCalledWith('question-1', {
      answers: {
        target: { answers: ['Core'] },
        token: { answers: ['user_note: s3cret'] },
      },
    });
  });

  it('cancels the shared card when app-server resolves a non-blocking request first', async () => {
    const onAskUserQuestion = vi.fn(() => new Promise<Record<string, string>>(() => {}));
    const onAskUserQuestionCanceled = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'root-thread';
    internal.activeTurnId = 'root-turn';
    internal._turnInFlight = true;
    internal.options = { callbacks: { onAskUserQuestion, onAskUserQuestionCanceled } };
    const respond = vi.spyOn(internal, 'respond');

    internal.handle({
      id: 42,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'root-thread', turnId: 'root-turn', itemId: 'call-auto', isBlocking: false,
        autoResolutionMs: 5000,
        questions: [{ id: 'continue', header: 'Continue', question: 'Continue?', isOther: false, isSecret: false,
          options: [{ label: 'Yes', description: '' }] }],
      },
    });
    internal.handle({ method: 'serverRequest/resolved', params: { threadId: 'root-thread', requestId: 42 } });

    expect(onAskUserQuestionCanceled).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    ['child thread', { threadId: 'child-thread', turnId: 'root-turn', questions: [] }],
    ['stale turn', { threadId: 'root-thread', turnId: 'old-turn', questions: [] }],
    ['malformed question', { threadId: 'root-thread', turnId: 'root-turn', questions: [{ id: '', question: '' }] }],
  ])('resolves a %s request deterministically without opening the shared question UI', async (_label, params) => {
    const onAskUserQuestion = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'root-thread';
    internal.activeTurnId = 'root-turn';
    internal._turnInFlight = true;
    internal.options = { callbacks: { onAskUserQuestion } };
    const respond = vi.spyOn(internal, 'respond');

    internal.handle({ id: 'invalid-question', method: 'item/tool/requestUserInput', params });

    expect(onAskUserQuestion).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('invalid-question', { answers: {} });
  });

  it('enables Default-mode requestUserInput only when the app-server advertises the feature', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    const request = vi.spyOn(internal, 'request')
      .mockResolvedValueOnce({ data: [{ name: 'default_mode_request_user_input', enabled: false }] })
      .mockResolvedValueOnce({ enablement: { default_mode_request_user_input: true } });

    await internal.enableDefaultModeRequestUserInput();

    expect(request).toHaveBeenNthCalledWith(1, 'experimentalFeature/list', { limit: 100 });
    expect(request).toHaveBeenNthCalledWith(2, 'experimentalFeature/enablement/set', {
      enablement: { default_mode_request_user_input: true },
    });
  });

  it('falls back safely when an older app-server cannot list Default-mode input support', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    const request = vi.spyOn(internal, 'request').mockRejectedValue(new Error('Method not found'));

    await expect(internal.enableDefaultModeRequestUserInput()).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('propagates Ultra effort without deprecated multiAgentMode fields', () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.activeModel = 'gpt-5.6-codex';
    internal.options = { codex: { effort: 'ultra' } };

    expect(internal.collaborationMode('default')).toEqual({
      mode: 'default',
      settings: { model: 'gpt-5.6-codex', reasoning_effort: 'ultra', developer_instructions: null },
    });
    expect(internal.collaborationMode('default')).not.toHaveProperty('multiAgentMode');
  });

  it('accepts a configured Codex effort only when the selected model advertises it', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = { model: 'gpt-5.6-codex', codex: { effort: 'ultra' }, callbacks: {} };
    vi.spyOn(internal, 'request').mockResolvedValue({
      data: [{
        id: 'gpt-5.6-codex', displayName: 'GPT-5.6 Codex',
        supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }],
      }],
    });

    await expect(internal.validateConfiguredEffort()).resolves.toBeUndefined();
  });

  it('fails clearly before a turn when the selected model does not support Ultra', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = { model: 'gpt-5.4-mini', codex: { effort: 'ultra' }, callbacks: {} };
    vi.spyOn(internal, 'request').mockResolvedValue({
      data: [{
        id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }],
      }],
    });

    await expect(internal.validateConfiguredEffort()).rejects.toThrow(
      'GPT-5.4 Mini does not support Codex effort "ultra"',
    );
  });

  it('rejects a live model switch that would make the configured effort unsupported', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal.options = { model: 'gpt-5.6-codex', codex: { effort: 'ultra' }, callbacks: {} };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({
      data: [{
        id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }],
      }],
    });

    await expect(session.setModel('gpt-5.4-mini')).rejects.toThrow('does not support Codex effort "ultra"');
    expect(request).not.toHaveBeenCalledWith('thread/settings/update', expect.anything());
  });

  it('passes configured effort on ordinary turns and live settings updates', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.activeModel = 'gpt-5.6-codex';
    internal.options = { permissionMode: 'default', codex: { effort: 'ultra' }, callbacks: { onError: vi.fn() } };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({ turn: { id: 'turn-1' } });

    internal.startTurn('Work proactively');
    await session.setPermissionMode('default');

    expect(request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ effort: 'ultra' }));
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({ effort: 'ultra' }));
    expect(request.mock.calls.flatMap(([, params]) => Object.keys(params))).not.toContain('multiAgentMode');
  });

  it('handles EnterPlanMode as an idempotent built-in control tool without permission', () => {
    const onPermissionRequest = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal._turnInFlight = true;
    internal.options = { permissionMode: 'default', callbacks: { onPermissionRequest } };
    const respond = vi.spyOn(internal, 'respond');

    internal.handle({ id: 'enter-1', method: 'item/tool/call', params: { tool: 'EnterPlanMode', arguments: {} } });
    internal.handle({ id: 'enter-2', method: 'item/tool/call', params: { tool: 'EnterPlanMode', arguments: {} } });

    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(internal.planTransitionRequested).toBe(true);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenNthCalledWith(1, 'enter-1', expect.objectContaining({ success: true }));
    expect(respond).toHaveBeenNthCalledWith(2, 'enter-2', expect.objectContaining({ success: true }));
  });

  it('settles an EnterPlanMode request into exactly one read-only Plan continuation before queued turns', async () => {
    const onDone = vi.fn();
    const onPlanModeRequested = vi.fn().mockResolvedValue(undefined);
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.activeModel = 'gpt-5.6-codex';
    internal._turnInFlight = true;
    internal.options = {
      permissionMode: 'default',
      callbacks: { onDone, onPlanModeRequested, onError: vi.fn(), onEnterPlanMode: vi.fn() },
    };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({ turn: { id: 'plan-turn' } });
    internal.queuedTurns.push({ text: 'Queued user follow-up' });
    internal.handle({ id: 'enter-1', method: 'item/tool/call', params: { tool: 'EnterPlanMode', arguments: {} } });

    internal.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('turn/start', expect.anything()));

    expect(onDone).not.toHaveBeenCalled();
    expect(onPlanModeRequested).toHaveBeenCalledOnce();
    expect(internal.options.permissionMode).toBe('plan');
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({
      threadId: 'codex-thread',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'gpt-5.6-codex', reasoning_effort: null, developer_instructions: null },
      },
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    }));
    expect(request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      collaborationMode: expect.objectContaining({ mode: 'plan' }),
    }));
    expect(internal.queuedTurns).toEqual([{ text: 'Queued user follow-up' }]);
  });

  it('resolves Default before resyncing collaboration mode on an existing session', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'plan', callbacks: {} };
    const request = vi.spyOn(internal, 'request').mockImplementation((method: string) => {
      if (method === 'thread/settings/update') return Promise.resolve({ model: 'gpt-5.6-codex' });
      return Promise.resolve({});
    });

    await session.setModel(undefined);

    await session.setPermissionMode('default');

    expect(internal.options.permissionMode).toBe('default');
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({
      threadId: 'codex-thread',
      collaborationMode: {
        mode: 'default',
        settings: { model: 'gpt-5.6-codex', reasoning_effort: null, developer_instructions: null },
      },
    }));
  });

  it('replaces an explicit model with the catalog Default when settings omit the effective model', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal.activeModel = 'gpt-5.4-mini';
    internal.options = { model: 'gpt-5.4-mini', permissionMode: 'default', callbacks: {} };
    const request = vi.spyOn(internal, 'request').mockImplementation((method: string) => {
      if (method === 'model/list') {
        return Promise.resolve({ data: [
          { id: 'gpt-5.4-mini', isDefault: false },
          { id: 'gpt-5.6-codex', isDefault: true },
        ] });
      }
      return Promise.resolve({});
    });

    await session.setModel(undefined);
    await session.setPermissionMode('default');

    expect(internal.activeModel).toBe('gpt-5.6-codex');
    expect(internal.options.model).toBeUndefined();
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({
      collaborationMode: expect.objectContaining({
        settings: expect.objectContaining({ model: 'gpt-5.6-codex' }),
      }),
    }));
  });

  it('keeps the resolved Default through Plan entry and exit', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'default', callbacks: {} };
    const request = vi.spyOn(internal, 'request').mockImplementation((method: string) => {
      if (method === 'thread/settings/update' && request.mock.calls.length === 1) {
        return Promise.resolve({ model: 'gpt-5.6-codex' });
      }
      return Promise.resolve({});
    });

    await session.setModel(undefined);
    await session.setPermissionMode('plan');
    await session.setPermissionMode('default');

    const collaborationUpdates = request.mock.calls
      .filter(([method, params]) => method === 'thread/settings/update' && params.collaborationMode)
      .map(([, params]) => params.collaborationMode);
    expect(collaborationUpdates).toEqual([
      { mode: 'plan', settings: { model: 'gpt-5.6-codex', reasoning_effort: null, developer_instructions: null } },
      { mode: 'default', settings: { model: 'gpt-5.6-codex', reasoning_effort: null, developer_instructions: null } },
    ]);
  });

  it('preserves an explicit model across collaboration mode changes', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'default', callbacks: {} };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({});

    await session.setModel('gpt-5.4-mini');
    await session.setPermissionMode('plan');
    await session.setPermissionMode('default');

    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({
      collaborationMode: expect.objectContaining({
        settings: expect.objectContaining({ model: 'gpt-5.4-mini' }),
      }),
    }));
  });

  it('preserves cached permission mode when the live settings update fails', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'default', callbacks: {} };
    vi.spyOn(internal, 'request').mockRejectedValue(new Error('settings rejected'));

    await expect(session.setPermissionMode('plan')).rejects.toThrow('settings rejected');
    expect(internal.options.permissionMode).toBe('default');
  });

  it('does not persist autonomous Plan mode when the live settings update fails', async () => {
    const onPlanModeRequested = vi.fn();
    const onError = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal._turnInFlight = true;
    internal.options = { permissionMode: 'default', callbacks: { onPlanModeRequested, onError } };
    internal.queuedTurns.push({ text: 'stale queued work' });
    vi.spyOn(internal, 'request').mockRejectedValue(new Error('plan settings failed'));

    await internal.startRequestedPlanContinuation(internal.options.callbacks);

    expect(onPlanModeRequested).not.toHaveBeenCalled();
    expect(internal.options.permissionMode).toBe('default');
    expect(internal.queuedTurns).toEqual([]);
    expect(internal._turnInFlight).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'plan settings failed' }));
  });

  it('cleans all terminal state when turn/start rejects', async () => {
    const onError = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'default', callbacks: { onError } };
    internal.queuedTurns.push({ text: 'stale' });
    vi.spyOn(internal, 'request').mockRejectedValue(new Error('turn rejected'));

    internal.startTurn('Start');
    await internal.turnStartPromise;

    expect(internal.queuedTurns).toEqual([]);
    expect(internal.activeTurnId).toBeUndefined();
    expect(internal.activeTurnMode).toBeUndefined();
    expect(internal._turnInFlight).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'turn rejected' }));
  });

  it('retains approval state and card callback when Default settings fail', async () => {
    const onPlanReady = vi.fn();
    const onPlanTransitionError = vi.fn();
    const onError = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal._turnInFlight = true;
    internal.activeTurnMode = 'plan';
    internal.options = { permissionMode: 'plan', callbacks: { onPlanReady, onPlanTransitionError, onError } };
    vi.spyOn(internal, 'request').mockRejectedValue(new Error('default settings failed'));
    internal.queuedTurns.push({ text: 'stale queued work' });

    internal.handle({ method: 'item/completed', params: { item: { type: 'plan', text: 'Retryable plan' } } });
    internal.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    onPlanReady.mock.calls[0][1]();
    await vi.waitFor(() => expect(onPlanTransitionError).toHaveBeenCalled());

    expect(onError).not.toHaveBeenCalled();
    expect(internal.awaitingPlanApproval).toBe(true);
    expect(internal.options.permissionMode).toBe('plan');
    expect(internal.queuedTurns).toEqual([]);
    expect(internal._turnInFlight).toBe(false);
  });

  it('ignores a stale root completion after an internal continuation starts', () => {
    const onDone = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal.activeTurnId = 'new-turn';
    internal.activeTurnMode = 'plan';
    internal._turnInFlight = true;
    internal.options = { permissionMode: 'plan', callbacks: { onDone, onError: vi.fn() } };

    internal.handle({ method: 'turn/completed', params: { turn: { id: 'old-turn', status: 'completed' } } });

    expect(onDone).not.toHaveBeenCalled();
    expect(internal.activeTurnId).toBe('new-turn');
    expect(internal._turnInFlight).toBe(true);
  });

  it('interprets a Default turn as Default after the toolbar switches subsequent turns to Plan', async () => {
    const onDone = vi.fn();
    const onError = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'default', callbacks: { onDone, onError } };
    vi.spyOn(internal, 'request').mockResolvedValue({ turn: { id: 'turn-default' } });

    internal.startTurn('Work');
    await session.setPermissionMode('plan');
    internal.handle({ method: 'turn/completed', params: { turn: { id: 'turn-default', status: 'completed' } } });

    expect(onDone).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('interprets a Plan turn as Plan after the toolbar switches subsequent turns to Default', async () => {
    const onPlanReady = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'plan', callbacks: { onPlanReady, onError: vi.fn(), onEnterPlanMode: vi.fn() } };
    vi.spyOn(internal, 'request').mockResolvedValue({ turn: { id: 'turn-plan' } });

    internal.startTurn('Plan');
    await session.setPermissionMode('default');
    internal.handle({ method: 'item/completed', params: { item: { type: 'plan', text: 'Immutable turn plan' } } });
    internal.handle({ method: 'turn/completed', params: { turn: { id: 'turn-plan', status: 'completed' } } });

    expect(onPlanReady).toHaveBeenCalledWith('Immutable turn plan', expect.any(Function), expect.any(Function));
  });

  it('honors EnterPlanMode when a toolbar Plan update races the initiating Default turn', async () => {
    const onPlanModeRequested = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'default', callbacks: { onPlanModeRequested, onError: vi.fn(), onEnterPlanMode: vi.fn() } };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({ turn: { id: 'turn-1' } });

    internal.startTurn('Investigate');
    internal.activeTurnId = 'turn-1';
    internal.handle({ id: 'enter', method: 'item/tool/call', params: { tool: 'EnterPlanMode', threadId: 'codex-thread', turnId: 'turn-1', arguments: {} } });
    await session.setPermissionMode('plan');
    internal.handle({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2));
    expect(onPlanModeRequested).toHaveBeenCalledOnce();
  });

  it('rejects EnterPlanMode calls for a child or stale turn', () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'root-thread';
    internal.activeTurnId = 'root-turn';
    internal._turnInFlight = true;
    internal.options = { permissionMode: 'default', callbacks: {} };
    const respond = vi.spyOn(internal, 'respond');

    internal.handle({ id: 'child', method: 'item/tool/call', params: { tool: 'EnterPlanMode', threadId: 'child-thread', turnId: 'child-turn', arguments: {} } });
    internal.handle({ id: 'stale', method: 'item/tool/call', params: { tool: 'EnterPlanMode', threadId: 'root-thread', turnId: 'old-turn', arguments: {} } });

    expect(internal.planTransitionRequested).toBe(false);
    expect(respond).toHaveBeenNthCalledWith(1, 'child', expect.objectContaining({ success: false }));
    expect(respond).toHaveBeenNthCalledWith(2, 'stale', expect.objectContaining({ success: false }));
  });

  it.each(['interrupted', 'failed'])('does not drain queued turns after a %s terminal status', (status) => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal._turnInFlight = true;
    internal.queuedTurns.push({ text: 'must not run' });
    internal.options = { permissionMode: 'default', callbacks: { onInterrupted: vi.fn(), onError: vi.fn() } };
    const startTurn = vi.spyOn(internal, 'startTurn');

    internal.handle({ method: 'turn/completed', params: { turn: { status, error: { message: 'failed' } } } });

    expect(startTurn).not.toHaveBeenCalled();
    expect(internal.queuedTurns).toEqual([]);
  });

  it('does not drain queued turns when Plan completes without a structured plan', () => {
    const onError = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal._turnInFlight = true;
    internal.queuedTurns.push({ text: 'must not run' });
    internal.options = { permissionMode: 'plan', callbacks: { onError } };
    const startTurn = vi.spyOn(internal, 'startTurn');

    internal.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('without a structured plan') }));
    expect(startTurn).not.toHaveBeenCalled();
    expect(internal.queuedTurns).toEqual([]);
  });

  it('does not wedge when interrupted during the turn-boundary Plan transition', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal._turnInFlight = true;
    internal.planTransitionRequested = true;
    internal.activeTurnId = undefined;
    internal.turnStartPromise = null;

    await session.interrupt();

    expect(internal.planTransitionRequested).toBe(false);
    expect(internal.awaitingPlanApproval).toBe(false);
    expect(internal._turnInFlight).toBe(false);
  });

  it('holds queued and fresh turns while a native plan awaits approval, then starts one edited implementation', async () => {
    const onPlanReady = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'plan', callbacks: { onPlanReady, onError: vi.fn() } };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({ turn: { id: 'implementation-turn' } });
    internal._turnInFlight = true;
    internal.queuedTurns.push({ text: 'Already queued' });
    internal.handle({ method: 'item/completed', params: { item: { type: 'plan', id: 'plan-1', text: 'Original plan' } } });
    internal.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } });

    session.send('Fresh while awaiting approval');
    expect(internal.awaitingPlanApproval).toBe(true);
    expect(session.canIdleReap()).toBe(false);
    expect(internal.queuedTurns).toEqual([{ text: 'Already queued' }, { text: 'Fresh while awaiting approval', images: undefined }]);
    expect(request).not.toHaveBeenCalledWith('turn/start', expect.anything());

    onPlanReady.mock.calls[0][1]('Edited plan');
    session.send('Racing send after approval');
    expect(internal.queuedTurns).toEqual([
      { text: 'Already queued' },
      { text: 'Fresh while awaiting approval', images: undefined },
      { text: 'Racing send after approval', images: undefined },
    ]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('turn/start', expect.anything()));

    expect(internal.awaitingPlanApproval).toBe(false);
    expect(internal.options.permissionMode).toBe('default');
    expect(request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      input: [expect.objectContaining({ text: 'The plan was approved with these edits. Implement it now:\n\nEdited plan' }), expect.objectContaining({ text: expect.stringMatching(/^\[Current local time: /) })],
    }));
    expect(internal.queuedTurns).toHaveLength(3);
  });

  it('rejects into queued Plan feedback in FIFO order and reports that generic feedback is unnecessary', () => {
    const onPlanReady = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal._turnInFlight = true;
    internal.activeTurnMode = 'plan';
    internal.options = { permissionMode: 'plan', callbacks: { onPlanReady, onError: vi.fn() } };
    internal.queuedTurns.push({ text: 'Feedback queued before card' });
    const startTurn = vi.spyOn(internal, 'startTurn');

    internal.handle({ method: 'item/completed', params: { item: { type: 'plan', text: 'Plan' } } });
    internal.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    session.send('Feedback queued during card');
    const hadFeedback = onPlanReady.mock.calls[0][2]();

    expect(hadFeedback).toBe(true);
    expect(startTurn).toHaveBeenCalledWith('Feedback queued before card', undefined);
    expect(internal.queuedTurns).toEqual([{ text: 'Feedback queued during card', images: undefined }]);
    expect(internal.options.permissionMode).toBe('plan');
  });

  describe('plan updates', () => {
    const createPlanSession = () => {
      const onTaskEvent = vi.fn();
      const session = new CodexSession('codex');
      const internal = session as any;
      internal.codexThreadId = 'codex-thread';
      internal.options = { callbacks: { onTaskEvent } };
      return { internal, onTaskEvent };
    };

    it('maps a root-thread plan snapshot to the shared task statuses', () => {
      const { internal, onTaskEvent } = createPlanSession();

      internal.handle({
        method: 'turn/plan/updated',
        params: {
          threadId: 'codex-thread',
          turnId: 'turn-1',
          explanation: 'Working through the checklist',
          plan: [
            { step: 'Queued work', status: 'pending' },
            { step: 'Current work', status: 'inProgress' },
            { step: 'Finished work', status: 'completed' },
          ],
        },
      });

      expect(onTaskEvent).toHaveBeenCalledWith({
        kind: 'replace',
        tasks: [
          { content: 'Queued work', status: 'pending' },
          { content: 'Current work', status: 'in_progress' },
          { content: 'Finished work', status: 'completed' },
        ],
      });
    });

    it('treats later notifications as replacement snapshots and supports clearing', () => {
      const { internal, onTaskEvent } = createPlanSession();

      internal.handle({
        method: 'turn/plan/updated',
        params: {
          threadId: 'codex-thread',
          plan: [
            { step: 'First', status: 'completed' },
            { step: 'Second', status: 'inProgress' },
          ],
        },
      });
      internal.handle({
        method: 'turn/plan/updated',
        params: {
          threadId: 'codex-thread',
          plan: [{ step: 'Replacement', status: 'pending' }],
        },
      });
      internal.handle({
        method: 'turn/plan/updated',
        params: { threadId: 'codex-thread', plan: [] },
      });

      expect(onTaskEvent).toHaveBeenNthCalledWith(2, {
        kind: 'replace',
        tasks: [{ content: 'Replacement', status: 'pending' }],
      });
      expect(onTaskEvent).toHaveBeenNthCalledWith(3, { kind: 'replace', tasks: [] });
    });

    it('ignores child-thread plan notifications', () => {
      const { internal, onTaskEvent } = createPlanSession();

      internal.handle({
        method: 'turn/plan/updated',
        params: {
          threadId: 'child-thread',
          plan: [{ step: 'Child work', status: 'inProgress' }],
        },
      });

      expect(onTaskEvent).not.toHaveBeenCalled();
    });

    it('omits malformed entries and unknown statuses from root snapshots', () => {
      const { internal, onTaskEvent } = createPlanSession();

      internal.handle({
        method: 'turn/plan/updated',
        params: {
          threadId: 'codex-thread',
          plan: [
            { step: 'Valid', status: 'pending' },
            { step: '', status: 'completed' },
            { step: 42, status: 'pending' },
            { step: 'Unknown', status: 'blocked' },
            null,
          ],
        },
      });
      internal.handle({
        method: 'turn/plan/updated',
        params: { threadId: 'codex-thread', plan: 'not-an-array' },
      });
      internal.handle({
        method: 'turn/plan/updated',
        params: {
          threadId: 'codex-thread',
          plan: [
            { step: 'Unknown', status: 'blocked' },
            { step: 42, status: 'pending' },
          ],
        },
      });

      expect(onTaskEvent).toHaveBeenCalledOnce();
      expect(onTaskEvent).toHaveBeenCalledWith({
        kind: 'replace',
        tasks: [{ content: 'Valid', status: 'pending' }],
      });
    });
  });

  it('reports every path from a multi-file fileChange through the shared edited-files callback', () => {
    const managerEditedFiles: string[] = [];
    const onFilesEdited = (paths: string[]) => {
      for (const filePath of paths) {
        if (!managerEditedFiles.includes(filePath)) managerEditedFiles.push(filePath);
      }
    };
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = {
      callbacks: {
        onRawEvent: vi.fn(),
        onToolUse: vi.fn(),
        onFilesEdited,
      },
    };

    internal.handle({
      method: 'item/started',
      params: {
        item: {
          type: 'fileChange',
          id: 'change-1',
          status: 'inProgress',
          changes: [
            { path: '/project/src/a.ts', kind: 'update', diff: '@@' },
            { path: '/project/src/b.ts', kind: 'create', diff: '@@' },
            { path: '', kind: 'update', diff: '@@' },
          ],
        },
      },
    });

    expect(managerEditedFiles).toEqual(['/project/src/a.ts', '/project/src/b.ts']);
  });

  it('waits for the active turn id before sending Stop to Codex', async () => {
    let acceptTurn!: (result: { turn: { id: string } }) => void;
    const turnAccepted = new Promise<{ turn: { id: string } }>((resolve) => { acceptTurn = resolve; });
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.options = { callbacks: { onError: vi.fn() } };
    const request = vi.spyOn(internal, 'request').mockImplementation((method: string) => (
      method === 'turn/start' ? turnAccepted : Promise.resolve({})
    ));

    session.send('Keep working');
    const stopped = session.interrupt();

    expect(request).toHaveBeenCalledOnce();
    acceptTurn({ turn: { id: 'turn-1' } });
    await stopped;

    expect(request).toHaveBeenLastCalledWith('turn/interrupt', {
      threadId: 'codex-thread',
      turnId: 'turn-1',
    });
  });

  it('caches usage, raw-logs the notification, and reports a completed turn', async () => {
    const onDone = vi.fn();
    const onRawEvent = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal.activeModel = 'gpt-5.6-codex';
    internal.options = {
      callbacks: { onDone, onRawEvent },
    };

    internal.handle({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'codex-thread',
        turnId: 'turn-1',
        tokenUsage: {
          total: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 },
          last: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 },
          modelContextWindow: 100,
        },
      },
    });
    internal.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } });

    await expect(session.getContextUsage()).resolves.toMatchObject({ totalTokens: 10, maxTokens: 100 });
    expect(onRawEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'thread/tokenUsage/updated' }));
    expect(onDone).toHaveBeenCalledWith('codex-thread', 0, 1);
  });

  it('does not raw-log streaming text deltas', () => {
    const onRawEvent = vi.fn();
    const onToken = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onRawEvent, onToken } };

    (session as any).handle({ method: 'item/agentMessage/delta', params: { delta: 'hello' } });

    expect(onToken).toHaveBeenCalledWith('hello');
    expect(onRawEvent).not.toHaveBeenCalled();
  });

  it('accepts string IDs on app-server requests', () => {
    const session = new CodexSession('codex');
    const respond = vi.spyOn(session as any, 'respond');
    (session as any).options = { callbacks: {} };

    (session as any).handle({ id: 'server-request-1', method: 'unknown/request', params: {} });

    expect(respond).toHaveBeenCalledWith('server-request-1', {});
  });

  it('recognizes context-compaction items from the current protocol', () => {
    const onCompact = vi.fn();
    const onToolResult = vi.fn();
    const session = new CodexSession('codex');
    (session as any).latestContextUsage = { totalTokens: 42_000 };
    (session as any).options = { callbacks: { onCompact, onToolResult } };

    (session as any).handle({
      method: 'item/completed',
      params: { item: { type: 'contextCompaction', id: 'compact-1' } },
    });

    expect(onCompact).toHaveBeenCalledWith('auto', 42_000);
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it('routes MCP form elicitations through the shared inline UI callback', async () => {
    const onElicitation = vi.fn().mockResolvedValue({ action: 'accept', content: { project: 'parity' } });
    const session = new CodexSession('codex');
    const respond = vi.spyOn(session as any, 'respond');
    (session as any).options = { callbacks: { onElicitation } };

    (session as any).handle({
      id: 'elicit-1',
      method: 'mcpServer/elicitation/request',
      params: {
        mode: 'form',
        serverName: 'linear',
        message: 'Choose a project',
        requestedSchema: { type: 'object', properties: { project: { type: 'string' } } },
      },
    });
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());

    expect(onElicitation).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'linear',
      mode: 'form',
      message: 'Choose a project',
    }), expect.any(AbortSignal));
    expect(respond).toHaveBeenCalledWith('elicit-1', {
      action: 'accept',
      content: { project: 'parity' },
      _meta: null,
    });
  });

  it('routes empty-schema MCP elicitations through the shared permission callback', async () => {
    const onPermissionRequest = vi.fn().mockResolvedValue(true);
    const onElicitation = vi.fn();
    const session = new CodexSession('codex');
    const respond = vi.spyOn(session as any, 'respond');
    (session as any).options = { callbacks: { onPermissionRequest, onElicitation } };

    (session as any).handle({
      id: 'elicit-permission-1',
      method: 'mcpServer/elicitation/request',
      params: {
        mode: 'form',
        serverName: 'github',
        message: 'Allow the GitHub MCP server to run search_repositories?',
        requestedSchema: { type: 'object', properties: {} },
      },
    });
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());

    expect(onPermissionRequest).toHaveBeenCalledWith(
      'MCP: github',
      'Allow the GitHub MCP server to run search_repositories?',
    );
    expect(onElicitation).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('elicit-permission-1', {
      action: 'accept',
      content: {},
      _meta: null,
    });
  });

  it('surfaces a completed Codex plan and starts implementation after approval', async () => {
    const onDone = vi.fn();
    const onPlanReady = vi.fn();
    const onEnterPlanMode = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.activeModel = 'gpt-5.6-codex';
    internal.options = {
      permissionMode: 'plan',
      callbacks: { onDone, onPlanReady, onEnterPlanMode, onError: vi.fn() },
    };
    vi.spyOn(internal, 'request').mockResolvedValue({});
    internal.startTurn('Make a plan');
    expect(onEnterPlanMode).toHaveBeenCalledOnce();
    expect(internal.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.6-codex', reasoning_effort: null, developer_instructions: null } },
    }));
    internal.handle({ method: 'item/completed', params: { item: { type: 'plan', id: 'plan-1', text: '1. Ship it' } } });
    internal.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } });

    expect(onDone).not.toHaveBeenCalled();
    expect(onPlanReady).toHaveBeenCalledWith('1. Ship it', expect.any(Function), expect.any(Function));
    const approve = onPlanReady.mock.calls[0][1];
    approve('1. Ship it\n2. Verify it');
    await vi.waitFor(() => expect(internal.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      input: [expect.objectContaining({ text: 'The plan was approved with these edits. Implement it now:\n\n1. Ship it\n2. Verify it' }), expect.objectContaining({ text: expect.stringMatching(/^\[Current local time: /) })],
    })));
    expect(internal.options.permissionMode).toBe('default');
  });

  it('maps Codex collaboration items to shared sub-agent task events', () => {
    const onTaskStarted = vi.fn();
    const onTaskUpdated = vi.fn();
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onTaskStarted, onTaskUpdated, onToolUse, onToolResult } };
    const started = {
      type: 'collabAgentToolCall', id: 'call-1', tool: 'spawnAgent', status: 'inProgress',
      receiverThreadIds: ['agent-1'], prompt: 'Audit event coverage', model: 'gpt-5.6-codex', agentsStates: {},
    };
    (session as any).handle({ method: 'item/started', params: { item: started } });
    (session as any).handle({
      method: 'item/completed',
      params: { item: { ...started, status: 'completed', agentsStates: { 'agent-1': { status: 'completed', message: 'Done' } } } },
    });

    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({ name: 'Agent', summary: 'Audit event coverage' }));
    expect(onTaskStarted).toHaveBeenCalledWith('agent-1', 'Audit event coverage', false, 'subagent', undefined, undefined, undefined, 'gpt-5.6-codex');
    expect(onTaskUpdated).toHaveBeenCalledWith('agent-1', { status: 'completed', error: undefined });
    expect(onToolResult).toHaveBeenCalledWith('call-1', 'success', undefined);
  });

  it.each([
    ['completed', undefined, { status: 'completed' }],
    ['failed', { message: 'Child failed' }, { status: 'failed', error: 'Child failed' }],
    ['interrupted', undefined, { status: 'killed', error: undefined }],
  ])('settles a Codex sub-agent when its child-scoped turn is %s', (status, error, expectedUpdate) => {
    const onTaskUpdated = vi.fn();
    const onDone = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'parent-thread';
    internal._turnInFlight = true;
    internal.options = { callbacks: { onTaskStarted: vi.fn(), onTaskUpdated, onDone, onTaskProgress: vi.fn() } };
    internal.handle({ method: 'item/completed', params: { item: {
      type: 'subAgentActivity', id: 'activity-1', kind: 'started', agentThreadId: 'agent-1',
    } } });

    internal.handle({ method: 'turn/completed', params: {
      threadId: 'agent-1', turn: { id: 'child-turn', status, error },
    } });

    expect(onTaskUpdated).toHaveBeenCalledWith('agent-1', expectedUpdate);
    expect(onDone).not.toHaveBeenCalled();
    expect(internal._turnInFlight).toBe(true);
  });

  it('ignores a stale child-turn completion after a newer follow-up starts', () => {
    const onTaskUpdated = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'parent-thread';
    internal.options = { callbacks: { onTaskStarted: vi.fn(), onTaskUpdated, onTaskProgress: vi.fn() } };
    internal.handle({ method: 'item/completed', params: { item: {
      type: 'subAgentActivity', id: 'activity-1', kind: 'started', agentThreadId: 'agent-1',
    } } });
    internal.handle({ method: 'turn/started', params: {
      threadId: 'agent-1', turn: { id: 'child-turn-2', status: 'inProgress' },
    } });
    expect(onTaskUpdated).toHaveBeenLastCalledWith('agent-1', { status: 'in_progress' });
    onTaskUpdated.mockClear();

    internal.handle({ method: 'turn/completed', params: {
      threadId: 'agent-1', turn: { id: 'child-turn-1', status: 'completed' },
    } });

    expect(onTaskUpdated).not.toHaveBeenCalled();
  });

  it('clears child-turn tracking when the session closes', () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'parent-thread';
    internal.options = { callbacks: { onTaskStarted: vi.fn(), onTaskUpdated: vi.fn(), onTaskProgress: vi.fn() } };
    internal.handle({ method: 'item/completed', params: { item: {
      type: 'subAgentActivity', id: 'activity-1', kind: 'started', agentThreadId: 'agent-1',
    } } });
    internal.handle({ method: 'turn/started', params: {
      threadId: 'agent-1', turn: { id: 'child-turn', status: 'inProgress' },
    } });
    expect(internal.activeSubagentTurns.size).toBe(1);

    session.close();

    expect(internal.activeSubagentTurns.size).toBe(0);
  });

  it('does not announce the root coordinator as a sub-agent (agentPath /root)', () => {
    const onTaskStarted = vi.fn();
    const onTaskProgress = vi.fn();
    const onTaskUpdated = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onTaskStarted, onTaskProgress, onTaskUpdated } };

    // The prior session's root thread reappearing on resume: must be ignored so
    // it doesn't create a never-settling 'working' run that wedges the thread.
    (session as any).handle({
      method: 'item/started',
      params: { item: { type: 'subAgentActivity', agentThreadId: 'root-thread', agentPath: '/root', kind: 'interacted' } },
    });
    expect(onTaskStarted).not.toHaveBeenCalled();
    expect(onTaskProgress).not.toHaveBeenCalled();

    // A genuine child (nested path) must still be announced.
    (session as any).handle({
      method: 'item/started',
      params: { item: { type: 'subAgentActivity', agentThreadId: 'child-thread', agentPath: '/root/engineer', kind: 'started' } },
    });
    expect(onTaskStarted).toHaveBeenCalledWith('child-thread', 'Codex sub-agent child-thread', false, 'subagent', undefined, undefined, undefined, undefined);
  });

  it('does not emit phantom tool results for reasoning items', () => {
    const onToolResult = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onToolResult } };
    (session as any).handle({ method: 'item/completed', params: { item: { type: 'reasoning', id: 'reason-1' } } });
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it('maps reroutes, warnings, and rate limits to shared status events', () => {
    const onModelFallback = vi.fn();
    const onNotification = vi.fn();
    const onRateLimit = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onModelFallback, onNotification, onRateLimit } };

    (session as any).handle({ method: 'model/rerouted', params: { reason: 'highRiskCyberActivity', fromModel: 'a', toModel: 'b' } });
    (session as any).handle({ method: 'warning', params: { message: 'Context is nearly full' } });
    (session as any).handle({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 85, resetsAt: 2_000 } } } });

    expect(onModelFallback).toHaveBeenCalledWith('highRiskCyberActivity', 'a', 'b');
    expect(onNotification).toHaveBeenCalledWith('Context is nearly full', 'medium');
    expect(onRateLimit).toHaveBeenCalledWith('allowed_warning', 2_000_000);
  });

  it('keeps multiple quota buckets alongside thread tokens', async () => {
    const onUsage = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onUsage } };
    (session as any).handle({ method: 'thread/tokenUsage/updated', params: { tokenUsage: {
      total: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 100, outputTokens: 100, reasoningOutputTokens: 20 },
      last: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 2 },
      modelContextWindow: 1000,
    } } });
    (session as any).handle({ method: 'account/rateLimits/updated', params: { rateLimits: {
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2000 },
      secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 3000 },
    } } });

    await expect(session.getUsageSnapshot()).resolves.toMatchObject({
      tokens: { total: 500 }, lastTurnTokens: { total: 50 },
      quotaWindows: [{ usedPercent: 20 }, { usedPercent: 60 }],
    });
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  it('reads initial rate limits and account activity on demand', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = { callbacks: { onUsage: vi.fn() } };
    const request = vi.spyOn(internal, 'request')
      .mockResolvedValueOnce({
        rateLimits: { primary: { usedPercent: 10, resetsAt: 2000 } },
        rateLimitsByLimitId: { codex: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000 }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 3000 } } },
        rateLimitResetCredits: { balance: 2 },
      })
      .mockResolvedValueOnce({ summary: { lifetimeTokens: 123, peakDailyTokens: 50, currentStreakDays: 2 }, dailyUsageBuckets: [{ startDate: '2026-08-17', tokens: 123 }] });

    await internal.loadInitialRateLimits();
    const usage = await session.getUsageSnapshot(true);

    expect(request).toHaveBeenNthCalledWith(1, 'account/rateLimits/read', {});
    expect(request).toHaveBeenNthCalledWith(2, 'account/usage/read', {});
    expect(usage).toMatchObject({
      quotaWindows: [{ label: 'Codex · 5 hours' }, { label: 'Codex · 7 days' }],
      resetCredits: { balance: 2 }, accountUsage: { lifetimeTokens: 123, daily: [{ tokens: 123 }] },
    });
  });

  it('returns quota data with an explicit account-usage error when unauthenticated', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.latestUsage = { provider: 'codex', updatedAt: 1, quotaWindows: [{ label: 'Primary', usedPercent: 10 }] };
    vi.spyOn(internal, 'request').mockRejectedValue(new Error('not authenticated'));

    await expect(session.getUsageSnapshot(true)).resolves.toMatchObject({
      quotaWindows: [{ usedPercent: 10 }], accountUsageUnavailable: 'not authenticated',
    });
  });

  it('discovers enabled Codex skills as shared slash commands', async () => {
    const onCommandsChanged = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = { cwd: '/project', callbacks: { onCommandsChanged } };
    vi.spyOn(internal, 'request').mockResolvedValue({
      data: [{ skills: [
        { name: 'review', description: 'Review changes', enabled: true },
        { name: 'disabled', description: 'Hidden', enabled: false },
      ] }],
    });

    internal.discoverSkills();
    await vi.waitFor(() => expect(onCommandsChanged).toHaveBeenCalled());
    expect(internal.request).toHaveBeenCalledWith('skills/list', { cwds: ['/project'], forceReload: true });
    expect(onCommandsChanged).toHaveBeenCalledWith([
      { name: 'review', description: 'Review changes', argumentHint: '' },
    ]);
  });

  it('registers configured skill roots with the app-server', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = { codex: { skillRoots: ['/skills/source', '/skills/bundled'] } };
    vi.spyOn(internal, 'request').mockResolvedValue({});

    await internal.registerSkillRoots();

    expect(internal.request).toHaveBeenCalledWith('skills/extraRoots/set', {
      extraRoots: ['/skills/source', '/skills/bundled'],
    });
  });

  it('namespaces authored skills while keeping installed commands distinct', async () => {
    const session = new CodexSession('codex') as any;
    const onCommandsChanged = vi.fn();
    session.options = { cwd: '/project', codex: { localSkillsRoot: '/vault/Skills' }, callbacks: { onCommandsChanged } };
    vi.spyOn(session, 'request').mockResolvedValue({ data: [{ skills: [
      { name: 'review', path: '/installed/review/SKILL.md', description: 'Installed' },
      { name: 'review', path: '/vault/Skills/review/SKILL.md', description: 'Authored' },
      { name: 'other', path: '/vault/Skills-other/other/SKILL.md', description: 'Outside' },
    ] }] });
    session.discoverSkills();
    await vi.waitFor(() => expect(onCommandsChanged).toHaveBeenCalled());
    expect(onCommandsChanged.mock.calls[0][0].map((command: any) => command.name)).toEqual(['review', 'local:review', 'other']);
  });

  it('invokes authored skills by explicit path and keeps user arguments', async () => {
    const session = new CodexSession('codex') as any;
    session.options = { cwd: '/project', codex: { localSkillsRoot: '/vault/Skills' }, callbacks: { onCommandsChanged: vi.fn(), onError: vi.fn() } };
    const request = vi.spyOn(session, 'request').mockResolvedValue({ data: [{ skills: [{ name: 'review', path: '/vault/Skills/review/SKILL.md' }] }] });
    session.discoverSkills();
    await vi.waitFor(() => expect(session.options.callbacks.onCommandsChanged).toHaveBeenCalled());
    request.mockResolvedValue({ turn: { id: 'turn' } });
    session.closed = false;
    session.codexThreadId = 'thread';
    session.send('/local:review check this patch');
    expect(request).toHaveBeenLastCalledWith('turn/start', expect.objectContaining({ input: [
      { type: 'text', text: '$review check this patch', text_elements: [] },
      { type: 'skill', name: 'review', path: '/vault/Skills/review/SKILL.md' },
    ] }));
  });
  it('recognizes canonical paths beneath an aliased vault path', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-test-'));
    try {
      fs.mkdirSync(path.join(temp, 'real/review'), { recursive: true });
      fs.writeFileSync(path.join(temp, 'real/review/SKILL.md'), 'test');
      fs.symlinkSync(path.join(temp, 'real'), path.join(temp, 'alias'));
      const session = new CodexSession('codex') as any;
      const onCommandsChanged = vi.fn();
      session.options = { cwd: '/project', codex: { localSkillsRoot: path.join(temp, 'alias') }, callbacks: { onCommandsChanged } };
      vi.spyOn(session, 'request').mockResolvedValue({ data: [{ skills: [{ name: 'review', path: fs.realpathSync(path.join(temp, 'real/review/SKILL.md')) }] }] });
      await session.discoverSkills();
      expect(onCommandsChanged.mock.calls[0][0][0].name).toBe('local:review');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });

  it('does not expose newly created authored skills during an active session', async () => {
    const session = new CodexSession('codex') as any;
    const onCommandsChanged = vi.fn();
    session.options = { cwd: '/project', codex: { localSkillsRoot: '/vault/Skills' }, callbacks: { onCommandsChanged } };
    const request = vi.spyOn(session, 'request').mockResolvedValue({ data: [{ skills: [{ name: 'review', path: '/vault/Skills/review/SKILL.md' }] }] });
    session.discoverSkills();
    await vi.waitFor(() => expect(onCommandsChanged).toHaveBeenCalledTimes(1));
    request.mockResolvedValue({ data: [{ skills: [{ name: 'new', path: '/vault/Skills/new/SKILL.md' }] }] });
    session.discoverSkills();
    await vi.waitFor(() => expect(onCommandsChanged).toHaveBeenCalledTimes(2));
    expect(onCommandsChanged.mock.calls[1][0].map((command: any) => command.name)).toEqual(['local:review']);
  });
  it('preserves local selection when fallback history is prepended', async () => {
    const session = new CodexSession('codex') as any;
    session.options = { cwd: '/project', resumeFallbackHistory: 'Prior history\n\n', codex: { localSkillsRoot: '/vault/Skills' }, callbacks: { onCommandsChanged: vi.fn(), onError: vi.fn() } };
    const request = vi.spyOn(session, 'request').mockResolvedValue({ data: [{ skills: [{ name: 'review', path: '/vault/Skills/review/SKILL.md' }] }] });
    await session.discoverSkills();
    request.mockResolvedValue({ turn: { id: 'turn' } });
    session.closed = false;
    session.codexThreadId = 'thread';
    session.resumeFallbackPending = true;
    session.send('/local:review check this patch');
    expect(request).toHaveBeenLastCalledWith('turn/start', expect.objectContaining({ input: [
      { type: 'text', text: 'Prior history\n\n$review check this patch', text_elements: [] },
      { type: 'skill', name: 'review', path: '/vault/Skills/review/SKILL.md' },
    ] }));
  });

  it('fails an unknown local invocation instead of allowing ambiguous name resolution', () => {
    const session = new CodexSession('codex') as any;
    const onError = vi.fn();
    session.options = { callbacks: { onError } };
    session.closed = false;
    session.codexThreadId = 'thread';
    const request = vi.spyOn(session, 'request').mockResolvedValue({});
    session.send('/local:missing');
    expect(request).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/new session/i) }));
    expect(session.turnInFlight).toBe(false);
  });
});
