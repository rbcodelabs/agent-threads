import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AntigravitySession,
  antigravityCliArgs,
  antigravityContextUsage,
  antigravityDiffDetail,
  antigravityEditedPaths,
  antigravityMcpServers,
  antigravityModeForPermission,
  antigravityModels,
  antigravityPermissionDetail,
  antigravityShouldSkipPermissions,
  antigravityToolName,
  antigravityToolSummary,
  antigravityTurnTokens,
  resolveAntigravityPermission,
  type AntigravityBrainOptions,
} from '../../src/AntigravitySession';
import {
  cleanBrainArgString,
  cleanBrainArgStringArray,
  parseAntigravityBackgroundTask,
  parseAntigravityCreatedSubagent,
  parseAntigravityWakeupMessage,
  parseCompleteJsonlSteps,
} from '../../src/antigravityBrain';
import { spawnAcpChannel, type AcpLauncher } from '../../src/AcpClient';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import type { SessionCallbacks } from '../../src/ClaudeSession';

const AGENT = path.resolve(__dirname, '../helpers/fake-acp-agent.mjs');
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/antigravity', name), 'utf8'));

// ── Pure mapping ───────────────────────────────────────────────────────────

describe('resolveAntigravityPermission', () => {
  it('always allows read-only kinds', () => {
    for (const mode of ['default', 'plan', 'dontAsk'] as const) {
      for (const kind of ['read', 'search', 'fetch', 'think']) expect(resolveAntigravityPermission(mode, kind)).toBe('allow');
    }
  });

  it.each([
    ['default', 'edit', 'prompt'],
    ['default', 'execute', 'prompt'],
    ['default', undefined, 'prompt'],
    ['acceptEdits', 'edit', 'allow'],
    ['acceptEdits', 'delete', 'allow'],
    ['acceptEdits', 'execute', 'prompt'],
    ['bypassPermissions', 'execute', 'allow'],
    ['auto', 'edit', 'allow'],
    ['auto', 'other', 'allow'],
    ['dontAsk', 'execute', 'deny'],
    ['dontAsk', 'edit', 'deny'],
    ['plan', 'edit', 'deny'],
    ['plan', 'move', 'deny'],
    ['plan', 'execute', 'prompt'],
  ] as const)('%s mode maps %s to %s', (mode, kind, expected) => {
    expect(resolveAntigravityPermission(mode, kind)).toBe(expected);
  });
});

describe('antigravityModeForPermission', () => {
  it.each([
    ['default', 'default'], ['plan', 'plan'], ['acceptEdits', 'accept-edits'], ['auto', 'auto'], ['bypassPermissions', 'auto'], ['dontAsk', 'default'],
  ] as const)('maps %s to agy mode %s', (mode, expected) => {
    expect(antigravityModeForPermission(mode)).toBe(expected);
  });

  it('keeps agy asking when a denylist forbids edits or the shell, so it cannot auto-approve past the refusal', () => {
    expect(antigravityModeForPermission('acceptEdits', ['Write'])).toBe('default');
    expect(antigravityModeForPermission('auto', ['Bash'])).toBe('default');
    expect(antigravityModeForPermission('plan', ['Bash'])).toBe('plan');
  });
});

describe('antigravityShouldSkipPermissions and antigravityCliArgs', () => {
  it('passes --dangerously-skip-permissions only in bypassPermissions when no edit/shell denylist applies', () => {
    expect(antigravityShouldSkipPermissions('bypassPermissions')).toBe(true);
    expect(antigravityCliArgs('bypassPermissions')).toEqual(['acp', '--dangerously-skip-permissions']);

    for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk'] as const) {
      expect(antigravityShouldSkipPermissions(mode)).toBe(false);
      expect(antigravityCliArgs(mode)).toEqual(['acp']);
    }

    for (const denied of [['Write'], ['Edit'], ['Bash'], ['Write', 'Bash']] as const) {
      expect(antigravityShouldSkipPermissions('bypassPermissions', denied)).toBe(false);
      expect(antigravityCliArgs('bypassPermissions', denied)).toEqual(['acp']);
    }
    expect(antigravityShouldSkipPermissions('bypassPermissions', ['WebFetch'])).toBe(true);
  });
});

