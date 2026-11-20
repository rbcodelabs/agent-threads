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
  antigravitySupportsOutOfTurnAcp,
  antigravityToolName,
  antigravityToolSummary,
  antigravityTurnTokens,
  buildAntigravityElicitationReply,
  parseAntigravityElicitation,
  resolveAntigravityPermission,
  type AntigravityBrainOptions,
} from '../../src/AntigravitySession';
import type { AskQuestion } from '../../src/types';
import {
  cleanBrainArgBoolean,
  cleanBrainArgString,
  cleanBrainArgStringArray,
  extractBrainToolCallBgMeta,
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
  it('passes --dangerously-skip-permissions in bypassPermissions and auto when no edit/shell denylist applies', () => {
    for (const mode of ['bypassPermissions', 'auto'] as const) {
      expect(antigravityShouldSkipPermissions(mode)).toBe(true);
      expect(antigravityCliArgs(mode)).toEqual(['acp', '--dangerously-skip-permissions']);
    }

    for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk'] as const) {
      expect(antigravityShouldSkipPermissions(mode)).toBe(false);
      expect(antigravityCliArgs(mode)).toEqual(['acp']);
    }

    for (const denied of [['Write'], ['Edit'], ['Bash'], ['Write', 'Bash']] as const) {
      expect(antigravityShouldSkipPermissions('bypassPermissions', denied)).toBe(false);
      expect(antigravityShouldSkipPermissions('auto', denied)).toBe(false);
      expect(antigravityCliArgs('bypassPermissions', denied)).toEqual(['acp']);
    }
    expect(antigravityShouldSkipPermissions('bypassPermissions', ['WebFetch', 'CronCreate', 'CronDelete'])).toBe(true);
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
  askQuestion?: (questions: AskQuestion[]) => Promise<Record<string, string>>;
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
  const thoughts: string[] = [];
  const messages: string[] = [];
  const messageTools: string[][] = [];
  const toolUses: any[] = [];
  const toolResults: Array<[string, string]> = [];
  const filesEdited: string[][] = [];
  const permissionRequests: Array<{ tool: string; detail: string }> = [];
  const questionRequests: AskQuestion[][] = [];
  let questionsCanceled = 0;
  const tasksStarted: Array<{ taskId: string; description: string; isWorkflow?: boolean; taskType?: string; subagentType?: string; parentNativeAgentId?: string; model?: string }> = [];
  const tasksProgress: Array<{ taskId: string; description?: string; lastToolName?: string }> = [];
  const tasksUpdated: Array<{ taskId: string; patch: any }> = [];
  const tasksNotified: Array<{ taskId: string; status: string; summary: string }> = [];
  const done = vi.fn();
  const errors: Error[] = [];
  const callbacks = {
    onToken: (t: string) => tokens.push(t),
    onThinking: (t: string) => thoughts.push(t),
    onToolUse: (r: any) => { toolUses.push(r); },
    onMessage: (content: string, tools: Array<{ name: string }>) => { messages.push(content); messageTools.push(tools.map((t) => t.name)); },
    onRecap: () => undefined,
    onDone: (...args: unknown[]) => { events.push('done'); done(...args); },
    onInterrupted: () => { events.push('interrupted'); },
    onError: (e: Error) => { events.push('error'); errors.push(e); },
    onPermissionRequest: async (tool: string, detail: string) => { permissionRequests.push({ tool, detail }); return over.permission ? over.permission(tool, detail) : true; },
    onAskUserQuestion: async (questions: AskQuestion[]) => {
      questionRequests.push(questions);
      return over.askQuestion ? over.askQuestion(questions) : {};
    },
    onAskUserQuestionCanceled: () => { questionsCanceled++; },
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
  delete (options as any).askQuestion;
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
    session, options, callbacks, brainDir, spawnedArgs, events, tokens, thoughts, messages, messageTools,
    toolUses, toolResults, filesEdited, permissionRequests, questionRequests,
    getQuestionsCanceled: () => questionsCanceled,
    tasksStarted, tasksProgress, tasksUpdated, tasksNotified,
    done, errors, received, turn, appendBrain,
  };
}

const permissionReplies = (h: Harness) => h.received().filter((m: any) => m.method === undefined && m.result?.outcome).map((m: any) => m.result.outcome);
const elicitationReplies = (h: Harness) => h.received().filter((m: any) => m.method === undefined && typeof m.result?.action === 'string').map((m: any) => m.result);

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

  it('sends the handshake agy needs: protocol 1, no client fs or terminal, and form elicitation enabled', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    const init = h.received().find((m: any) => m.method === 'initialize');
    expect(init.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
    });
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

  it('normalizes IsDaemon booleans across full and compact brain transcripts and extracts per-tool bg metadata', () => {
    expect(cleanBrainArgBoolean(true)).toBe(true);
    expect(cleanBrainArgBoolean('true')).toBe(true);
    expect(cleanBrainArgBoolean('TRUE')).toBe(true);
    expect(cleanBrainArgBoolean(' true ')).toBe(true);
    expect(cleanBrainArgBoolean('"true"')).toBe(true);

    expect(cleanBrainArgBoolean(false)).toBe(false);
    expect(cleanBrainArgBoolean('false')).toBe(false);
    expect(cleanBrainArgBoolean('"false"')).toBe(false);
    expect(cleanBrainArgBoolean(1)).toBe(false);
    expect(cleanBrainArgBoolean(0)).toBe(false);
    expect(cleanBrainArgBoolean('')).toBe(false);
    expect(cleanBrainArgBoolean(null)).toBe(false);
    expect(cleanBrainArgBoolean(undefined)).toBe(false);
    expect(cleanBrainArgBoolean({ IsDaemon: true })).toBe(false);

    expect(extractBrainToolCallBgMeta('run_command', { IsDaemon: true })).toEqual({ bgCapable: true, isDaemon: true });
    expect(extractBrainToolCallBgMeta('run_command', { IsDaemon: '"true"' })).toEqual({ bgCapable: true, isDaemon: true });
    expect(extractBrainToolCallBgMeta('run_command', { IsDaemon: false })).toEqual({ bgCapable: true, isDaemon: false });
    expect(extractBrainToolCallBgMeta('run_command', { IsDaemon: '"false"' })).toEqual({ bgCapable: true, isDaemon: false });
    expect(extractBrainToolCallBgMeta('run_command', undefined)).toEqual({ bgCapable: true, isDaemon: false });

    expect(extractBrainToolCallBgMeta('schedule', { IsDaemon: true })).toEqual({ bgCapable: true, isDaemon: true });
    expect(extractBrainToolCallBgMeta('schedule', { IsDaemon: '"true"' })).toEqual({ bgCapable: true, isDaemon: true });
    expect(extractBrainToolCallBgMeta('schedule', { IsDaemon: false })).toEqual({ bgCapable: true, isDaemon: false });

    expect(extractBrainToolCallBgMeta('run_workflow', { IsDaemon: true })).toEqual({ bgCapable: true, isDaemon: false });
    expect(extractBrainToolCallBgMeta('read_file', { IsDaemon: true })).toEqual({ bgCapable: false, isDaemon: false });
    expect(extractBrainToolCallBgMeta(undefined, { IsDaemon: true })).toEqual({ bgCapable: false, isDaemon: false });
  });

  it('ignores IsDaemon run_command and schedule background tasks in a mixed PLANNER_RESPONSE batch so the turn finishes immediately', async () => {
    let releasePermission: (allow: boolean) => void = () => undefined;
    const h = makeHarness({
      brainOptions: { wakeupGraceMs: 5_000 },
      permission: () => new Promise<boolean>((resolve) => { releasePermission = resolve; }),
    });
    await h.session.start(h.options);
    h.session.send('SHELL start dev server and standing cron');
    await vi.waitFor(() => expect(h.session.hasPendingPermission).toBe(true), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const bgHeader = 'Tool is running as a ' + 'background task with task id: ';

    h.appendBrain(sessionId, [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [
          { id: 'cmd-sync', name: 'run_command', args: { CommandLine: 'lsof -i :3117', WaitMsBeforeAsync: 5000 } },
          { id: 'cmd-daemon', name: 'run_command', args: { CommandLine: 'npx next dev -p 3117', WaitMsBeforeAsync: 500, IsDaemon: true } },
          { id: 'sched-daemon', name: 'schedule', args: { CronExpression: '*/5 * * * *', Prompt: 'Check health', IsDaemon: '"true"' } },
        ],
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: 'Created At: 2026-11-17T10:00:00Z\nCompleted At: 2026-11-17T10:00:00Z\nCommand exited with code 1.\n',
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `Created At: 2026-11-17T10:00:01Z\nCompleted At: 2026-11-17T10:00:02Z\n${bgHeader}${sessionId}/task-301\n`,
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `${bgHeader}${sessionId}/task-302\n`,
      },
      { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Ran the command.' },
    ]);

    releasePermission(true);
    await vi.waitFor(() => expect(h.messages).toContain('Ran the command.'), { timeout: 5_000 });
    expect(h.tasksStarted).toEqual([]);
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(h.session.turnInFlight).toBe(false);
    expect(h.session.canIdleReap()).toBe(true);
  });

  it('tracks non-daemon async run_command while ignoring a sibling IsDaemon run_command in the same PLANNER_RESPONSE', async () => {
    let releasePermission: (allow: boolean) => void = () => undefined;
    const h = makeHarness({
      brainOptions: { wakeupGraceMs: 5_000 },
      permission: () => new Promise<boolean>((resolve) => { releasePermission = resolve; }),
    });
    await h.session.start(h.options);
    h.session.send('SHELL start daemon and run e2e suite');
    await vi.waitFor(() => expect(h.session.hasPendingPermission).toBe(true), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const bgHeader = 'Tool is running as a ' + 'background task with task id: ';

    h.appendBrain(sessionId, [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [
          { id: 'daemon-dev', name: 'run_command', args: { CommandLine: 'npm run dev', WaitMsBeforeAsync: 500, IsDaemon: '"true"' } },
          { id: 'async-suite', name: 'run_command', args: { CommandLine: 'npm run test:e2e', WaitMsBeforeAsync: 500, IsDaemon: '"false"' } },
        ],
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `${bgHeader}${sessionId}/task-daemon-1\n`,
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `${bgHeader}${sessionId}/task-suite-2\n`,
      },
      { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Ran the command.' },
    ]);

    releasePermission(true);
    await vi.waitFor(() => expect(h.messages).toContain('Ran the command.'), { timeout: 5_000 });
    expect(h.tasksStarted).toEqual([
      expect.objectContaining({
        taskId: `${sessionId}/task-suite-2`,
        description: 'Background task',
        isWorkflow: false,
        taskType: 'bash',
      }),
    ]);
    expect(h.done).not.toHaveBeenCalled();
    expect(h.session.turnInFlight).toBe(true);

    // Only the non-daemon task finishes and wakes the parent; the IsDaemon dev server remains running indefinitely.
    h.appendBrain(sessionId, [
      {
        step_index: 4,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-17T10:01:00Z sender=${sessionId}/task-suite-2\nE2E suite green.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'E2E suite passed while dev server stays up.',
      },
    ]);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(h.tasksNotified).toContainEqual({
      taskId: `${sessionId}/task-suite-2`,
      status: 'completed',
      summary: 'E2E suite green.',
    });
    expect(h.messages).toContain('E2E suite passed while dev server stays up.');
    expect(h.session.turnInFlight).toBe(false);
  });

  it('completes a child subagent immediately when its mixed PLANNER_RESPONSE starts a compact IsDaemon run_command', async () => {
    const h = makeHarness({ brainOptions: { wakeupGraceMs: 2_000 } });
    await h.session.start(h.options);
    h.session.send('SUBAGENT_BRAIN child-daemon-cmd');

    await vi.waitFor(() => expect(h.tasksStarted).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(h.messages).toContain('Waiting on Auth Researcher.'), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const bgHeader = 'Tool is running as a ' + 'background task with task id: ';

    h.appendBrain('child-sub-1', [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [
          { id: 'c-read', name: 'read_file', args: { Path: '/repo/package.json' } },
          { id: 'c-daemon', name: 'run_command', args: { CommandLine: 'npx next dev -p 3117', WaitMsBeforeAsync: 500, IsDaemon: '"true"' } },
        ],
      },
      { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: '{"name":"app"}' },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `Created At: 2026-11-17T10:02:00Z\nCompleted At: 2026-11-17T10:02:01Z\n${bgHeader}child-sub-1/task-408\n`,
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [
          { id: 'c-msg', name: 'send_message', args: { Recipient: JSON.stringify(sessionId), Message: '"Dev server listening on 3117."' } },
        ],
      },
      { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Sent.' },
      { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Started daemon server and reported back.' },
    ]);

    await vi.waitFor(() => expect(h.tasksNotified).toContainEqual({
      taskId: 'child-sub-1',
      status: 'completed',
      summary: 'Started daemon server and reported back.',
    }), { timeout: 500 });

    h.appendBrain(sessionId, [
      {
        step_index: 4,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-17T10:02:02Z sender=child-sub-1\nDev server listening on 3117.\n</SYSTEM_MESSAGE>',
      },
      { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Subagent started dev server cleanly.' },
    ]);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(h.session.turnInFlight).toBe(false);
    expect(h.session.canIdleReap()).toBe(true);
    expect(h.messages).toContain('Subagent started dev server cleanly.');
  });
});

describe('AntigravitySession permission respawn, wakeup stall recovery, and live thinking', () => {
  it('respawns agy with --dangerously-skip-permissions after mid-turn setPermissionMode + interrupt (both ACP and post-ACP)', async () => {
    const h = makeHarness({ permissionMode: 'default' });
    await h.session.start(h.options);
    expect(h.spawnedArgs).toEqual([['acp']]);

    // Case 1: switch to bypassPermissions during an in-flight ACP prompt, then interrupt.
    h.session.send('HANG');
    await vi.waitFor(() => expect(h.tokens.join('')).toContain('working'), { timeout: 10_000 });
    await h.session.setPermissionMode('bypassPermissions');
    expect(h.spawnedArgs).toEqual([['acp']]); // deferred while turn is running
    await h.session.interrupt();
    await vi.waitFor(() => expect(h.events).toContain('interrupted'), { timeout: 10_000 });
    await vi.waitFor(() => expect(h.spawnedArgs).toEqual([['acp'], ['acp', '--dangerously-skip-permissions']]), { timeout: 10_000 });

    // Next turn runs on the respawned skip-permissions process.
    await h.turn('TEXT after bypass');
    expect(h.done).toHaveBeenCalledTimes(1);

    // Case 2: switch back to acceptEdits while held open post-ACP waiting on a subagent, then interrupt.
    const sessionId = (h.received().filter((m: any) => m.method === 'session/prompt').pop() as any).params.sessionId;
    h.appendBrain(sessionId, [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Hello from Antigravity.' },
    ]);
    await h.turn('TEXT prime baseline');
    expect(h.done).toHaveBeenCalledTimes(2);

    const subHeader = 'Created the ' + 'following subagent:';
    h.appendBrain(sessionId, [
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 'sub-hold', name: 'invoke_subagent', args: { Role: 'Worker', TypeName: 'research' } }],
      },
      { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `${subHeader}\n{\n  "conversationId": "hold-sub-1"\n}` },
    ]);
    h.session.send('TEXT launch worker');
    await vi.waitFor(() => expect(h.tasksStarted).toContainEqual(expect.objectContaining({ taskId: 'hold-sub-1' })), { timeout: 10_000 });
    expect(h.session.turnInFlight).toBe(true);

    await h.session.setPermissionMode('acceptEdits');
    await h.session.interrupt();
    await vi.waitFor(() => expect(h.spawnedArgs).toEqual([
      ['acp'],
      ['acp', '--dangerously-skip-permissions'],
      ['acp'],
    ]), { timeout: 10_000 });
  }, 20_000);

  it('does not re-inject <system-instructions> when cold session/load succeeds with replayed history', async () => {
    const h = makeHarness({
      resume: 'saved-1',
      appendSystemPrompt: 'Follow repo rules.',
      resumeFallbackHistory: 'TRANSCRIPT\n',
      env: { FAKE_ACP_KNOWN_SESSIONS: 'saved-1' },
    });
    await h.session.start(h.options);
    await h.turn('TEXT go on');
    const prompt = h.received().find((m: any) => m.method === 'session/prompt');
    expect(prompt.params.prompt[0].text).toBe('TEXT go on');
  });

  it('promotes stalled post-ACP wakeup tool calls to an active session/prompt so agy can request permission and finish', async () => {
    const h = makeHarness({
      permissionMode: 'acceptEdits',
      env: { FAKE_ACP_WAKEUP_RESUME_MODE: 'SHELL' },
      brainOptions: { wakeupGraceMs: 60, wakeupToolStallMs: 70, wakeupCancelSettleMs: 15 },
    });
    await h.session.start(h.options);

    h.session.send('SUBAGENT_BRAIN coordinate subagent');
    await vi.waitFor(() => expect(h.tasksStarted).toContainEqual(expect.objectContaining({ taskId: 'child-sub-1' })), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    expect(h.done).not.toHaveBeenCalled();

    // Subagent finishes; parent wakes up via <SYSTEM_MESSAGE> and attempts run_command without --dangerously-skip-permissions, stalling with no GENERIC result.
    h.appendBrain('child-sub-1', [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Ready to verify.' },
    ]);
    h.appendBrain(sessionId, [
      { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-sub-1\nReady to verify.' },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Running verification command.',
        tool_calls: [{ id: 'stalled-cmd-1', name: 'run_command', args: { CommandLine: 'npm test' } }],
      },
    ]);

    // Session detects stalled post-ACP wakeup tool call, cancels internal wakeup, promotes to session/prompt, requests Bash permission over ACP, and completes!
    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h.received().some((m: any) => m.method === 'session/cancel')).toBe(true);
    const prompts = h.received().filter((m: any) => m.method === 'session/prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1].params.prompt[0].text).toContain('Resuming background wakeup');
    expect(h.permissionRequests).toContainEqual(expect.objectContaining({ tool: 'Antigravity: Bash' }));
    expect(h.messages).toContain('Ran the command.');
  }, 20_000);

  it('emits cleaned onThinking summaries from live agent_thought_chunk and post-ACP step.thinking, and injects execution guidance with host bridge', async () => {
    const h = makeHarness({
      appendSystemPrompt: 'Vault instructions.',
      antigravity: {
        dynamicTools: [{ name: 'ping_host', description: 'pong', inputSchema: { type: 'object' }, requiresApproval: false, invoke: async () => ({ success: true, text: 'pong' }) }],
      },
    });
    await h.session.start(h.options);
    await h.turn('TEXT hello');
    // Recorded agent_thought_chunk fixture emits a thought during normal prompt turns.
    expect(h.thoughts.length).toBeGreaterThan(0);
    expect(h.thoughts[0].length).toBeGreaterThan(0);

    const firstPrompt = h.received().find((m: any) => m.method === 'session/prompt').params.prompt[0].text as string;
    expect(firstPrompt).toContain('Antigravity execution note:');
    expect(firstPrompt).toContain('parallel');

    // Also emits onThinking for post-ACP wakeup step.thinking when content is empty.
    let releasePerm: (allow: boolean) => void = () => undefined;
    h.options.callbacks.onPermissionRequest = () => new Promise<boolean>((resolve) => { releasePerm = resolve; });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const subHeader = 'Created the ' + 'following subagent:';
    h.thoughts.length = 0;
    h.session.send('EDIT spawn reader');
    await vi.waitFor(() => expect(h.session.hasPendingPermission).toBe(true), { timeout: 10_000 });
    h.appendBrain(sessionId, [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ id: 's-think', name: 'invoke_subagent', args: { Role: 'Reader', TypeName: 'research' } }],
      },
      { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `${subHeader}\n{\n  "conversationId": "think-sub-1"\n}` },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Created the file.' },
    ]);
    releasePerm(true);
    await vi.waitFor(() => expect(h.tasksStarted).toContainEqual(expect.objectContaining({ taskId: 'think-sub-1' })), { timeout: 10_000 });

    h.appendBrain('think-sub-1', [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Read 10 files.' },
    ]);
    h.appendBrain(sessionId, [
      { step_index: 3, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=think-sub-1\nRead 10 files.' },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        thinking: 'Synthesizing findings across the 10 inspected files before summarizing.',
        content: '',
        tool_calls: [{ id: 'rf-1', name: 'read_file', args: { Path: '/repo/README.md' } }],
      },
      { step_index: 5, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'README contents' },
      { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Summary ready.' },
    ]);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(h.thoughts).toContain('Synthesizing findings across the 10 inspected files before summarizing.');
  }, 20_000);
});

