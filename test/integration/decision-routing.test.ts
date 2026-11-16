/**
 * Answering a decision is delivered to the POSTING orchestrator thread as a user
 * message and never reaches the subject thread's session or system prompt.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    turnInFlight = false;
    async start(): Promise<void> {}
    send(): void { this.turnInFlight = true; }
    async interrupt(): Promise<void> {}
    async setModel(): Promise<void> {}
    async setPermissionMode(): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

const OPTIONS = [{ label: 'Ship', description: '' }, { label: 'Hold', description: '' }];

function setup() {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const orchestrator = manager.createThread('Orchestrator', '/tmp');
  const subject = manager.createThread('Subject', '/tmp');
  const send = vi.spyOn(manager, 'sendMessage').mockResolvedValue(undefined);
  const events: Array<[string, ThreadEvent['type']]> = [];
  manager.subscribe((id, e) => { if (e.type === 'pending_decisions_changed') events.push([id, e.type]); });
  return { manager, orchestrator, subject, send, events };
}

describe('decision answer routing', () => {
  it('posts on the subject, persists on the thread object, and notifies', () => {
    const { manager, orchestrator, subject, events } = setup();
    const d = manager.postDecision(subject.id, orchestrator.id, { question: 'Ship?', options: OPTIONS });
    expect(manager.getThread(subject.id)!.pendingDecisions).toEqual([d]);
    // Survives a JSON round trip (persistence is the whole thread object).
    expect(JSON.parse(JSON.stringify(manager.getThread(subject.id))).pendingDecisions[0].sourceThreadId).toBe(orchestrator.id);
    expect(events).toEqual([[subject.id, 'pending_decisions_changed']]);
  });

  it('delivers the answer to the orchestrator thread only, then clears the decision', async () => {
    const { manager, orchestrator, subject, send, events } = setup();
    const d = manager.postDecision(subject.id, orchestrator.id, { question: 'Ship?', header: 'Release', options: OPTIONS });
    await manager.answerDecision(subject.id, d.id, 'Ship');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(orchestrator.id);
    expect(send.mock.calls[0][1]).toContain('Ship');
    expect(send.mock.calls[0][1]).toContain(d.id);
    expect(send.mock.calls.some(([id]) => id === subject.id)).toBe(false);
    expect(manager.getThread(subject.id)!.pendingDecisions).toBeUndefined();
    expect(events.at(-1)).toEqual([subject.id, 'pending_decisions_changed']);
  });

  it('keeps the decision pending when the orchestrator is gone (answer not silently lost)', async () => {
    const { manager, orchestrator, subject, send } = setup();
    const d = manager.postDecision(subject.id, orchestrator.id, { question: 'Ship?', options: OPTIONS });
    manager.deleteThread(orchestrator.id);
    await expect(manager.answerDecision(subject.id, d.id, 'Ship')).rejects.toThrow(/no longer exists/);
    expect(send).not.toHaveBeenCalled();
    expect(manager.getThread(subject.id)!.pendingDecisions).toHaveLength(1);
  });

  it('enforces authorship on clear and ignores unknown ids', () => {
    const { manager, orchestrator, subject } = setup();
    const other = manager.createThread('Other orchestrator', '/tmp');
    const d = manager.postDecision(subject.id, orchestrator.id, { question: 'Ship?', options: OPTIONS });
    expect(() => manager.clearDecision(subject.id, other.id, d.id)).toThrow(/another orchestrator/);
    expect(manager.clearDecision(subject.id, orchestrator.id, 'nope')).toBe(false);
    expect(manager.clearDecision(subject.id, orchestrator.id, d.id)).toBe(true);
  });

  it('answering an already-cleared decision is a no-op', async () => {
    const { manager, orchestrator, subject, send } = setup();
    const d = manager.postDecision(subject.id, orchestrator.id, { question: 'Ship?', options: OPTIONS });
    manager.clearDecision(subject.id, orchestrator.id, d.id);
    await manager.answerDecision(subject.id, d.id, 'Ship');
    expect(send).not.toHaveBeenCalled();
  });

  it('dismissDecisions clears all pending decisions and emits pending_decisions_changed only when non-empty', () => {
    const { manager, orchestrator, subject, events } = setup();
    const other = manager.createThread('Second orchestrator', '/tmp');

    expect(manager.dismissDecisions('unknown-thread')).toBe(false);
    expect(manager.dismissDecisions(subject.id)).toBe(false);
    expect(events).toEqual([]);

    manager.postDecision(subject.id, orchestrator.id, { question: 'Ship?', options: OPTIONS });
    manager.postDecision(subject.id, other.id, { question: 'Target env?', options: OPTIONS });
    events.length = 0;

    expect(manager.dismissDecisions(subject.id)).toBe(true);
    expect(manager.getThread(subject.id)!.pendingDecisions).toBeUndefined();
    expect(events).toEqual([[subject.id, 'pending_decisions_changed']]);

    events.length = 0;
    expect(manager.dismissDecisions(subject.id)).toBe(false);
    expect(events).toEqual([]);
  });

  it('automated sendMessage and answerDecision do NOT clear pending decisions on target or orchestrator threads', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const orchestrator = manager.createThread('Orchestrator', '/tmp');
    const worker = manager.createThread('Worker', '/tmp');
    const subject = manager.createThread('Subject', '/tmp');

    const orchDecision = manager.postDecision(orchestrator.id, orchestrator.id, { question: 'Portfolio priority?', options: OPTIONS });
    const subjectDecision = manager.postDecision(subject.id, orchestrator.id, { question: 'Keep feature flag?', options: OPTIONS });
    const workerDecision = manager.postDecision(worker.id, orchestrator.id, { question: 'Ship worker PR?', options: OPTIONS });

    // Direct/automated ThreadManager.sendMessage on `subject` must preserve its pending decisions.
    await manager.sendMessage(subject.id, 'Automated heartbeat check');
    expect(manager.getThread(subject.id)!.pendingDecisions).toEqual([subjectDecision]);

    // Answering `worker`'s decision sends a user message to `orchestrator` via sendMessage;
    // `orchestrator`'s own pending decision (and `subject`'s) must remain untouched.
    await manager.answerDecision(worker.id, workerDecision.id, 'Ship');
    expect(manager.getThread(worker.id)!.pendingDecisions).toBeUndefined();
    expect(manager.getThread(orchestrator.id)!.pendingDecisions).toEqual([orchDecision]);
    expect(manager.getThread(subject.id)!.pendingDecisions).toEqual([subjectDecision]);
  });
});

describe('subject thread context isolation', () => {
  it('never feeds pendingDecisions, proposedReply or managerNotes into the appended system prompt', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../src/ThreadManager.ts', import.meta.url), 'utf8');
    const start = src.indexOf('const projectDesc = project?.description');
    const end = src.indexOf('const appendSystemPrompt = composeAppendSystemPrompt(');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const stmtEnd = src.indexOf(';', end);
    // From the context inputs through the compose call, orchestrator bookkeeping must only appear in the explanatory comment.
    const code = src.slice(start, stmtEnd).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/pendingDecisions|proposedReply|managerNotes/);
  });
});