describe('tool mapping against recorded frames', () => {
  const stream = fixture('prompt-edit-shell-stream.json') as any[];
  const tools = stream.filter((m) => m.method === 'session/update' && m.params.update.sessionUpdate === 'tool_call').map((m) => m.params.update);
  const write = tools.find((t) => t.name === 'write_file');
  const edit = tools.find((t) => t.name === 'edit_file');
  const shell = tools.find((t) => t.name === 'run_command');

  it('names tools after the existing card vocabulary', () => {
    expect(antigravityToolName(write.name, write.kind)).toBe('Write');
    expect(antigravityToolName(edit.name, edit.kind)).toBe('Edit');
    expect(antigravityToolName(shell.name, shell.kind)).toBe('Bash');
    expect(antigravityToolName('something_new', 'other')).toBe('something_new');
    expect(antigravityToolName(undefined, 'edit')).toBe('Edit');
    // Recorded from the real agy: an MCP tool arrives as mcp_<server>_<tool> with kind "other".
    expect(antigravityToolName('mcp_agent-threads_host_echo', 'other')).toBe('host_echo');
    // Built-in Antigravity orchestration and file tools (including brain-transcript calls where kind is omitted).
    expect(antigravityToolName('invoke_subagent', 'other')).toBe('Agent');
    expect(antigravityToolName('run_workflow', 'other')).toBe('Workflow');
    expect(antigravityToolName('search_web', 'other')).toBe('WebSearch');
    expect(antigravityToolName('ask_question', 'other')).toBe('AskUserQuestion');
    expect(antigravityToolName('schedule', 'other')).toBe('ScheduleWakeup');
    expect(antigravityToolName('read_file', undefined)).toBe('Read');
    expect(antigravityToolName('grep_search', undefined)).toBe('Grep');
    expect(antigravityToolName('find_by_name', undefined)).toBe('Glob');
  });

  it('summarises a shell call by its command, an edit by its file, and subagent/workflow calls cleanly', () => {
    expect(antigravityToolSummary(shell)).toBe(shell.rawInput.CommandLine);
    expect(antigravityToolSummary(write)).toBe('/work/project/hello.txt');
    expect(antigravityToolSummary({ title: 'Browse', kind: 'other' })).toBe('Browse');
    expect(antigravityToolSummary({ name: 'mcp_agent-threads_host_echo', kind: 'other', title: 'Run mcp_agent-threads_host_echo', rawInput: { text: 'x', toolSummary: 'Echo text via MCP tool' } })).toBe('Echo text via MCP tool');
    expect(antigravityToolSummary({ name: 'invoke_subagent', kind: 'other', rawInput: { TypeName: 'research', Role: 'Auth Researcher', Prompt: 'Inspect auth' } })).toBe('Auth Researcher');
    expect(antigravityToolSummary({ name: 'define_subagent', kind: 'other', rawInput: { Name: 'auditor' } })).toBe('Define subagent: auditor');
    expect(antigravityToolSummary({ name: 'manage_subagents', kind: 'other', rawInput: { Action: 'kill' } })).toBe('Subagents: kill');
    expect(antigravityToolSummary({ name: 'send_message', kind: 'other', rawInput: { Recipient: 'child-1', Message: 'done' } })).toBe('Message to child-1');
    expect(antigravityToolSummary({ name: 'swarm', kind: 'other', rawInput: { action: 'add', name: 'reviewer' } })).toBe('Swarm: add (reviewer)');
    expect(antigravityToolSummary({ name: 'run_workflow', kind: 'other', rawInput: { Description: 'Audit modules' } })).toBe('Audit modules');
    expect(antigravityToolSummary({ name: 'schedule', kind: 'other', rawInput: { Prompt: 'Check build' } })).toBe('Check build');
    expect(antigravityToolSummary({ name: 'manage_task', kind: 'other', rawInput: { Action: 'status', TaskId: 's/task-1' } })).toBe('Task: status (s/task-1)');
    expect(antigravityToolSummary({ name: 'search_web', kind: 'other', rawInput: { query: 'acp spec' } })).toBe('acp spec');
    expect(antigravityToolSummary({ name: 'ask_question', kind: 'other', rawInput: { questions: [{ question: 'Which option?' }] } })).toBe('Which option?');
    expect(antigravityToolSummary({ name: 'edit_file', args: { Path: '/repo/src/a.ts' } })).toBe('/repo/src/a.ts');
  });

  it('renders a new file and a replacement as diffs for the approval card', () => {
    const permission = stream.find((m) => m.method === 'session/request_permission' && m.params.toolCall.name === 'write_file').params.toolCall;
    expect(antigravityDiffDetail(permission.content)).toBe('/work/project/hello.txt (new file)\n+ hi');
    const replace = stream.find((m) => m.method === 'session/request_permission' && m.params.toolCall.name === 'edit_file').params.toolCall;
    expect(antigravityDiffDetail(replace.content)).toBe('/work/project/hello.txt\n- hi\n+ hi');
    expect(antigravityPermissionDetail(permission)).toContain('+ hi');
    expect(antigravityPermissionDetail(shell)).toBe(shell.rawInput.CommandLine);
  });

  it('truncates a huge diff', () => {
    const huge = antigravityDiffDetail([{ type: 'diff', path: 'a', newText: 'x\n'.repeat(5000) }]);
    expect(huge.length).toBeLessThan(4100);
    expect(huge.endsWith('…')).toBe(true);
  });

  it('collects edited paths from diffs, falling back to locations and Path args', () => {
    expect(antigravityEditedPaths({ content: [{ type: 'diff', path: '/a', newText: '' }], locations: [{ path: '/b' }] })).toEqual(['/a']);
    expect(antigravityEditedPaths({ locations: [{ path: '/b' }] })).toEqual(['/b']);
    expect(antigravityEditedPaths({ name: 'edit_file', args: { Path: '/c.ts' } })).toEqual(['/c.ts']);
    expect(antigravityEditedPaths({ name: 'write_file', rawInput: { Path: '/d.ts' } })).toEqual(['/d.ts']);
    expect(antigravityEditedPaths({})).toEqual([]);
  });
});

describe('brain transcript parsers', () => {
  it('extracts created subagent IDs, background task IDs, and wakeup senders', () => {
    expect(parseAntigravityCreatedSubagent('Created the following subagent:\n{\n  "conversationId": "sub-123",\n  "logAbsoluteUri": "file:///x"\n}'))
      .toEqual({ conversationId: 'sub-123' });
    expect(parseAntigravityCreatedSubagent('unrelated tool result')).toBeNull();

    expect(parseAntigravityBackgroundTask('Tool is running as a background task with task id: sess-1/task-9\n'))
      .toEqual({ taskId: 'sess-1/task-9' });
    expect(parseAntigravityBackgroundTask('sync result')).toBeNull();

    const wakeup = parseAntigravityWakeupMessage(
      '<SYSTEM_MESSAGE>\nYou have received the following message(s) while idle:\n[Message] timestamp=2026-11-14T06:34:47Z sender=sub-123\nAuth check passed.\n</SYSTEM_MESSAGE>',
    );
    expect(wakeup).toEqual({ senders: ['sub-123'], summary: 'Auth check passed.' });

    const idleWakeup = parseAntigravityWakeupMessage('Subagent 2e620406-cab2 has gone idle. This was the subagent\'s most recent response: Done.');
    expect(idleWakeup.senders).toEqual(['2e620406-cab2']);
  });

  it('ignores trailing unterminated JSONL fragments and deduplicates by step_index', () => {
    const partial = `${JSON.stringify({ step_index: 0, type: 'USER_INPUT' })}\n${JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE' })}\n{"step_index":2,"type":`;
    const first = parseCompleteJsonlSteps(partial, -1);
    expect(first.steps.map((s) => s.step_index)).toEqual([0, 1]);
    expect(first.maxStepIndex).toBe(1);
    expect(partial.slice(first.consumedChars)).toBe('{"step_index":2,"type":');

    const second = parseCompleteJsonlSteps(`${partial}"GENERIC"}\n`, first.maxStepIndex);
    expect(second.steps.map((s) => s.step_index)).toEqual([2]);
  });
});