// ── ACP form elicitation (`ask_question` -> `AskUserQuestion`) ───────────────

describe('parseAntigravityElicitation and buildAntigravityElicitationReply', () => {
  const recordedParams = fixture('ask-question-elicitation.json').elicitationRequest.params;

  it('parses the recorded agy acp ask_question schema into single-select and multi-select AskQuestions', () => {
    const fields = parseAntigravityElicitation(recordedParams);
    expect(fields).toHaveLength(2);
    expect(fields!.map((f) => f.askQuestion)).toEqual([
      {
        id: 'q1',
        question: 'Which events should pop a live alert?',
        header: '',
        options: [
          { label: '(Recommended) Direct personal triggers only (Task ASSIGNED + @MENTIONED)', description: '' },
          { label: 'All unread notifications (assignments, mentions, comments, and status changes)', description: '' },
        ],
        multiSelect: false,
        allowOther: true,
        source: 'antigravity',
        requestItemId: 'call_ask_question_1',
      },
      {
        id: 'q2',
        question: 'Pick toppings?',
        header: '',
        options: [
          { label: 'Cheese, aged cheddar', description: '' },
          { label: 'Peppers, roasted', description: '' },
        ],
        multiSelect: true,
        allowOther: true,
        source: 'antigravity',
        requestItemId: 'call_ask_question_1',
      },
    ]);
  });

  it('preserves option labels containing commas across single-select, multi-select, and write-in Other answers', () => {
    const fields = parseAntigravityElicitation(recordedParams)!;

    // Comma-bearing option labels selected on both single-select and multi-select + trailing comma-bearing write-in.
    expect(buildAntigravityElicitationReply(fields, {
      q1: 'All unread notifications (assignments, mentions, comments, and status changes)',
      q2: 'Cheese, aged cheddar,Peppers, roasted,Olives, kalamata, and basil',
    })).toEqual({
      action: 'accept',
      content: {
        q1: '2',
        q2: ['1', '2'],
        q2_other: 'Olives, kalamata, and basil',
      },
    });

    // Write-in only on single-select (including commas) and skipped multi-select question.
    expect(buildAntigravityElicitationReply(fields, {
      q1: 'Custom rule: mentions, reviews, and P0 alerts',
      q2: '',
    })).toEqual({
      action: 'accept',
      content: {
        q1_other: 'Custom rule: mentions, reviews, and P0 alerts',
      },
    });

    // Write-in only on multi-select omits `q2` and sets `q2_other`.
    expect(buildAntigravityElicitationReply(fields, {
      q1: '',
      q2: 'Mushrooms, sliced',
    })).toEqual({
      action: 'accept',
      content: {
        q2_other: 'Mushrooms, sliced',
      },
    });
  });

  it('prefers exact comma-bearing option matches over splitting into prefix + Other', () => {
    const fields = parseAntigravityElicitation({
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: {
            type: 'array',
            title: 'Choose?',
            items: {
              anyOf: [
                { const: '1', title: 'Alpha' },
                { const: '2', title: 'Alpha,Beta' },
              ],
            },
          },
          q1_other: { type: 'string', title: 'Other' },
        },
      },
    })!;

    // Selecting only Option 2 ("Alpha,Beta") must NOT be misparsed as Option 1 ("Alpha") + Other ("Beta").
    expect(buildAntigravityElicitationReply(fields, { q1: 'Alpha,Beta' })).toEqual({
      action: 'accept',
      content: { q1: ['2'] },
    });
  });

  it('supports composer shortcut answers keyed by question text and plain string fields without _other', () => {
    const recordedFields = parseAntigravityElicitation(recordedParams)!;
    expect(buildAntigravityElicitationReply(recordedFields, {
      'Which events should pop a live alert?': 'Only @mentions',
      'Pick toppings?': 'Cheese, aged cheddar',
    })).toEqual({
      action: 'accept',
      content: {
        q1_other: 'Only @mentions',
        q2: ['1'],
      },
    });

    const plainTextFields = parseAntigravityElicitation({
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: {
          branchName: { type: 'string', title: 'Target branch?' },
          strictChoice: { type: 'string', title: 'Env?', oneOf: [{ const: 'prod', title: 'Production' }] },
        },
      },
    })!;
    expect(plainTextFields.map((f) => ({ id: f.id, allowOther: f.allowOther, optionsCount: f.askQuestion.options.length }))).toEqual([
      { id: 'branchName', allowOther: true, optionsCount: 0 },
      { id: 'strictChoice', allowOther: false, optionsCount: 1 },
    ]);
    expect(buildAntigravityElicitationReply(plainTextFields, { branchName: 'main', strictChoice: 'Production' })).toEqual({
      action: 'accept',
      content: { branchName: 'main', strictChoice: 'prod' },
    });
  });

  it('rejects non-form or non-question schemas with null and maps empty aborted answer maps to cancel', () => {
    expect(parseAntigravityElicitation({ mode: 'url', requestedSchema: { properties: { q1: { type: 'string' } } } })).toBeNull();
    expect(parseAntigravityElicitation({ mode: 'form', requestedSchema: { properties: {} } })).toBeNull();
    expect(parseAntigravityElicitation({ mode: 'form', requestedSchema: { properties: { count: { type: 'integer' } } } })).toBeNull();

    const fields = parseAntigravityElicitation(recordedParams)!;
    expect(buildAntigravityElicitationReply(fields, {})).toEqual({ action: 'cancel' });
  });
});

