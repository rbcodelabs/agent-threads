import type { AgentHarness } from '../types';
import type { AgentRun, AgentRunEvent, AgentRunStatus } from '../types';

export interface AgentTreeNode { run: AgentRun; children: AgentTreeNode[] }
export interface AgentStartInput {
  threadId: string;
  harness: AgentHarness;
  nativeAgentId: string;
  parentNativeAgentId?: string;
  description: string;
  role?: string;
  model?: string;
  taskId?: string;
  sessionGeneration?: number;
}

const terminal = new Set<AgentRunStatus>(['completed', 'failed', 'interrupted']);

export class AgentRunStore {
  private runs = new Map<string, AgentRun>();
  private nativeIndex = new Map<string, string>();

  static isAgentTask(task: { skipTranscript: boolean; taskType?: string; subagentType?: string }): boolean {
    return task.taskType === 'subagent' || task.taskType === 'agent' || !!task.subagentType;
  }

  private nativeKey(threadId: string, harness: string, nativeId: string, sessionGeneration = 0): string {
    return `${threadId}\u0000${harness}\u0000${sessionGeneration}\u0000${nativeId}`;
  }

  observeStart(input: AgentStartInput, now = Date.now()): AgentRun {
    const key = this.nativeKey(input.threadId, input.harness, input.nativeAgentId, input.sessionGeneration);
    const existingId = this.nativeIndex.get(key);
    const existing = existingId ? this.runs.get(existingId) : undefined;
    if (existing) {
      Object.assign(existing, { description: input.description || existing.description, role: input.role ?? existing.role, model: input.model ?? existing.model, taskId: input.taskId ?? existing.taskId, status: terminal.has(existing.status) ? existing.status : 'working', updatedAt: now });
      this.resolveParents(input.threadId, input.harness, input.sessionGeneration ?? 0);
      return existing;
    }
    const parent = input.parentNativeAgentId ? this.getByNativeId(input.threadId, input.harness, input.parentNativeAgentId, input.sessionGeneration ?? 0) : undefined;
    const run: AgentRun = {
      id: crypto.randomUUID(), threadId: input.threadId, harness: input.harness,
      nativeAgentId: input.nativeAgentId, parentAgentRunId: parent?.id,
      sessionGeneration: input.sessionGeneration,
      parentNativeAgentId: input.parentNativeAgentId, taskId: input.taskId,
      description: input.description, role: input.role, model: input.model,
      status: 'working', startedAt: now, updatedAt: now,
      capabilities: { viewTranscript: true, sendMessage: false, interrupt: false },
      events: [{ kind: 'lifecycle', text: 'Agent started', timestamp: now, nativeEventId: `start:${input.nativeAgentId}` }],
    };
    this.runs.set(run.id, run);
    this.nativeIndex.set(key, run.id);
    this.resolveParents(input.threadId, input.harness, input.sessionGeneration ?? 0);
    return run;
  }

  observeActivity(threadId: string, harness: AgentHarness, nativeId: string, event: AgentRunEvent, sessionGeneration = 0): AgentRun | undefined {
    const run = this.getByNativeId(threadId, harness, nativeId, sessionGeneration);
    if (!run) return undefined;
    if (!event.nativeEventId || !run.events.some(e => e.nativeEventId === event.nativeEventId)) run.events.push(event);
    run.currentActivity = event.text;
    run.updatedAt = Math.max(run.updatedAt, event.timestamp);
    if (!terminal.has(run.status)) run.status = 'working';
    return run;
  }

  observeStatus(threadId: string, harness: AgentHarness, nativeId: string, status: AgentRunStatus, summary?: string, error?: string, now = Date.now(), sessionGeneration = 0): AgentRun | undefined {
    const run = this.getByNativeId(threadId, harness, nativeId, sessionGeneration);
    if (!run) return undefined;
    run.status = status; run.updatedAt = now; run.resultSummary = summary ?? run.resultSummary; run.error = error ?? run.error;
    if (terminal.has(status)) run.completedAt = now;
    const eventId = `status:${status}:${summary ?? error ?? ''}`;
    if (!run.events.some(e => e.nativeEventId === eventId)) run.events.push({ kind: status === 'failed' ? 'error' : 'lifecycle', text: summary ?? error ?? status, timestamp: now, nativeEventId: eventId });
    return run;
  }

  restore(threadId: string, snapshot: AgentRun[]): void {
    for (const source of snapshot) {
      const run = { ...source, events: [...source.events], capabilities: { ...source.capabilities } };
      if (!terminal.has(run.status)) run.status = 'unavailable';
      this.runs.set(run.id, run);
      this.nativeIndex.set(this.nativeKey(threadId, run.harness, run.nativeAgentId, run.sessionGeneration), run.id);
    }
    this.resolveParents(threadId);
  }

  snapshot(threadId: string): AgentRun[] { return this.getByThread(threadId).map(r => ({ ...r, capabilities: { ...r.capabilities }, events: r.events.map(e => ({ ...e })) })); }
  getById(id: string): AgentRun | undefined { return this.runs.get(id); }
  getByNativeId(threadId: string, harness: AgentHarness, nativeId: string, sessionGeneration = 0): AgentRun | undefined { const id = this.nativeIndex.get(this.nativeKey(threadId, harness, nativeId, sessionGeneration)); return id ? this.runs.get(id) : undefined; }
  getByThread(threadId: string): AgentRun[] { return [...this.runs.values()].filter(r => r.threadId === threadId).sort((a, b) => a.startedAt - b.startedAt); }

  getTree(threadId: string): AgentTreeNode[] {
    const nodes = new Map(this.getByThread(threadId).map(run => [run.id, { run, children: [] as AgentTreeNode[] }]));
    const roots: AgentTreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.run.parentAgentRunId ? nodes.get(node.run.parentAgentRunId) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  private resolveParents(threadId: string, harness?: AgentHarness, sessionGeneration?: number): void {
    for (const run of this.getByThread(threadId)) {
      if (harness && run.harness !== harness) continue;
      if (sessionGeneration !== undefined && (run.sessionGeneration ?? 0) !== sessionGeneration) continue;
      if (!run.parentAgentRunId && run.parentNativeAgentId) {
        run.parentAgentRunId = this.getByNativeId(threadId, run.harness, run.parentNativeAgentId, run.sessionGeneration ?? 0)?.id;
      }
    }
  }
}