describe('protocol shape helpers', () => {
  it('converts MCP servers to the ACP name/value list shape', () => {
    expect(antigravityMcpServers({
      remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer x' } },
      events: { type: 'sse', url: 'https://sse.example.test' },
      local: { type: 'stdio', command: 'node', args: ['s.js'], env: { A: '1' } },
    })).toEqual([
      { type: 'http', name: 'remote', url: 'https://mcp.example.test', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
      { type: 'sse', name: 'events', url: 'https://sse.example.test', headers: [] },
      { name: 'local', command: 'node', args: ['s.js'], env: [{ name: 'A', value: '1' }] },
    ]);
    expect(antigravityMcpServers(undefined)).toEqual([]);
  });

  it('reads the live model catalog and quota tier from the recorded session/new result', () => {
    const models = antigravityModels(fixture('session-new-response.json').result);
    expect(models.length).toBeGreaterThan(3);
    expect(models[0]).toMatchObject({ value: expect.any(String), displayName: expect.any(String), description: 'Antigravity Starter Quota' });
    expect(antigravityModels({})).toEqual([]);
  });

  it('maps usage_update and the end-of-turn usage object', () => {
    expect(antigravityContextUsage(262144, 1048576, 'm')).toMatchObject({ totalTokens: 262144, maxTokens: 1048576, percentage: 25, model: 'm' });
    expect(antigravityContextUsage(1, 0, 'm')).toBeNull();
    expect(antigravityTurnTokens({ inputTokens: 21939, outputTokens: 2881, cachedReadTokens: 43286, cachedWriteTokens: 0, thoughtTokens: 2660, totalTokens: 68106 }))
      .toEqual({ total: 68106, input: 21939, output: 2881, cachedInput: 43286, cacheWriteInput: 0, reasoning: 2660 });
    expect(antigravityTurnTokens(undefined)).toBeUndefined();
  });
});

// ── Session against the fake ACP agent (real stdio, recorded frames) ───────

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fakeLauncher(spawnedArgs?: string[][]): AcpLauncher {
  return (options) => {
    spawnedArgs?.push([...options.args]);
    return spawnAcpChannel({ ...options, binaryPath: process.execPath, args: [AGENT] });
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(over: Partial<HarnessSessionOptions> & {
  env?: Record<string, string>;
  permission?: (tool: string, detail: string) => Promise<boolean>;
  startTimeoutMs?: number;
  binary?: string;
  launcher?: AcpLauncher;
  brainOptions?: AntigravityBrainOptions;
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fake-'));
  const logFile = path.join(tempRoot, 'log.jsonl');
  const brainDir = over.brainOptions?.brainDir ?? path.join(tempRoot, 'brain');
  cleanup.push(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const spawnedArgs: string[][] = [];
  const events: string[] = [];
  const tokens: string[] = [];
  const messages: string[] = [];
  const messageTools: string[][] = [];
  const toolUses: any[] = [];
  const toolResults: Array<[string, string]> = [];
  const filesEdited: string[][] = [];
  const permissionRequests: Array<{ tool: string; detail: string }> = [];
  const tasksStarted: Array<{ taskId: string; description: string; isWorkflow?: boolean; taskType?: string; subagentType?: string; parentNativeAgentId?: string; model?: string }> = [];
  const tasksProgress: Array<{ taskId: string; description?: string; lastToolName?: string }> = [];
  const tasksUpdated: Array<{ taskId: string; patch: any }> = [];
  const tasksNotified: Array<{ taskId: string; status: string; summary: string }> = [];
  const done = vi.fn();
  const errors: Error[] = [];
  const callbacks = {
    onToken: (t: string) => tokens.push(t),
    onToolUse: (r: any) => { toolUses.push(r); },
    onMessage: (content: string, tools: Array<{ name: string }>) => { messages.push(content); messageTools.push(tools.map((t) => t.name)); },
    onRecap: () => undefined,
    onDone: (...args: unknown[]) => { events.push('done'); done(...args); },
    onInterrupted: () => { events.push('interrupted'); },
    onError: (e: Error) => { events.push('error'); errors.push(e); },
    onPermissionRequest: async (tool: string, detail: string) => { permissionRequests.push({ tool, detail }); return over.permission ? over.permission(tool, detail) : true; },
    onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: 'x', title: 'x' }),
    onToolResult: (id: string, status: string) => { toolResults.push([id, status]); },
    onFilesEdited: (paths: string[]) => { filesEdited.push(paths); },
    onTaskStarted: (taskId: string, description: string, isWorkflow?: boolean, taskType?: string, _workflowName?: string, subagentType?: string, parentNativeAgentId?: string, model?: string) => {
      tasksStarted.push({ taskId, description, isWorkflow, taskType, subagentType, parentNativeAgentId, model });
    },
    onTaskProgress: (taskId: string, description?: string, lastToolName?: string) => {
      tasksProgress.push({ taskId, description, lastToolName });
    },
    onTaskUpdated: (taskId: string, patch: any) => {
      tasksUpdated.push({ taskId, patch });
    },
    onTaskNotification: (taskId: string, status: string, summary: string) => {
      tasksNotified.push({ taskId, status, summary });
    },
    onEnterPlanMode: vi.fn(),
    onCapabilitiesDiscovered: vi.fn(),
    onUsage: vi.fn(),
    onCommandsChanged: vi.fn(),
    onRawEvent: vi.fn(),
    onNotification: vi.fn(),
  } as unknown as SessionCallbacks;
  const env = { FAKE_ACP_LOG: logFile, FAKE_ACP_BRAIN_DIR: brainDir, ...(over.env ?? {}) };
  const options: HarnessSessionOptions = {
    cwd: process.cwd(),
    permissionMode: 'default',
    extraEnvRaw: Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'),
    callbacks,
    ...over,
  };
  delete (options as any).env;
  delete (options as any).permission;
  delete (options as any).startTimeoutMs;
  delete (options as any).binary;
  delete (options as any).launcher;
  delete (options as any).brainOptions;
  const session = new AntigravitySession(
    over.binary ?? 'agy',
    over.launcher ?? fakeLauncher(spawnedArgs),
    over.startTimeoutMs ?? 15_000,
    { brainDir, pollIntervalMs: 15, wakeupGraceMs: 150, ...(over.brainOptions ?? {}) },
  );
  cleanup.push(() => session.close());
  const received = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const turn = async (text: string) => {
    const before = events.length;
    session.send(text);
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before), { timeout: 10_000 });
  };
  const appendBrain = (conversationId: string, steps: Record<string, unknown>[]) => {
    const logsDir = path.join(brainDir, conversationId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, 'transcript_full.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  };
  return {
    session, options, callbacks, brainDir, spawnedArgs, events, tokens, messages, messageTools,
    toolUses, toolResults, filesEdited, permissionRequests, tasksStarted, tasksProgress, tasksUpdated, tasksNotified,
    done, errors, received, turn, appendBrain,
  };
}

const permissionReplies = (h: Harness) => h.received().filter((m: any) => m.method === undefined && m.result?.outcome).map((m: any) => m.result.outcome);

describe('AntigravitySession turns', () => {
  it('streams a text turn, finishes the message, and reports usage and the model catalog', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    expect(h.callbacks.onCapabilitiesDiscovered).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ value: expect.any(String) })]), []);
    await h.turn('TEXT hello');
    expect(h.tokens.join('')).toBe('Hello from Antigravity.');
    expect(h.messages).toEqual(['Hello from Antigravity.']);
    expect(h.done).toHaveBeenCalledWith(expect.stringMatching(/^fake-session-/), 0, 1);
    expect(h.callbacks.onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'antigravity', lastTurnTokens: expect.objectContaining({ total: 68106 }) }));
    expect(h.session.turnInFlight).toBe(false);
    expect((await h.session.getContextUsage())?.maxTokens).toBe(1048576);
    expect((await h.session.getUsageSnapshot())?.tokens?.total).toBe(68106);
    // The prompt carries the user's text and the per-turn clock as separate blocks.
    const prompt = h.received().find((m: any) => m.method === 'session/prompt');
    expect(prompt.params.prompt[0]).toEqual({ type: 'text', text: 'TEXT hello' });
  });

  it('sends the handshake agy needs: protocol 1, no client fs or terminal', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    const init = h.received().find((m: any) => m.method === 'initialize');
    expect(init.params).toEqual({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const created = h.received().find((m: any) => m.method === 'session/new');
    expect(created.params).toEqual({ cwd: process.cwd(), mcpServers: [] });
  });

  it('queues a second message while a turn is running and runs it after', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    h.session.send('TEXT one');
    h.session.send('TEXT two');
    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(h.received().filter((m: any) => m.method === 'session/prompt')).toHaveLength(2);
  });

  it('prepends the system prompt to the first prompt only', async () => {
    const h = makeHarness({ appendSystemPrompt: 'Be brief.' });
    await h.session.start(h.options);
    await h.turn('TEXT a');
    await h.turn('TEXT b');
    const prompts = h.received().filter((m: any) => m.method === 'session/prompt').map((m: any) => m.params.prompt[0].text);
    expect(prompts[0]).toContain('<system-instructions>\nBe brief.\n</system-instructions>');
    expect(prompts[1]).toBe('TEXT b');
  });
});