describe('AntigravitySession elicitation/create integration', () => {
  it('routes ask_question elicitation/create through onAskUserQuestion and returns structured answers', async () => {
    const h = makeHarness({
      askQuestion: async (questions) => ({
        [questions[0].id!]: 'All unread notifications (assignments, mentions, comments, and status changes)',
        [questions[1].id!]: 'Cheese, aged cheddar,Extra garlic',
      }),
    });
    await h.session.start(h.options);
    await h.turn('ASK_QUESTION');

    expect(h.questionRequests).toHaveLength(1);
    expect(h.questionRequests[0]).toHaveLength(2);
    expect(h.questionRequests[0][0]).toMatchObject({
      id: 'q1',
      source: 'antigravity',
      multiSelect: false,
      allowOther: true,
    });
    expect(h.questionRequests[0][1]).toMatchObject({
      id: 'q2',
      source: 'antigravity',
      multiSelect: true,
      allowOther: true,
    });
    expect(elicitationReplies(h)).toEqual([
      {
        action: 'accept',
        content: {
          q1: '2',
          q2: ['1'],
          q2_other: 'Extra garlic',
        },
      },
    ]);
    expect(h.toolUses).toContainEqual(expect.objectContaining({
      name: 'AskUserQuestion',
      summary: 'Which events should pop a live alert?',
    }));
    expect(h.messages.join('\n')).toContain('"action":"accept"');
    const rawTypes = (h.callbacks.onRawEvent as any).mock.calls.map((c: any[]) => c[0].type);
    expect(rawTypes).toContain('antigravity/elicitation_create');
  });

  it('auto-cancels elicitation/create in dontAsk mode without prompting the user', async () => {
    const h = makeHarness({
      permissionMode: 'dontAsk',
      askQuestion: async () => { throw new Error('should not prompt in dontAsk'); },
    });
    await h.session.start(h.options);
    await h.turn('ASK_QUESTION');

    expect(h.questionRequests).toHaveLength(0);
    expect(elicitationReplies(h)).toEqual([{ action: 'cancel' }]);
  });

  it('declines non-form elicitation requests cleanly without stalling', async () => {
    const h = makeHarness();
    await h.session.start(h.options);
    await expect(h.session.handleElicitationCreate({ mode: 'url', message: 'Sign in' })).resolves.toEqual({ action: 'decline' });
    expect(h.questionRequests).toHaveLength(0);
  });

  it('cancels a pending elicitation on interrupt(), notifies onAskUserQuestionCanceled, and settles as interrupted', async () => {
    let releaseQuestion: (answers: Record<string, string>) => void = () => undefined;
    const h = makeHarness({
      askQuestion: () => new Promise<Record<string, string>>((resolve) => { releaseQuestion = resolve; }),
    });
    await h.session.start(h.options);
    h.session.send('ASK_QUESTION');

    await vi.waitFor(() => expect(h.session.hasPendingElicitation).toBe(true), { timeout: 10_000 });
    expect(h.session.canIdleReap()).toBe(false);

    await h.session.interrupt();
    await vi.waitFor(() => expect(h.events).toContain('interrupted'), { timeout: 10_000 });
    expect(elicitationReplies(h)).toEqual([{ action: 'cancel' }]);
    expect(h.getQuestionsCanceled()).toBe(1);
    expect(h.session.hasPendingElicitation).toBe(false);
    releaseQuestion({ q1: 'late' });
    expect(h.errors).toEqual([]);
  });

  it('fires onAskUserQuestionCanceled and clears pending elicitation state if agy crashes mid-question', async () => {
    let killAgent: () => void = () => undefined;
    const h = makeHarness({
      launcher: (opts) => {
        const channel = spawnAcpChannel({ ...opts, binaryPath: process.execPath, args: [AGENT] });
        killAgent = () => channel.kill();
        return channel;
      },
      askQuestion: () => new Promise<Record<string, string>>(() => undefined),
    });
    await h.session.start(h.options);
    h.session.send('ASK_QUESTION');

    // Wait until `elicitation/create` has definitely reached AntigravitySession before simulating the child crash.
    await vi.waitFor(() => expect(h.session.hasPendingElicitation).toBe(true), { timeout: 10_000 });
    expect(h.session.canIdleReap()).toBe(false);

    killAgent();
    await vi.waitFor(() => expect(h.errors).toHaveLength(1), { timeout: 10_000 });
    expect(h.errors[0].message).toMatch(/exited unexpectedly/);
    expect(h.getQuestionsCanceled()).toBe(1);
    expect(h.session.hasPendingElicitation).toBe(false);
    expect(h.session.canIdleReap()).toBe(true);
  });
});

