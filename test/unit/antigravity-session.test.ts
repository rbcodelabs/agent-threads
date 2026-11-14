import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AntigravitySession,
  antigravityContextUsage,
  antigravityDiffDetail,
  antigravityEditedPaths,
  antigravityMcpServers,
  antigravityModeForPermission,
  antigravityModels,
  antigravityPermissionDetail,
  antigravityToolName,
  antigravityToolSummary,
  antigravityTurnTokens,
  resolveAntigravityPermission,
} from '../../src/AntigravitySession';
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
  });

  it('summarises a shell call by its command and an edit by its file', () => {
    expect(antigravityToolSummary(shell)).toBe(shell.rawInput.CommandLine);
    expect(antigravityToolSummary(write)).toBe('/work/project/hello.txt');
    expect(antigravityToolSummary({ title: 'Browse', kind: 'other' })).toBe('Browse');
    expect(antigravityToolSummary({ name: 'mcp_agent-threads_host_echo', kind: 'other', title: 'Run mcp_agent-threads_host_echo', rawInput: { text: 'x', toolSummary: 'Echo text via MCP tool' } })).toBe('Echo text via MCP tool');
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

  it('collects edited paths from diffs, falling back to locations', () => {
    expect(antigravityEditedPaths({ content: [{ type: 'diff', path: '/a', newText: '' }], locations: [{ path: '/b' }] })).toEqual(['/a']);
    expect(antigravityEditedPaths({ locations: [{ path: '/b' }] })).toEqual(['/b']);
    expect(antigravityEditedPaths({})).toEqual([]);
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

function fakeLauncher(): AcpLauncher {
  return (options) => spawnAcpChannel({ ...options, binaryPath: process.execPath, args: [AGENT] });
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(over: Partial<HarnessSessionOptions> & { env?: Record<string, string>; permission?: (tool: string, detail: string) => Promise<boolean>; startTimeoutMs?: number; binary?: string; launcher?: AcpLauncher } = {}) {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fake-')), 'log.jsonl');
  cleanup.push(() => fs.rmSync(path.dirname(logFile), { recursive: true, force: true }));
  const events: string[] = [];
  const tokens: string[] = [];
  const messages: string[] = [];
  const messageTools: string[][] = [];
  const toolUses: any[] = [];
  const toolResults: Array<[string, string]> = [];
  const filesEdited: string[][] = [];
  const permissionRequests: Array<{ tool: string; detail: string }> = [];
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
    onEnterPlanMode: vi.fn(),
    onCapabilitiesDiscovered: vi.fn(),
    onUsage: vi.fn(),
    onCommandsChanged: vi.fn(),
    onRawEvent: vi.fn(),
    onNotification: vi.fn(),
  } as unknown as SessionCallbacks;
  const env = { FAKE_ACP_LOG: logFile, ...(over.env ?? {}) };
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
  const session = new AntigravitySession(over.binary ?? 'agy', over.launcher ?? fakeLauncher(), over.startTimeoutMs ?? 15_000);
  cleanup.push(() => session.close());
  const received = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const turn = async (text: string) => {
    const before = events.length;
    session.send(text);
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before), { timeout: 10_000 });
  };
  return { session, options, callbacks, events, tokens, messages, messageTools, toolUses, toolResults, filesEdited, permissionRequests, done, errors, received, turn };
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