describe('AntigravitySession edits and permissions', () => {
  it('shows the diff on the approval card, writes on allow, and reports the edited file', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    await h.turn('EDIT create hello.txt');
    expect(h.permissionRequests).toHaveLength(1);
    expect(h.permissionRequests[0].tool).toBe('Antigravity: Write');
    expect(h.permissionRequests[0].detail).toContain('/work/project/hello.txt (new file)');
    expect(h.permissionRequests[0].detail).toContain('+ hi');
    expect(permissionReplies(h)).toEqual([{ outcome: 'selected', optionId: 'allow' }]);
    expect(h.toolUses).toHaveLength(1);
    expect(h.toolUses[0]).toMatchObject({ name: 'Write', summary: '/work/project/hello.txt', status: 'pending' });
    expect(h.toolResults).toEqual([[h.toolUses[0].toolUseId, 'success']]);
    expect(h.filesEdited).toEqual([['/work/project/hello.txt']]);
    // The Write call rides with the message that closes it (as Claude's tool_use blocks do), so the card persists in the transcript.
    expect(h.messages).toEqual(['', 'Created the file.']);
    expect(h.messageTools).toEqual([['Write'], []]);
  });

  it('replies deny and marks the tool failed when the user refuses', async () => {
    const h = makeHarness({ permission: async () => false });
    await h.session.start(h.options);
    await h.turn('EDIT create hello.txt');
    expect(permissionReplies(h)).toEqual([{ outcome: 'selected', optionId: 'deny' }]);
    expect(h.toolResults).toEqual([[h.toolUses[0].toolUseId, 'error']]);
    expect(h.filesEdited).toEqual([]);
    expect(h.messages).toEqual(['', 'The edit was refused.']);
  });

  it('treats a rejected permission prompt as a deny', async () => {
    const h = makeHarness({ permission: async () => { throw new Error('card closed'); } });
    await h.session.start(h.options);
    await h.turn('EDIT x');
    expect(permissionReplies(h)).toEqual([{ outcome: 'selected', optionId: 'deny' }]);
  });

  it('asks for a shell command in default mode', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    await h.turn('SHELL echo done');
    expect(h.permissionRequests).toHaveLength(1);
    expect(h.permissionRequests[0].tool).toBe('Antigravity: Bash');
    expect(h.toolUses[0]).toMatchObject({ name: 'Bash' });
    expect(h.toolResults[0][1]).toBe('success');
  });

  it('acceptEdits allows an edit without a prompt but still asks for the shell, and puts agy in accept-edits', async () => {
    const h = makeHarness({ permissionMode: 'acceptEdits' });
    await h.session.start(h.options);
    expect(h.received().find((m: any) => m.method === 'session/set_mode')?.params.modeId).toBe('accept-edits');
    await h.turn('EDIT x');
    expect(h.permissionRequests).toHaveLength(0);
    expect(permissionReplies(h)).toEqual([{ outcome: 'selected', optionId: 'allow' }]);
    await h.turn('SHELL ls');
    expect(h.permissionRequests).toHaveLength(1);
  });

  it('plan mode refuses edits outright, announces plan mode, and selects agy plan mode', async () => {
    const h = makeHarness({ permissionMode: 'plan' });
    await h.session.start(h.options);
    expect(h.received().find((m: any) => m.method === 'session/set_mode')?.params.modeId).toBe('plan');
    await h.turn('EDIT x');
    expect(h.callbacks.onEnterPlanMode).toHaveBeenCalled();
    expect(h.permissionRequests).toHaveLength(0);
    expect(permissionReplies(h)).toEqual([{ outcome: 'selected', optionId: 'deny' }]);
  });

  it('dontAsk denies anything that would prompt', async () => {
    const h = makeHarness({ permissionMode: 'dontAsk' });
    await h.session.start(h.options);
    await h.turn('SHELL rm -rf /');
    expect(h.permissionRequests).toHaveLength(0);
    expect(permissionReplies(h)).toEqual([{ outcome: 'selected', optionId: 'deny' }]);
  });

  it('bypassPermissions allows everything without a prompt', async () => {
    const h = makeHarness({ permissionMode: 'bypassPermissions' });
    await h.session.start(h.options);
    await h.turn('SHELL ls');
    expect(h.permissionRequests).toHaveLength(0);
    expect(permissionReplies(h)).toEqual([{ outcome: 'selected', optionId: 'allow' }]);
  });

  it('a denylist refuses the edit and the shell even in a permissive mode, and keeps agy out of auto-approve', async () => {
    const h = makeHarness({ permissionMode: 'bypassPermissions', disallowedTools: ['Write', 'Bash'] });
    await h.session.start(h.options);
    expect(h.received().find((m: any) => m.method === 'session/set_mode')).toBeUndefined();
    await h.turn('EDIT x');
    await h.turn('SHELL ls');
    expect(permissionReplies(h)).toEqual([{ outcome: 'selected', optionId: 'deny' }, { outcome: 'selected', optionId: 'deny' }]);
    expect(h.permissionRequests).toHaveLength(0);
  });

  it('applies a live permission-mode change to agy and to the next request', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    await h.session.setPermissionMode('acceptEdits');
    expect(h.received().filter((m: any) => m.method === 'session/set_mode').map((m: any) => m.params.modeId)).toEqual(['accept-edits']);
    await h.turn('EDIT x');
    expect(h.permissionRequests).toHaveLength(0);
  });

  it('switches model with session/set_model', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    await h.session.setModel('claude-sonnet-4-6');
    expect(h.received().find((m: any) => m.method === 'session/set_model')?.params.modelId).toBe('claude-sonnet-4-6');
  });

  it('starts on the thread model when agy offers it, and ignores one it does not', async () => {
    const offered = makeHarness({ model: 'claude-sonnet-4-6' });
    await offered.session.start(offered.options);
    expect(offered.received().find((m: any) => m.method === 'session/set_model')?.params.modelId).toBe('claude-sonnet-4-6');
    const missing = makeHarness({ model: 'opus' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await missing.session.start(missing.options);
    expect(missing.received().find((m: any) => m.method === 'session/set_model')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('AntigravitySession cancel, crash and start failures', () => {
  it('interrupts a running turn with session/cancel and reports it as interrupted, not an error', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    h.session.send('HANG');
    await vi.waitFor(() => expect(h.tokens.join('')).toContain('working'), { timeout: 10_000 });
    await h.session.interrupt();
    await vi.waitFor(() => expect(h.events).toContain('interrupted'), { timeout: 10_000 });
    expect(h.received().find((m: any) => m.method === 'session/cancel')?.params.sessionId).toMatch(/^fake-session-/);
    expect(h.errors).toEqual([]);
    expect(h.done).not.toHaveBeenCalled();
    expect(h.session.turnInFlight).toBe(false);
    expect(h.messages).toEqual([]);
  });

  it('answers a pending approval as cancelled when interrupted', async () => {
    let release: (value: boolean) => void = () => undefined;
    const h = makeHarness({ permission: () => new Promise<boolean>((resolve) => { release = resolve; }) });
    await h.session.start(h.options);
    h.session.send('EDIT x');
    await vi.waitFor(() => expect(h.session.hasPendingPermission).toBe(true), { timeout: 10_000 });
    expect(h.session.canIdleReap()).toBe(false);
    await h.session.interrupt();
    await vi.waitFor(() => expect(permissionReplies(h)).toEqual([{ outcome: 'cancelled' }]), { timeout: 10_000 });
    release(true);
    expect(h.session.hasPendingPermission).toBe(false);
  });

  it('reports a crash mid-turn as one error and leaves the session not running', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    h.session.send('CRASH');
    await vi.waitFor(() => expect(h.errors).toHaveLength(1), { timeout: 10_000 });
    expect(h.errors[0].message).toMatch(/exited unexpectedly/);
    expect(h.session.turnInFlight).toBe(false);
    expect(() => h.session.send('TEXT again')).toThrow(/not running/);
  });

  it('tolerates a slow cold start within the start timeout', async () => {
    const h = makeHarness({ env: { FAKE_ACP_START_DELAY_MS: '400' }, startTimeoutMs: 10_000 });
    await h.session.start(h.options);
    await h.turn('TEXT hi');
    expect(h.messages).toEqual(['Hello from Antigravity.']);
  });

  it('fails start with a clear error, and no onError, when the handshake exceeds the start timeout', async () => {
    const h = makeHarness({ env: { FAKE_ACP_START_DELAY_MS: '2000' }, startTimeoutMs: 150 });
    await expect(h.session.start(h.options)).rejects.toThrow(/did not answer initialize within 150ms/);
    expect(h.errors).toEqual([]);
  });

  it('fails start with the install hint when agy is not installed', async () => {
    const h = makeHarness({ binary: '/definitely/not/here/agy', launcher: undefined as unknown as AcpLauncher });
    const session = new AntigravitySession('/definitely/not/here/agy');
    cleanup.push(() => session.close());
    await expect(session.start(h.options)).rejects.toThrow(/was not found\. Install the Antigravity CLI/);
    expect(h.errors).toEqual([]);
  });
});

describe('AntigravitySession resume', () => {
  it('swallows the replayed history and does not prepend the transcript when the saved session was found', async () => {
    const h = makeHarness({ resume: 'saved-1', resumeFallbackHistory: 'TRANSCRIPT\n', env: { FAKE_ACP_KNOWN_SESSIONS: 'saved-1' } });
    await h.session.start(h.options);
    const load = h.received().find((m: any) => m.method === 'session/load');
    expect(load.params).toMatchObject({ sessionId: 'saved-1', cwd: process.cwd(), mcpServers: [] });
    expect(h.received().find((m: any) => m.method === 'session/new')).toBeUndefined();
    // Nothing from the replay reached the transcript callbacks.
    expect(h.toolUses).toEqual([]);
    expect(h.tokens).toEqual([]);
    expect(h.messages).toEqual([]);
    await h.turn('TEXT go on');
    const prompt = h.received().find((m: any) => m.method === 'session/prompt');
    expect(prompt.params.sessionId).toBe('saved-1');
    expect(prompt.params.prompt[0].text).toBe('TEXT go on');
  });

  it('treats zero replayed history as a failed resume and sends the transcript with the first prompt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = makeHarness({ resume: 'unknown-id', resumeFallbackHistory: 'TRANSCRIPT\n' });
    await h.session.start(h.options);
    await h.turn('TEXT continue');
    await h.turn('TEXT again');
    const prompts = h.received().filter((m: any) => m.method === 'session/prompt').map((m: any) => m.params.prompt[0].text);
    expect(prompts[0]).toBe('TRANSCRIPT\nTEXT continue');
    expect(prompts[1]).toBe('TEXT again');
    warn.mockRestore();
  });

  it('falls back to a new session when session/load is rejected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = makeHarness({ resume: 'x', resumeFallbackHistory: 'TRANSCRIPT\n', env: { FAKE_ACP_FAIL_LOAD: '1' } });
    await h.session.start(h.options);
    expect(h.received().find((m: any) => m.method === 'session/new')).toBeDefined();
    await h.turn('TEXT hi');
    expect(h.received().find((m: any) => m.method === 'session/prompt').params.prompt[0].text).toBe('TRANSCRIPT\nTEXT hi');
    warn.mockRestore();
  });
});

describe('AntigravitySession MCP servers', () => {
  it('passes user MCP servers and the host-tools bridge (http, capability header) in session/new', async () => {
    const h = makeHarness({
      antigravity: {
        mcpServers: { docs: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer t' } } },
        dynamicTools: [{ name: 'ping_host', description: 'pong', inputSchema: { type: 'object' }, requiresApproval: false, invoke: async () => ({ success: true, text: 'pong' }) }],
      },
    });
    await h.session.start(h.options);
    const servers = h.received().find((m: any) => m.method === 'session/new').params.mcpServers;
    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual({ type: 'http', name: 'docs', url: 'https://mcp.example.test', headers: [{ name: 'Authorization', value: 'Bearer t' }] });
    expect(servers[1]).toMatchObject({ type: 'http', name: 'agent-threads', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) });
    expect(servers[1].headers).toEqual([{ name: 'X-Capability-Token', value: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });
});

describe('AntigravitySession message segmentation', () => {
  it('closes a message with the tools that followed its text, and starts the next one at the next text', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    h.session.send('HANG');
    await vi.waitFor(() => expect(h.tokens.join('')).toContain('working'), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const feed = (update: Record<string, unknown>) => h.session.handleSessionUpdate({ sessionId, update });
    const tool = { toolCallId: 't1', name: 'run_command', kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls' } };
    feed({ sessionUpdate: 'tool_call', ...tool, status: 'in_progress' });
    expect(h.messages).toEqual([]); // held: the message closes when the next text arrives or the turn ends
    feed({ sessionUpdate: 'tool_call_update', ...tool, status: 'completed' });
    feed({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } });
    expect(h.messages).toEqual(['working']);
    expect(h.messageTools).toEqual([['Bash']]);
    await h.session.interrupt();
    await vi.waitFor(() => expect(h.events).toContain('interrupted'), { timeout: 10_000 });
  });
});

describe('AntigravitySession host tools', () => {
  const hostTool = { name: 'host_echo', description: 'echo', inputSchema: { type: 'object' }, requiresApproval: true, invoke: async () => ({ success: true, text: 'ok' }) };
  const recorded = fixture('host-tool-call.json').permissionRequest.params;
  const call = (name: string) => ({ ...recorded, toolCall: { ...recorded.toolCall, name } });

  it('matches the shape recorded from the real agy', () => {
    expect(recorded.toolCall).toMatchObject({ name: 'mcp_agent-threads_host_echo', kind: 'other' });
  });

  it('lets the bridge own the approval: agy asks, the adapter allows without a second prompt', async () => {
    const h = makeHarness({ antigravity: { dynamicTools: [hostTool] } });
    await h.session.start(h.options);
    const reply = await h.session.handlePermissionRequest(call('mcp_agent-threads_host_echo'));
    expect(reply).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(h.permissionRequests).toHaveLength(0);
  });

  it('still prompts for a same-looking MCP tool the bridge does not own, and for any tool when there is no bridge', async () => {
    const h = makeHarness({ antigravity: { dynamicTools: [hostTool] } });
    await h.session.start(h.options);
    await h.session.handlePermissionRequest(call('mcp_agent-threads_not_ours'));
    await h.session.handlePermissionRequest(call('mcp_other_host_echo'));
    expect(h.permissionRequests).toHaveLength(2);
    const bare = makeHarness();
    await bare.session.start(bare.options);
    await bare.session.handlePermissionRequest(call('mcp_agent-threads_host_echo'));
    expect(bare.permissionRequests).toHaveLength(1);
  });
});

describe('AntigravitySession raw log and commands', () => {
  it('logs under the antigravity/ prefix, omits streaming chunks, and forwards the command list', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    await h.turn('EDIT x');
    const types = (h.callbacks.onRawEvent as any).mock.calls.map((call: any[]) => call[0].type);
    expect(types).toContain('antigravity/initialize');
    expect(types).toContain('antigravity/tool_call');
    expect(types).toContain('antigravity/permission_request');
    expect(types.every((type: string) => type.startsWith('antigravity/'))).toBe(true);
    expect(types).not.toContain('antigravity/agent_message_chunk');
    expect(types).not.toContain('antigravity/usage_update');
  });
});

describe('AntigravitySession bypassPermissions CLI flag and mid-session respawn', () => {
  it('launches with --dangerously-skip-permissions in bypassPermissions, unless a denylist blocks edits or shell', async () => {
    const bypass = makeHarness({ permissionMode: 'bypassPermissions' });
    await bypass.session.start(bypass.options);
    expect(bypass.spawnedArgs).toEqual([['acp', '--dangerously-skip-permissions']]);

    const denylisted = makeHarness({ permissionMode: 'bypassPermissions', disallowedTools: ['Bash'] });
    await denylisted.session.start(denylisted.options);
    expect(denylisted.spawnedArgs).toEqual([['acp']]);
  });

  it('respawns agy with updated CLI flags on setPermissionMode toggle, resumes the same sessionId, and keeps system prompt intact', async () => {
    const hostTool = { name: 'host_echo', description: 'echo', inputSchema: { type: 'object' }, requiresApproval: true, invoke: async () => ({ success: true, text: 'ok' }) };
    const h = makeHarness({ appendSystemPrompt: 'Stay concise.', antigravity: { dynamicTools: [hostTool] } });
    await h.session.start(h.options);
    expect(h.spawnedArgs).toEqual([['acp']]);

    await h.turn('TEXT first');
    const firstSessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;

    // Toggle default -> bypassPermissions: respawns with --dangerously-skip-permissions and resumes firstSessionId.
    await h.session.setPermissionMode('bypassPermissions');
    expect(h.errors).toEqual([]);
    expect(h.spawnedArgs).toEqual([['acp'], ['acp', '--dangerously-skip-permissions']]);
    const loads = h.received().filter((m: any) => m.method === 'session/load');
    expect(loads).toHaveLength(1);
    expect(loads[0].params.sessionId).toBe(firstSessionId);
    // Host tools bridge stayed alive and was passed into session/load.
    expect(loads[0].params.mcpServers).toEqual([
      expect.objectContaining({ type: 'http', name: 'agent-threads', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) }),
    ]);

    await h.turn('TEXT second');
    const prompts = h.received().filter((m: any) => m.method === 'session/prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1].params.sessionId).toBe(firstSessionId);
    // System prompt rode the first prompt and was NOT re-injected after the session/load respawn.
    expect(prompts[0].params.prompt[0].text).toContain('<system-instructions>');
    expect(prompts[1].params.prompt[0].text).toBe('TEXT second');

    // Toggle bypassPermissions -> default: respawns back to ['acp'].
    await h.session.setPermissionMode('default');
    expect(h.errors).toEqual([]);
    expect(h.spawnedArgs).toEqual([['acp'], ['acp', '--dangerously-skip-permissions'], ['acp']]);
  });

  it('preserves systemPromptPending and skips spurious fallback warning when toggled before the first turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = makeHarness({ appendSystemPrompt: 'First turn rules.', resumeFallbackHistory: 'OLD\n' });
    await h.session.start(h.options);
    await h.session.setPermissionMode('bypassPermissions');
    expect(warn).not.toHaveBeenCalled();
    await h.turn('TEXT first');
    const promptText = h.received().find((m: any) => m.method === 'session/prompt').params.prompt[0].text;
    expect(promptText).toContain('<system-instructions>\nFirst turn rules.\n</system-instructions>');
    expect(promptText).not.toContain('OLD\n');
    warn.mockRestore();
  });

  it('defers CLI respawn until an active turn finishes when toggled mid-turn', async () => {
    let releasePermission: (allow: boolean) => void = () => undefined;
    const h = makeHarness({ permission: () => new Promise<boolean>((resolve) => { releasePermission = resolve; }) });
    await h.session.start(h.options);
    h.session.send('EDIT mid-turn');
    await vi.waitFor(() => expect(h.session.hasPendingPermission).toBe(true), { timeout: 10_000 });

    await h.session.setPermissionMode('bypassPermissions');
    // Still 1 process while the turn is in flight.
    expect(h.spawnedArgs).toEqual([['acp']]);

    releasePermission(true);
    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(h.spawnedArgs).toEqual([['acp'], ['acp', '--dangerously-skip-permissions']]), { timeout: 10_000 });
    expect(h.errors).toEqual([]);
  });
});

describe('AntigravitySession subagents and post-turn brain wakeups', () => {
  it('maps invoke_subagent to an Agent card and finishes normally when no brain transcript exists on disk', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    await h.turn('SUBAGENT wire-only');
    expect(h.toolUses).toHaveLength(1);
    expect(h.toolUses[0]).toMatchObject({ name: 'Agent', summary: 'Auth Researcher' });
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(h.session.turnInFlight).toBe(false);
  });

  it('holds the turn open across subagent execution, emits live subagent progress/completion, and streams the post-ACP wakeup reply', async () => {
    const h = makeHarness({ brainOptions: { wakeupGraceMs: 2_000 } });
    await h.session.start(h.options);
    h.session.send('SUBAGENT_BRAIN investigate auth');

    // Initial ACP prompt finishes and subagent starts, while the turn stays open waiting on child-sub-1.
    await vi.waitFor(() => expect(h.tasksStarted).toHaveLength(1), { timeout: 10_000 });
    expect(h.tasksStarted[0]).toEqual({
      taskId: 'child-sub-1',
      description: 'Auth Researcher',
      isWorkflow: false,
      taskType: 'subagent',
      subagentType: 'research',
      parentNativeAgentId: undefined,
      model: 'flash',
    });
    await vi.waitFor(() => expect(h.messages).toContain('Waiting on Auth Researcher.'), { timeout: 10_000 });
    expect(h.done).not.toHaveBeenCalled();
    expect(h.session.turnInFlight).toBe(true);
    expect(h.session.canIdleReap()).toBe(false);

    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;

    // Child subagent runs grep_search, sends message to parent, and completes its turn.
    h.appendBrain('child-sub-1', [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 'c1', name: 'grep_search', args: { Query: 'verifyToken' } }],
      },
      { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'src/auth.ts:12' },
    ]);
    await vi.waitFor(() => expect(h.tasksProgress).toContainEqual({
      taskId: 'child-sub-1',
      description: 'Auth Researcher',
      lastToolName: 'Grep',
    }), { timeout: 10_000 });
    expect(h.done).not.toHaveBeenCalled();

    h.appendBrain('child-sub-1', [
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 'c2', name: 'send_message', args: { Recipient: sessionId, Message: 'Token check missing in src/auth.ts' } }],
      },
      { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Message sent.' },
      { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Completed auth audit.' },
    ]);
    await vi.waitFor(() => expect(h.tasksNotified).toContainEqual({
      taskId: 'child-sub-1',
      status: 'completed',
      summary: 'Completed auth audit.',
    }), { timeout: 10_000 });
    // Still waiting for parent's reactive wakeup turn!
    expect(h.done).not.toHaveBeenCalled();

    // Parent receives SYSTEM_MESSAGE wakeup, edits /repo/src/auth.ts, and writes final summary.
    h.appendBrain(sessionId, [
      {
        step_index: 4,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `<SYSTEM_MESSAGE>\nYou have received the following message(s) while idle:\n[Message] timestamp=2026-11-14T07:00:00Z sender=child-sub-1\nToken check missing in src/auth.ts\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Applying fix now.',
        tool_calls: [{ id: 'wake-edit-1', name: 'edit_file', args: { Path: '/repo/src/auth.ts' } }],
      },
      { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Made 1 replacement.' },
      { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Auth fix complete.' },
    ]);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h.session.turnInFlight).toBe(false);
    expect(h.session.canIdleReap()).toBe(true);
    expect(h.filesEdited).toContainEqual(['/repo/src/auth.ts']);
    expect(h.toolUses.map((t) => t.name)).toEqual(['Agent', 'Edit']);
    expect(h.messages).toEqual(['', 'Waiting on Auth Researcher.', 'Applying fix now.', 'Auth fix complete.']);
  });

  it('interrupts cleanly while held open waiting on a background subagent', async () => {
    const h = makeHarness({ brainOptions: { wakeupGraceMs: 5_000 } });
    await h.session.start(h.options);
    h.session.send('SUBAGENT_BRAIN long task');

    await vi.waitFor(() => expect(h.tasksStarted).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(h.messages).toContain('Waiting on Auth Researcher.'), { timeout: 10_000 });
    expect(h.done).not.toHaveBeenCalled();

    await h.session.interrupt();
    expect(h.events).toContain('interrupted');
    expect(h.done).not.toHaveBeenCalled();
    expect(h.session.turnInFlight).toBe(false);
    expect(h.tasksUpdated).toContainEqual({ taskId: 'child-sub-1', patch: { status: 'killed' } });
    expect(h.tasksNotified).toContainEqual({ taskId: 'child-sub-1', status: 'stopped', summary: 'Interrupted' });
  });

  it('tracks nested grandchildren, revives completed subagents on send_message, and marks killed subagents on manage_subagents', async () => {
    const h = makeHarness({ brainOptions: { wakeupGraceMs: 80 } });
    await h.session.start(h.options);
    h.session.send('SUBAGENT_BRAIN hierarchy');

    await vi.waitFor(() => expect(h.tasksStarted).toHaveLength(1), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;

    // Child spawns a nested grandchild, then child finishes first while grandchild runs; parent wakes and kills grandchild.
    h.appendBrain('child-sub-1', [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 'n1', name: 'invoke_subagent', args: { TypeName: 'self', Role: 'Helper Worker', Prompt: 'Subtask' } }],
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: 'Created the following subagent:\n{\n  "conversationId": "grandchild-1"\n}',
      },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Delegated to helper.' },
    ]);

    await vi.waitFor(() => expect(h.tasksStarted).toContainEqual(expect.objectContaining({
      taskId: 'grandchild-1',
      description: 'Helper Worker',
      parentNativeAgentId: 'child-sub-1',
    })), { timeout: 10_000 });

    // Parent wakes up, re-messages child-sub-1, then kills both via manage_subagents.
    h.appendBrain(sessionId, [
      { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-sub-1\nDelegated.' },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 'm1', name: 'send_message', args: { Recipient: 'child-sub-1', Message: 'Wrap up' } }],
      },
      { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Sent.' },
      {
        step_index: 7,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 'm2', name: 'manage_subagents', args: { Action: 'kill_all' } }],
      },
      { step_index: 8, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Killed all.' },
      { step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Wrapped up.' },
    ]);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h.tasksUpdated).toContainEqual({ taskId: 'child-sub-1', patch: { status: 'in_progress', description: 'Auth Researcher' } });
    expect(h.tasksUpdated).toContainEqual({ taskId: 'child-sub-1', patch: { status: 'killed' } });
    expect(h.tasksUpdated).toContainEqual({ taskId: 'grandchild-1', patch: { status: 'killed' } });
  });

  it('anchors brain generic-step parsers, rejects placeholder IDs, and unwraps compact-transcript quoted arguments', () => {
    const subHeader = 'Created the ' + 'following subagent:';
    const bgHeader = 'Tool is running as a ' + 'background task with task id: ';

    expect(parseAntigravityCreatedSubagent(`${subHeader}\n{\n  "conversationId": "ecf60001-30fd-4c5b-824a-8c6f7d9324e6"\n}`))
      .toEqual({ conversationId: 'ecf60001-30fd-4c5b-824a-8c6f7d9324e6' });
    expect(parseAntigravityCreatedSubagent(`Created At: 2026-11-14T10:00:00-05:00\nCompleted At: 2026-11-14T10:00:01-05:00\n${subHeader}\n{\n  "conversationId": "child-sub-1"\n}`))
      .toEqual({ conversationId: 'child-sub-1' });
    expect(parseAntigravityCreatedSubagent(`${subHeader}\n{\n  "conversationId": "..."\n}`)).toBeNull();
    expect(parseAntigravityCreatedSubagent(`Showing lines 90-100\n91: * ${subHeader}\n{\n  "conversationId": "child-sub-1"\n}`)).toBeNull();
    expect(parseAntigravityCreatedSubagent(`+ ${subHeader}\n+ {\n+   "conversationId": "child-sub-1"\n+ }`)).toBeNull();

    expect(parseAntigravityBackgroundTask(`Created At: 2026-11-14T10:00:00Z\nCompleted At: 2026-11-14T10:00:01Z\n${bgHeader}ecf60001/task-42\nOutput:`))
      .toEqual({ taskId: 'ecf60001/task-42' });
    expect(parseAntigravityBackgroundTask(`${bgHeader}...`)).toBeNull();
    expect(parseAntigravityBackgroundTask(`104: // ${bgHeader}abc-123`)).toBeNull();

    expect(cleanBrainArgString('child-1')).toBe('child-1');
    expect(cleanBrainArgString('"child-1"')).toBe('child-1');
    expect(cleanBrainArgStringArray(['a', '"b"'])).toEqual(['a', 'b']);
    expect(cleanBrainArgStringArray('["child-1", "child-2"]')).toEqual(['child-1', 'child-2']);
  });

  it('never hangs on read_file or diff outputs containing subagent/background headers when no spawn tool was called', async () => {
    let releasePermission: (allow: boolean) => void = () => undefined;
    const h = makeHarness({
      brainOptions: { wakeupGraceMs: 5_000 },
      permission: () => new Promise<boolean>((resolve) => { releasePermission = resolve; }),
    });
    await h.session.start(h.options);
    h.session.send('EDIT inspect-brain');
    await vi.waitFor(() => expect(h.session.hasPendingPermission).toBe(true), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const subHeader = 'Created the ' + 'following subagent:';
    const bgHeader = 'Tool is running as a ' + 'background task with task id: ';

    h.appendBrain(sessionId, [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 'r1', name: 'read_file', args: { Path: '/repo/src/antigravityBrain.ts' } }],
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `${subHeader}\n{\n  "conversationId": "phantom-sub"\n}`,
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `${bgHeader}phantom-bg-1\n`,
      },
      { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Created the file.' },
    ]);

    releasePermission(true);
    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(h.tasksStarted).toEqual([]);
    expect(h.session.turnInFlight).toBe(false);
  });

  it('keeps parent turn open while a child subagent waits on its own background run_command and unwraps compact-quoted args', async () => {
    const h = makeHarness({ brainOptions: { wakeupGraceMs: 60 } });
    await h.session.start(h.options);
    h.session.send('SUBAGENT_BRAIN child-bg-cmd');

    await vi.waitFor(() => expect(h.tasksStarted).toHaveLength(1), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const bgHeader = 'Tool is running as a ' + 'background task with task id: ';

    h.appendBrain('child-sub-1', [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 'bg1', name: 'run_command', args: { CommandLine: 'npm test', WaitMsBeforeAsync: 500 } }],
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `Created At: 2026-11-14T08:00:00Z\nCompleted At: 2026-11-14T08:00:01Z\n${bgHeader}child-sub-1/task-9\n`,
      },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Waiting for full test run to finish...' },
    ]);

    // Wait well past wakeupGraceMs (60ms): child is waiting on task-9, so neither child completion nor parent onDone may fire.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.tasksNotified.filter((n) => n.taskId === 'child-sub-1' && n.status === 'completed')).toEqual([]);
    expect(h.done).not.toHaveBeenCalled();
    expect(h.session.turnInFlight).toBe(true);

    // Background command finishes inside child; child sends compact-quoted message to parent and completes.
    h.appendBrain('child-sub-1', [
      {
        step_index: 3,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: '<SYSTEM_MESSAGE>\n[Message] sender=child-sub-1/task-9\n72 passed\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 'sm1', name: 'send_message', args: { Recipient: JSON.stringify(sessionId), Message: '"All 72 tests passed."' } }],
      },
      { step_index: 5, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Sent.' },
      { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Reported test results.' },
    ]);

    await vi.waitFor(() => expect(h.tasksNotified).toContainEqual({
      taskId: 'child-sub-1',
      status: 'completed',
      summary: 'Reported test results.',
    }), { timeout: 10_000 });
    expect(h.done).not.toHaveBeenCalled();

    // Parent receives wakeup and kills any lingering child via compact-quoted manage_subagents array.
    h.appendBrain(sessionId, [
      { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-sub-1\nAll 72 tests passed.' },
      { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Everything green.' },
    ]);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h.messages).toContain('Everything green.');
  });

  it('preserves fast post-ACP wakeup steps written before session/prompt resolves and catches up late wakeups on Turn 2', async () => {
    let releasePermission: (allow: boolean) => void = () => undefined;
    const h = makeHarness({
      brainOptions: { wakeupGraceMs: 60 },
      permission: () => new Promise<boolean>((resolve) => { releasePermission = resolve; }),
    });
    await h.session.start(h.options);
    h.session.send('EDIT fast-wakeup');
    await vi.waitFor(() => expect(h.session.hasPendingPermission).toBe(true), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const subHeader = 'Created the ' + 'following subagent:';

    // Both the ACP turn AND its fast post-turn wakeup land on disk before `session/prompt` resolves over stdio.
    h.appendBrain('fast-sub-1', [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Fast audit complete.' },
    ]);
    h.appendBrain(sessionId, [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 's1', name: 'invoke_subagent', args: { Role: '"Fast Worker"', TypeName: '"research"' } }],
      },
      { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `${subHeader}\n{\n  "conversationId": "fast-sub-1"\n}` },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Created the file.' },
      { step_index: 3, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=fast-sub-1\nFast audit complete.' },
      { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Fast Worker finished: all good.' },
    ]);

    // Let onBrainTick run while acpPromptInFlight is still true.
    await new Promise((resolve) => setTimeout(resolve, 60));
    releasePermission(true);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h.tasksStarted).toContainEqual(expect.objectContaining({
      taskId: 'fast-sub-1',
      description: 'Fast Worker',
      subagentType: 'research',
    }));
    expect(h.messages).toContain('Fast Worker finished: all good.');

    // Now simulate a late between-turn wakeup landing while idle (after Turn 1 closed) before Turn 2 starts.
    h.appendBrain('reviewer-sub-2', [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'LGTM.' },
    ]);
    h.appendBrain(sessionId, [
      { step_index: 5, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=fast-sub-1\nFollow-up note' },
      {
        step_index: 6,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Spawning reviewer.',
        tool_calls: [{ id: 's2', name: 'invoke_subagent', args: { Role: 'Code Reviewer', TypeName: 'research' } }],
      },
      { step_index: 7, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `${subHeader}\n{\n  "conversationId": "reviewer-sub-2"\n}` },
      { step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Waiting on reviewer.' },
      { step_index: 9, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=reviewer-sub-2\nLGTM.' },
      { step_index: 10, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Late review complete.' },
    ]);

    await h.turn('TEXT second turn');
    expect(h.done).toHaveBeenCalledTimes(2);
    expect(h.tasksStarted).toContainEqual(expect.objectContaining({
      taskId: 'reviewer-sub-2',
      description: 'Code Reviewer',
    }));
    expect(h.messages).toContain('Late review complete.');
    expect(h.messages[h.messages.length - 1]).toBe('Hello from Antigravity.');
  });
});
