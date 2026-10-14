import { describe, expect, it, vi } from 'vitest';
import {
  ReplaySession,
  parseReplayScript,
  selectTurn,
  validateReplayScript,
  type ReplayScript,
} from '../../src/ReplaySession';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import type { SessionCallbacks } from '../../src/ClaudeSession';

const instant = () => Promise.resolve();

function makeCallbacks(overrides: Partial<SessionCallbacks> = {}) {
  const log: string[] = [];
  const callbacks = {
    onToken: (t: string) => log.push(`token:${t}`),
    onToolUse: (r: { name: string; summary: string }) => log.push(`tool_use:${r.name}:${r.summary}`),
    onMessage: (c: string, calls: unknown[]) => log.push(`message:${c}:${calls.length}`),
    onRecap: vi.fn(),
    onDone: () => log.push('done'),
    onInterrupted: () => log.push('interrupted'),
    onError: (e: Error) => log.push(`error:${e.message}`),
    onPermissionRequest: vi.fn(async () => true),
    onAskUserQuestion: vi.fn(async () => ({})),
    onOpenNewTab: vi.fn(async () => ({ threadId: '', title: '' })),
    onToolResult: (_id: string, status: string) => log.push(`tool_result:${status}`),
    onTaskStarted: (id: string) => log.push(`task_started:${id}`),
    onTaskProgress: (id: string, d: string) => log.push(`task_progress:${id}:${d}`),
    onTaskNotification: (id: string, s: string) => log.push(`task_done:${id}:${s}`),
    onTaskEvent: (e: { kind: string }) => log.push(`task_event:${e.kind}`),
    onFilesEdited: (p: string[]) => log.push(`files:${p.join(',')}`),
    onActiveModel: (m: string) => log.push(`model:${m}`),
    onCommandsChanged: (c: { name: string }[]) => log.push(`commands:${c.map((x) => x.name).join(',')}`),
    ...overrides,
  } as unknown as SessionCallbacks;
  return { callbacks, log };
}

async function run(script: ReplayScript, prompt: string, callbacks: SessionCallbacks, sleep = instant) {
  const session = new ReplaySession(script, { sleep });
  await session.start({ cwd: '/vault', callbacks } as unknown as HarnessSessionOptions);
  session.send(prompt);
  return session;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await settle();
  expect(predicate()).toBe(true);
}

describe('validateReplayScript', () => {
  it('accepts a minimal script', () => {
    expect(validateReplayScript({ version: 1, turns: [] })).toEqual([]);
  });

  it('collects every problem', () => {
    const errors = validateReplayScript({
      version: 2,
      turns: [{ match: '(', steps: [{ type: 'nope' }] }, { steps: [{ type: 'pause' }] }],
    });
    expect(errors).toEqual(expect.arrayContaining([
      'version: must be 1',
      'turns[0].match: invalid regular expression',
      'turns[0].steps[0]: unknown step type "nope"',
      'turns[1].steps[0]: pause needs ms >= 0',
    ]));
  });

  it('throws from parseReplayScript with the same messages', () => {
    expect(() => parseReplayScript({ version: 1, turns: 'x' })).toThrow(/turns: must be an array/);
  });
});

describe('selectTurn', () => {
  const script: ReplayScript = {
    version: 1,
    turns: [
      { match: 'fix the bug', steps: [{ type: 'pause', ms: 1 }] },
      { steps: [{ type: 'pause', ms: 2 }] },
    ],
    fallback: [{ type: 'pause', ms: 3 }],
  };

  it('matches case-insensitively, first match wins', () => {
    expect(selectTurn(script, 'Please FIX THE BUG now')).toEqual([{ type: 'pause', ms: 1 }]);
  });

  it('treats a turn without match as a catch-all', () => {
    expect(selectTurn(script, 'anything')).toEqual([{ type: 'pause', ms: 2 }]);
  });

  it('uses the fallback when no turn matches', () => {
    expect(selectTurn({ ...script, turns: [script.turns[0]] }, 'zzz')).toEqual([{ type: 'pause', ms: 3 }]);
  });
});

