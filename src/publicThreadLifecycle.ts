import { buildArchivePlan, type ArchiveConfirm } from './archivePlan';
import { ClaudeThreadsApiError } from './PublicApi';
import type { OrchestratorContext } from './orchestratorThreads';

interface LifecycleThread { id: string; title: string; reviewed?: boolean; updatedAt: number; status?: string }
export interface PublicThreadLifecycleDependencies {
  getThreads(): LifecycleThread[];
  isRunning(id: string): boolean;
  getOrchestratorContext(): OrchestratorContext;
  confirm(spec: ArchiveConfirm): Promise<boolean>;
  cancelWakeups(id: string): Promise<void>;
  archiveThread(id: string, assertSafe: () => void): Promise<void>;
  saveSettings(): Promise<void>;
  notifyReviewed(id: string): void;
}

export function createPublicThreadLifecycle(deps: PublicThreadLifecycleDependencies) {
  // Serialize peer mutations across targets: two simultaneous archives must not
  // both pass the last-thread check before either removes its target.
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const liveThreads = () => deps.getThreads().filter(thread => thread.status !== 'archived');
  const requireThread = (id: string) => {
    const thread = liveThreads().find(candidate => candidate.id === id);
    if (!thread) throw new ClaudeThreadsApiError('THREAD_NOT_FOUND', 'Thread not found.');
    return thread;
  };
  const planArchive = (id: string) => {
    requireThread(id);
    const plan = buildArchivePlan([id], { threads: liveThreads(), isRunning: deps.isRunning, orchestrator: deps.getOrchestratorContext() });
    if (plan.blocked) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', plan.blockedMessage ?? 'Archive blocked.');
    return plan;
  };
  return {
    archive: (threadId: string, assertActive: () => void) => serialize(async () => {
      assertActive();
      let acceptedConfirmation: string | undefined;
      let acceptedRunning = false;
      let acceptedRoles = new Set<string>();
      const validate = async () => {
        while (true) {
          assertActive();
          const plan = planArchive(threadId);
          const confirmation = plan.confirm ? JSON.stringify(plan.confirm) : undefined;
          if (!confirmation || confirmation === acceptedConfirmation) return true;
          if (!(await deps.confirm(plan.confirm!))) { assertActive(); return false; }
          acceptedConfirmation = confirmation;
          acceptedRunning = plan.runningIds.length > 0;
          acceptedRoles = new Set(plan.orchestrators.map(entry => JSON.stringify(entry.role)));
          // Recompute after the dialog: target roles/running state and the
          // remaining-thread count can all change while the user decides.
        }
      };
      if (!(await validate())) return { status: 'cancelled' as const, threadId };
      await deps.cancelWakeups(threadId);
      const assertSafe = () => {
        assertActive();
        const plan = planArchive(threadId);
        if ((plan.runningIds.length > 0 && !acceptedRunning) || plan.orchestrators.some(entry => !acceptedRoles.has(JSON.stringify(entry.role)))) {
          throw new ClaudeThreadsApiError('THREAD_BUSY', 'Archive conditions changed; request archive again to confirm the current state.');
        }
      };
      assertSafe();
      await deps.archiveThread(threadId, assertSafe);
      await deps.saveSettings();
      return { status: 'archived' as const, threadId };
    }),
    markReviewed: (threadId: string, assertActive: () => void) => serialize(async () => {
      assertActive();
      const thread = requireThread(threadId);
      if (deps.isRunning(threadId)) throw new ClaudeThreadsApiError('THREAD_BUSY', 'Wait for the thread to finish before marking it reviewed.');
      if (thread.reviewed) return { threadId, reviewed: true as const, changed: false };
      const prior = thread.reviewed;
      const revision = thread.updatedAt;
      thread.reviewed = true;
      try {
        await deps.saveSettings();
      } catch (error) {
        if (thread.updatedAt === revision && thread.reviewed === true) thread.reviewed = prior;
        throw error;
      }
      // A new run can begin while settings are saved. Do not label its result
      // reviewed or claim success for a target removed during that wait.
      if (deps.isRunning(threadId) || !liveThreads().includes(thread) || thread.updatedAt !== revision || !thread.reviewed) {
        if (thread.updatedAt === revision && thread.reviewed === true) thread.reviewed = prior;
        await deps.saveSettings();
        throw new ClaudeThreadsApiError('THREAD_BUSY', 'Thread changed while saving review state; retry after it finishes.');
      }
      assertActive();
      deps.notifyReviewed(threadId);
      return { threadId, reviewed: true as const, changed: true };
    }),
  };
}