// ── Post-ACP wakeup hang & agy 1.5.11+ out-of-turn ACP streaming fixes ───────

describe('AntigravitySession mid-wakeup deadline isolation and agy 1.5.11+ out-of-turn streaming', () => {
  it('does NOT close an active parent wakeup mid-inference when another subagent finishes and arms wakeupGraceMs', async () => {
    const h = makeHarness({
      permissionMode: 'bypassPermissions',
      brainOptions: { pollIntervalMs: 15, wakeupGraceMs: 40 },
    });
    await h.session.start(h.options);

    h.options.callbacks.onPermissionRequest = async () => true;
    h.session.send('SUBAGENT_BRAIN two-subagent mid-wakeup');
    await vi.waitFor(() => expect(h.tasksStarted).toContainEqual(expect.objectContaining({ taskId: 'child-sub-1' })), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const subHeader = 'Created the ' + 'following subagent:';

    h.appendBrain('child-sub-1', [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Part 1 ready.' },
    ]);
    h.appendBrain(sessionId, [
      { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-sub-1\nPart 1 ready.' },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Spawning second subagent and reading files.',
        tool_calls: [
          { id: 'spawn-2', name: 'invoke_subagent', args: { Role: 'Plugin Engineer', TypeName: 'self' } },
          { id: 'read-1', name: 'read_file', args: { Path: '/repo/a.ts' } },
        ],
      },
      { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `${subHeader}\n{\n  "conversationId": "child-sub-2"\n}` },
      { step_index: 7, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'contents of a.ts' },
    ]);

    await vi.waitFor(() => expect(h.tasksStarted).toContainEqual(expect.objectContaining({ taskId: 'child-sub-2' })), { timeout: 10_000 });
    expect(h.done).not.toHaveBeenCalled();

    // `wakeupPendingTools` is now empty while parent LLM is generating step 8; `child-sub-2` finishes and arms wakeupGraceMs (40ms).
    h.appendBrain('child-sub-2', [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Part 2 ready.' },
    ]);
    await vi.waitFor(() => expect(h.tasksNotified).toContainEqual(expect.objectContaining({ taskId: 'child-sub-2', status: 'completed' })), { timeout: 10_000 });

    // Wait well past `wakeupGraceMs` (120ms > 40ms) while parent is still mid-inference on step 8!
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(h.done).not.toHaveBeenCalled();
    expect(h.session.turnInFlight).toBe(true);

    h.appendBrain(sessionId, [
      {
        step_index: 8,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Writing test suite.',
        tool_calls: [{ id: 'wf-1', name: 'write_file', args: { Path: '/repo/test.ts', Content: 'ok' } }],
      },
      { step_index: 9, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Wrote /repo/test.ts' },
      { step_index: 10, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-sub-2\nPart 2 ready.' },
      { step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'All Option B work complete!' },
    ]);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h.messages).toContain('Writing test suite.');
    expect(h.messages[h.messages.length - 1]).toBe('All Option B work complete!');

    const countBeforeTurn2 = h.messages.length;
    await h.turn('TEXT you still working?');
    expect(h.done).toHaveBeenCalledTimes(2);
    expect(h.messages.slice(countBeforeTurn2)).toEqual(['Hello from Antigravity.']);
  });

  it('handles agy 1.5.11+ native out-of-turn ACP streaming without duplicate messages/tools or false 2.5s cancellations', async () => {
    const h = makeHarness({
      permissionMode: 'acceptEdits',
      env: {
        FAKE_ACP_SERVER_VERSION: '1.5.11',
        FAKE_ACP_OOT_CMD_MS: '140',
      },
      permission: async () => true,
      brainOptions: { pollIntervalMs: 15, wakeupGraceMs: 80, wakeupToolStallMs: 50 },
    });
    await h.session.start(h.options);

    h.session.send('SUBAGENT_BRAIN OUT_OF_TURN_1511');
    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    expect(h.received().some((m: any) => m.method === 'session/cancel')).toBe(false);
    expect(h.received().filter((m: any) => m.method === 'session/prompt')).toHaveLength(1);
    expect(h.permissionRequests).toContainEqual(expect.objectContaining({ tool: 'Antigravity: Bash' }));

    const bashTools = h.toolUses.filter((t) => t.name === 'Bash');
    expect(bashTools).toHaveLength(1);
    expect(bashTools[0].toolUseId).toBe('call_oot_merge_1');

    expect(h.messages.map((m) => m.trim()).filter(Boolean)).toEqual([
      'Waiting on Auth Researcher.',
      'CI is green — merging PR now.',
      'Release shipped cleanly!',
    ]);
    expect(h.thoughts).toContain('Merging verified PR after child report.');
  });

  it('drains slightly delayed final out-of-turn ACP message chunks and falls back cleanly if stdout omits them', async () => {
    const h1 = makeHarness({
      permissionMode: 'acceptEdits',
      env: {
        FAKE_ACP_SERVER_VERSION: '1.5.11',
        FAKE_ACP_OOT_CMD_MS: '20',
        FAKE_ACP_OOT_LATE_FINAL_CHUNK_MS: '45',
      },
      permission: async () => true,
      brainOptions: { pollIntervalMs: 15, wakeupGraceMs: 80, outOfTurnTextDrainMs: 250 },
    });
    await h1.session.start(h1.options);
    h1.session.send('SUBAGENT_BRAIN OUT_OF_TURN_1511');
    await vi.waitFor(() => expect(h1.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h1.messages.map((m) => m.trim()).filter(Boolean)).toEqual([
      'Waiting on Auth Researcher.',
      'CI is green — merging PR now.',
      'Release shipped cleanly!',
    ]);

    const h2 = makeHarness({
      permissionMode: 'acceptEdits',
      env: {
        FAKE_ACP_SERVER_VERSION: '1.5.11',
        FAKE_ACP_OOT_CMD_MS: '20',
        FAKE_ACP_OOT_LATE_FINAL_CHUNK_MS: '10',
        FAKE_ACP_OOT_OMIT_FINAL_CHUNK: '1',
      },
      permission: async () => true,
      brainOptions: { pollIntervalMs: 15, wakeupGraceMs: 80, outOfTurnTextDrainMs: 60 },
    });
    await h2.session.start(h2.options);
    h2.session.send('SUBAGENT_BRAIN OUT_OF_TURN_1511');
    await vi.waitFor(() => expect(h2.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h2.messages.map((m) => m.trim()).filter(Boolean)).toEqual([
      'Waiting on Auth Researcher.',
      'CI is green — merging PR now.',
      'Release shipped cleanly!',
    ]);
  });

  it('detects out-of-turn ACP support by semver and settles no-brain spontaneous out-of-turn wakeups cleanly', async () => {
    expect(antigravitySupportsOutOfTurnAcp(undefined)).toBe(false);
    expect(antigravitySupportsOutOfTurnAcp('invalid')).toBe(false);
    expect(antigravitySupportsOutOfTurnAcp('1.5.8')).toBe(false);
    expect(antigravitySupportsOutOfTurnAcp('1.5.9')).toBe(false);
    expect(antigravitySupportsOutOfTurnAcp('1.5.10')).toBe(false);
    expect(antigravitySupportsOutOfTurnAcp('1.5.11')).toBe(true);
    expect(antigravitySupportsOutOfTurnAcp('v1.5.12')).toBe(true);
    expect(antigravitySupportsOutOfTurnAcp('1.6.0')).toBe(true);
    expect(antigravitySupportsOutOfTurnAcp('2.0.0')).toBe(true);

    const h = makeHarness({
      brainOptions: { pollIntervalMs: 15, outOfTurnNoBrainIdleMs: 50 },
    });
    await h.session.start(h.options);
    await h.turn('TEXT initial');
    expect(h.done).toHaveBeenCalledTimes(1);
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;

    // Simulate spontaneous out-of-turn ACP updates when no local brain transcript file exists for `sessionId`.
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'nb-1', name: 'read_file', kind: 'read', status: 'in_progress' },
    });
    expect(h.session.turnInFlight).toBe(true);
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'nb-1', name: 'read_file', kind: 'read', status: 'completed' },
    });
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Spontaneous remote update.' } },
    });

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(h.session.turnInFlight).toBe(false);
    expect(h.messages[h.messages.length - 1]).toBe('Spontaneous remote update.');
  });

  it('streams spontaneous between-turn out-of-turn ACP wakeups live and settles with onDone instead of leaking or flooding', async () => {
    const h = makeHarness({
      env: {
        FAKE_ACP_SERVER_VERSION: '1.5.11',
        FAKE_ACP_SPONTANEOUS_DELAY_MS: '60',
      },
      brainOptions: { pollIntervalMs: 15, wakeupGraceMs: 60 },
    });
    await h.session.start(h.options);

    await h.turn('SPONTANEOUS_DAEMON_1511');
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(h.session.turnInFlight).toBe(false);
    expect(h.messages).toEqual(['Daemon schedule armed.']);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(h.session.turnInFlight).toBe(false);
    expect(h.messages.map((m) => m.trim())).toEqual([
      'Daemon schedule armed.',
      'Checking scheduled CI status.',
      'Scheduled check passed.',
    ]);
    expect(h.toolUses.filter((t) => t.toolUseId === 'call_daemon_check_1')).toHaveLength(1);

    await h.turn('TEXT follow up');
    expect(h.done).toHaveBeenCalledTimes(3);
    expect(h.messages[h.messages.length - 1]).toBe('Hello from Antigravity.');
    expect(h.messages).toHaveLength(4);
  });

  it('waits for multi-chunk out-of-turn agent_message_chunk frames across separate reads and ignores trailing whitespace chunks', async () => {
    const h = makeHarness({
      env: { FAKE_ACP_SERVER_VERSION: '1.5.11' },
      brainOptions: { pollIntervalMs: 15, wakeupGraceMs: 80, outOfTurnTextDrainMs: 250 },
    });
    await h.session.start(h.options);

    h.session.send('SUBAGENT_BRAIN multi-chunk-oot');
    await vi.waitFor(() => expect(h.tasksStarted).toContainEqual(expect.objectContaining({ taskId: 'child-sub-1' })), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;

    // Direction B + A: chunk 1 arrives, then PLANNER_RESPONSE(DONE) lands on disk, then chunk 2 arrives 35ms later, followed by a trailing "\n".
    h.appendBrain('child-sub-1', [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Audit complete.' },
    ]);
    h.appendBrain(sessionId, [
      { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-sub-1\nAudit complete.' },
    ]);
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '  Hello ' } },
    });
    h.appendBrain(sessionId, [
      { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Hello multi-chunk world.' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 35));
    // Must still be waiting for chunk 2 — NOT truncated at "Hello "!
    expect(h.done).not.toHaveBeenCalled();
    expect(h.session.turnInFlight).toBe(true);

    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'multi-chunk world.' } },
    });

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h.messages[h.messages.length - 1].trim()).toBe('Hello multi-chunk world.');

    // Trailing whitespace chunk after completion must NOT open a zombie wakeup turn!
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n' } },
    });
    expect(h.session.turnInFlight).toBe(false);
  });

  it('keeps consecutive out-of-turn wakeups segmented while sibling subagents remain active, and refreshes grace after child send_message wrap-up', async () => {
    const h = makeHarness({
      env: { FAKE_ACP_SERVER_VERSION: '1.5.11' },
      brainOptions: { pollIntervalMs: 15, wakeupGraceMs: 60, outOfTurnTextDrainMs: 200 },
    });
    await h.session.start(h.options);

    h.session.send('SUBAGENT_BRAIN consecutive-oot');
    await vi.waitFor(() => expect(h.tasksStarted).toContainEqual(expect.objectContaining({ taskId: 'child-sub-1' })), { timeout: 10_000 });
    const sessionId = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const subHeader = 'Created the ' + 'following subagent:';

    // Wakeup 1 spawns `child-sub-2` and finishes its own DONE step while `child-sub-2` is still running; its final text arrives 25ms after DONE.
    h.appendBrain('child-sub-1', [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Sub 1 done.' },
    ]);
    h.appendBrain(sessionId, [
      { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-sub-1\nSub 1 done.' },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Second Worker', TypeName: 'research' } }],
      },
      { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `${subHeader}\n{\n  "conversationId": "child-sub-2"\n}` },
      { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Wakeup 1 summary.' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wakeup 1 summary.' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.done).not.toHaveBeenCalled();

    // `child-sub-2` sends a message, then spends > wakeupGraceMs (90ms > 60ms) finishing its own DONE step before parent receives `<SYSTEM_MESSAGE>`.
    h.appendBrain('child-sub-2', [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ name: 'send_message', args: { Recipient: sessionId, Message: 'Sub 2 report' } }],
      },
      { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Sent' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 90));
    h.appendBrain('child-sub-2', [
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Wrapped up.' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Must still be holding the turn open during refreshed `wakeupGraceMs` after `child-sub-2` hit DONE!
    expect(h.done).not.toHaveBeenCalled();

    // Wakeup 2 starts with thought + write_file (without `kind: 'edit'`) + final message.
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reviewing second worker output.' } },
    });
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'wf-oot-2', name: 'write_file', args: { Path: '/repo/OUT.md', Content: 'ok' }, status: 'in_progress' },
    });
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'wf-oot-2', name: 'write_file', args: { Path: '/repo/OUT.md', Content: 'ok' }, status: 'completed' },
    });
    h.session.handleSessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wakeup 2 summary.' } },
    });
    h.appendBrain(sessionId, [
      { step_index: 8, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-sub-2\nSub 2 report' },
      { step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '', tool_calls: [{ name: 'write_file', args: { Path: '/repo/OUT.md' } }] },
      { step_index: 10, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Wrote' },
      { step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Wakeup 2 summary.' },
    ]);

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    // Wakeup 1 and Wakeup 2 messages must be distinct (never concatenated!), thoughts captured, and edited path emitted!
    expect(h.messages.map((m) => m.trim()).filter(Boolean)).toEqual([
      'Waiting on Auth Researcher.',
      'Wakeup 1 summary.',
      'Wakeup 2 summary.',
    ]);
    expect(h.thoughts).toContain('Reviewing second worker output.');
    expect(h.filesEdited).toContainEqual(['/repo/OUT.md']);
  });

  it('settles unfinished announced tools on post-ACP interrupt, snapshots baseline on session/load, and reports queuedTurnCount on onDone', async () => {
    // Pre-populate historical brain steps for `saved-oot-1` BEFORE session/load so a spontaneous wakeup before Turn 1 never replays history.
    const brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-brain-resume-'));
    cleanup.push(() => fs.rmSync(brainRoot, { recursive: true, force: true }));
    const histDir = path.join(brainRoot, 'saved-oot-1', '.system_generated', 'logs');
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, 'transcript_full.jsonl'), [
      JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Old historical reply.' }),
    ].join('\n') + '\n');

    const h = makeHarness({
      resume: 'saved-oot-1',
      env: { FAKE_ACP_KNOWN_SESSIONS: 'saved-oot-1', FAKE_ACP_SERVER_VERSION: '1.5.11' },
      brainOptions: { brainDir: brainRoot, pollIntervalMs: 15, outOfTurnNoBrainIdleMs: 50, wakeupGraceMs: 80 },
    });
    await h.session.start(h.options);

    // Spontaneous out-of-turn tool starts before any user `send()`, then user interrupts mid-tool!
    h.session.handleSessionUpdate({
      sessionId: 'saved-oot-1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'hang-oot-1', name: 'run_command', kind: 'execute', status: 'in_progress' },
    });
    expect(h.session.turnInFlight).toBe(true);
    expect(h.messages).not.toContain('Old historical reply.');

    await h.session.interrupt();
    expect(h.events).toContain('interrupted');
    expect(h.toolResults).toContainEqual(['hang-oot-1', 'error']);

    // Subsequent spontaneous wakeup + queued user send reports `queuedTurnCount` and `userMessageUuid` cleanly without poisoning!
    fs.unlinkSync(path.join(histDir, 'transcript_full.jsonl'));
    h.session.handleSessionUpdate({
      sessionId: 'saved-oot-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fresh spontaneous note.' } },
    });
    expect(h.session.turnInFlight).toBe(true);
    h.session.send('TEXT queued user turn', undefined, 'user-uuid-42');

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(h.done.mock.calls[0][3]).toEqual({ queuedTurnCount: 1 });
    expect(h.done.mock.calls[1][3]).toEqual({ userMessageUuid: 'user-uuid-42' });
    expect(h.messages).toEqual(['Fresh spontaneous note.', 'Hello from Antigravity.']);
  });

  it('preserves FIFO wakeup boundaries when pendingOutOfTurnFinalTexts overlaps a new wakeup chunk/tool or trailing newline', async () => {
    const h = makeHarness({
      env: { FAKE_ACP_SERVER_VERSION: '1.5.11' },
      brainOptions: { pollIntervalMs: 15, wakeupGraceMs: 250, outOfTurnTextDrainMs: 300 },
    });
    await h.session.start(h.options);
    h.session.send('SUBAGENT_BRAIN fifo-oot');
    await vi.waitFor(() => expect(h.tasksStarted).toContainEqual(expect.objectContaining({ taskId: 'child-sub-1' })), { timeout: 10_000 });
    const sid = (h.received().find((m: any) => m.method === 'session/prompt') as any).params.sessionId;
    const subHeader = 'Created the ' + 'following subagent:';

    // Wakeup 1 spawns `sub-q2` and finishes on disk WITHOUT emitting its stdout chunk (`pendingOutOfTurnFinalTexts = ['Wakeup 1 omitted.']`),
    // followed by a stray whitespace-only chunk (`\n`).
    h.appendBrain('child-sub-1', [{ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Q1 done.' }]);
    h.appendBrain('sub-q2', [{ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'IN_PROGRESS', thinking: 'Q2 working' }]);
    h.appendBrain(sid, [
      { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=child-sub-1\nQ1 done.' },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Q2', Prompt: 'two' } }],
      },
      { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: `${subHeader}\n{\n  "conversationId": "sub-q2"\n}` },
      { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Wakeup 1 omitted.' },
    ]);
    await new Promise((r) => setTimeout(r, 40));
    h.session.handleSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n' } },
    });

    // Wakeup 2 starts BEFORE the 300ms drain expires with a thought + longer incompatible `agent_message_chunk`,
    // AND Wakeup 3 (led by a tool_call before drain) also lands rapidly on disk while Wakeup 2 is only half-streamed!
    h.session.handleSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Synthesizing Q2**\nChecking Q2.' } },
    });
    h.session.handleSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wakeup 2 longer first ' } },
    });
    h.appendBrain('sub-q2', [{ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Q2 done.' }]);
    h.appendBrain(sid, [
      { step_index: 8, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=sub-q2\nQ2 done.' },
      { step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Wakeup 2 longer first half and second half.' },
      { step_index: 10, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=timer-1\nTimer.' },
      { step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Short 3.' },
    ]);
    await new Promise((r) => setTimeout(r, 40));

    // Deliver the rest of Wakeup 2, then Wakeup 3!
    h.session.handleSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half and second half.' } },
    });
    h.session.handleSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Short 3.' } },
    });

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(h.thoughts).toContain('Checking Q2.');
    expect(h.messages.map((m) => m.trim()).filter(Boolean)).toEqual([
      'Waiting on Auth Researcher.',
      'Wakeup 1 omitted.',
      'Wakeup 2 longer first half and second half.',
      'Short 3.',
    ]);
  });

  it('settles announced tools on session/prompt RPC error and refreshes unconfirmed wakeup deadline across active chunks', async () => {
    const h = makeHarness({
      env: { FAKE_ACP_SERVER_VERSION: '1.5.11' },
      brainOptions: { pollIntervalMs: 15, wakeupGraceMs: 60 },
    });
    await h.session.start(h.options);
    const sid = 'fake-session-1';

    // Turn 1 rejects with a JSON-RPC error mid-tool; `rpc-err-tool-1` MUST settle as `'error'` so `allAnnouncedToolsSettled()` stays clean.
    await h.turn('PROMPT_RPC_ERROR_WITH_TOOL');
    expect(h.events).toEqual(['error']);
    expect(h.toolResults).toContainEqual(['rpc-err-tool-1', 'error']);

    h.appendBrain(sid, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'init' },
    ]);

    // Now simulate an unconfirmed out-of-turn wakeup (transcript exists on disk, but no new steps arrive) that streams
    // across 3 x 35ms = 105ms (> 60ms `wakeupGraceMs`): active chunks must keep it alive until streaming goes idle!
    h.session.handleSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Chunk A ' } },
    });
    await new Promise((r) => setTimeout(r, 35));
    expect(h.session.turnInFlight).toBe(true);
    h.session.handleSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Chunk B ' } },
    });
    await new Promise((r) => setTimeout(r, 35));
    expect(h.session.turnInFlight).toBe(true);
    h.session.handleSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Chunk C.' } },
    });

    await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(h.messages).toEqual(['Chunk A Chunk B Chunk C.']);
  });
});