describe('ReplaySession', () => {
  it('replays a message with a tool in the same order as a real session', async () => {
    const { callbacks, log } = makeCallbacks();
    await run({
      version: 1,
      model: 'claude-sonnet-4-5',
      pacing: { chunkChars: 3 },
      turns: [{ steps: [{ type: 'message', text: 'Hello there', tools: [{ name: 'Read', input: { file_path: 'a.md' }, filesEdited: ['a.md'] }] }] }],
    }, 'hi', callbacks);
    await until(() => log.includes('done'));
    expect(log).toEqual([
      'model:claude-sonnet-4-5',
      'token:Hel', 'token:lo ', 'token:the', 'token:re',
      'tool_use:Read:a.md',
      'message:Hello there:1',
      'tool_result:success',
      'files:a.md',
      'done',
    ]);
  });

  it('reports scripted slash commands when the session starts', async () => {
    const { callbacks, log } = makeCallbacks();
    await run({ version: 1, commands: [{ name: 'review', description: 'Review a PR' }], turns: [] }, 'x', callbacks);
    expect(log).toContain('commands:review');
  });

  it('reports turnInFlight only while a turn runs', async () => {
    const { callbacks, log } = makeCallbacks();
    const session = await run({ version: 1, turns: [{ steps: [{ type: 'message', text: 'x' }] }] }, 'go', callbacks);
    expect(session.turnInFlight).toBe(true);
    await until(() => log.includes('done'));
    expect(session.turnInFlight).toBe(false);
  });

  it('asks permission, then runs the tool when allowed', async () => {
    const onPermissionRequest = vi.fn(async () => true);
    const { callbacks, log } = makeCallbacks({ onPermissionRequest });
    await run({
      version: 1,
      turns: [{ steps: [{ type: 'message', tools: [{ name: 'Write', input: { file_path: 'n.md' }, permission: {} }] }] }],
    }, 'write', callbacks);
    await until(() => log.includes('done'));
    expect(onPermissionRequest).toHaveBeenCalledWith('Write', '{"file_path":"n.md"}');
    expect(log).toContain('tool_result:success');
  });

  it('marks the tool failed and replays ifDenied when the user denies', async () => {
    const { callbacks, log } = makeCallbacks({ onPermissionRequest: vi.fn(async () => false) });
    await run({
      version: 1,
      pacing: { chunkChars: 100 },
      turns: [{
        steps: [{
          type: 'message',
          tools: [{ name: 'Write', permission: { ifDenied: [{ type: 'message', text: 'Okay, skipping.' }] } }],
        }],
      }],
    }, 'write', callbacks);
    await until(() => log.includes('done'));
    expect(log).toContain('tool_result:error');
    expect(log).toContain('token:Okay, skipping.');
  });

  it('keeps hasPendingPermission true while the card is open', async () => {
    let answer!: (allowed: boolean) => void;
    const { callbacks, log } = makeCallbacks({ onPermissionRequest: () => new Promise<boolean>((r) => (answer = r)) });
    const session = await run({
      version: 1,
      turns: [{ steps: [{ type: 'message', tools: [{ name: 'Write', permission: {} }] }] }],
    }, 'write', callbacks);
    await until(() => session.hasPendingPermission);
    expect(session.canIdleReap()).toBe(false);
    answer(true);
    await until(() => log.includes('done'));
    expect(session.hasPendingPermission).toBe(false);
  });

  it('replays a sub-agent lifecycle', async () => {
    const { callbacks, log } = makeCallbacks();
    await run({
      version: 1,
      turns: [{
        steps: [{
          type: 'message',
          tools: [{
            name: 'Agent',
            input: { description: 'Scan notes' },
            agent: { taskId: 'a1', description: 'Scan notes', subagentType: 'Explore', progress: [{ afterMs: 5, description: 'Reading', lastToolName: 'Read' }] },
          }],
        }],
      }],
    }, 'delegate', callbacks);
    await until(() => log.includes('done'));
    const started = log.indexOf('task_started:a1');
    expect(started).toBeGreaterThan(-1);
    expect(log.slice(started)).toEqual(['task_started:a1', 'task_progress:a1:Reading', 'task_done:a1:completed', 'tool_result:success', 'done']);
  });

  it('reports task-list events when the tool is issued', async () => {
    const { callbacks, log } = makeCallbacks();
    await run({
      version: 1,
      turns: [{ steps: [{ type: 'message', tools: [{ name: 'TaskCreate', taskEvent: { kind: 'create', id: '1', content: 'Plan' } }] }] }],
    }, 'tasks', callbacks);
    await until(() => log.includes('done'));
    expect(log.indexOf('task_event:create')).toBeLessThan(log.indexOf('message::1'));
  });

  it('interrupt stops a held turn and reports onInterrupted, not onDone', async () => {
    const { callbacks, log } = makeCallbacks();
    const session = await run({ version: 1, turns: [{ steps: [{ type: 'hold' }] }] }, 'wait', callbacks);
    await settle();
    expect(session.turnInFlight).toBe(true);
    await session.interrupt();
    await until(() => log.includes('interrupted'));
    expect(log).not.toContain('done');
    expect(session.turnInFlight).toBe(false);
  });

  it('close stops the turn silently', async () => {
    const { callbacks, log } = makeCallbacks();
    const session = await run({ version: 1, turns: [{ steps: [{ type: 'hold' }] }] }, 'wait', callbacks);
    await settle();
    session.close();
    await settle();
    await settle();
    expect(log).toEqual([]);
    expect(session.turnInFlight).toBe(false);
  });

  it('runs a second turn on the same session', async () => {
    const { callbacks, log } = makeCallbacks();
    const session = await run({ version: 1, pacing: { chunkChars: 50 }, turns: [{ match: 'one', steps: [{ type: 'message', text: 'first' }] }, { match: 'two', steps: [{ type: 'message', text: 'second' }] }] }, 'one', callbacks);
    await until(() => log.filter((l) => l === 'done').length === 1);
    session.send('two');
    await until(() => log.filter((l) => l === 'done').length === 2);
    expect(log).toContain('token:first');
    expect(log).toContain('token:second');
  });

  it('requires start() before send()', () => {
    const session = new ReplaySession({ version: 1, turns: [] });
    expect(() => session.send('x')).toThrow(/before start/);
  });
});
