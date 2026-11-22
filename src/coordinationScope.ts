export type CoordinationRole =
  | { kind: 'portfolio' }
  | { kind: 'project-orchestrator'; projectId: string }
  | { kind: 'project-member'; projectId: string }
  | { kind: 'unassigned' };

export interface OrchestratedProjectRef {
  id: string;
  name?: string;
  orchestratorThreadId?: string;
  orchestratorEnabled?: boolean;
}

export function resolveCoordinationRole(
  callerThreadId: string,
  portfolioOrchestratorThreadId: string | undefined,
  callerProjectId: string | undefined,
  projects: OrchestratedProjectRef[],
): CoordinationRole {
  if (callerThreadId === portfolioOrchestratorThreadId) return { kind: 'portfolio' };
  if (!callerProjectId) return { kind: 'unassigned' };
  const project = projects.find(candidate => candidate.id === callerProjectId);
  if (project?.orchestratorThreadId === callerThreadId) {
    return { kind: 'project-orchestrator', projectId: callerProjectId };
  }
  return { kind: 'project-member', projectId: callerProjectId };
}

export function authorizeThreadAccess(
  caller: CoordinationRole,
  targetProjectId: string | undefined,
  elevatedProjectId?: string,
): boolean {
  if (caller.kind === 'portfolio') {
    return targetProjectId === undefined || targetProjectId === elevatedProjectId;
  }
  if (caller.kind === 'unassigned') return targetProjectId === undefined;
  return targetProjectId === caller.projectId;
}

/**
 * Authorizes the destination Project of a reassignment, which is a narrower question
 * than `authorizeThreadAccess` answers on its own.
 *
 * A thread with no Project is otherwise stranded: `authorizeThreadAccess` denies every
 * non-undefined destination for the `unassigned` role, `elevatedProjectId` is
 * portfolio-only, and the portfolio orchestrator cannot reach a projectId-bearing thread
 * either — so nothing can move an unassigned thread into a Project. Self-assignment is
 * not a cross-project read: the caller *is* the target, so it discloses nothing.
 *
 * Deliberately not extended to `project-member`/`project-orchestrator`: letting those
 * move themselves to another Project would be a real scope hop (move to B, then read B's
 * threads), and the stranding bug does not require it.
 */
export function authorizeProjectAssignment(
  caller: CoordinationRole,
  targetProjectId: string | undefined,
  options: { isSelf: boolean; elevatedProjectId?: string },
): boolean {
  if (caller.kind === 'unassigned' && options.isSelf) return true;
  return authorizeThreadAccess(caller, targetProjectId, options.elevatedProjectId);
}

export const OUT_OF_SCOPE_MESSAGE = 'Target is outside coordination scope.';

/**
 * Explains why a Manager notes (or ledger) write is denied, or returns undefined when it
 * is allowed. The single source of truth for notes authorization: `canWriteManagerNotes`
 * is derived from it so the boolean outcome and the message can never drift apart.
 *
 * Disclosure rule: the owning orchestrator's thread id and the Project name are only
 * named when the caller already has matching elevation or belongs to that Project.
 * Everything else falls back to the generic out-of-scope message.
 */
export function explainManagerNotesDenial(
  caller: CoordinationRole,
  targetProjectId: string | undefined,
  elevatedProjectId?: string,
  projects?: readonly OrchestratedProjectRef[],
): string | undefined {
  if (caller.kind === 'portfolio') {
    if (targetProjectId === undefined) return undefined;
    if (targetProjectId !== elevatedProjectId) {
      return 'Manager notes for a Project thread require elevatedProjectId set to that Project, and are only writable while its orchestrator is disabled. '
        + 'Otherwise message the Project orchestrator with threads_send_message.';
    }
    const project = projects?.find(candidate => candidate.id === targetProjectId);
    if (!project) return OUT_OF_SCOPE_MESSAGE;
    if (project.orchestratorEnabled === false) return undefined;
    const label = project.name ? `Project ${project.name}` : 'this Project';
    const owner = project.orchestratorThreadId ? ` (thread ${project.orchestratorThreadId})` : '';
    return `Manager notes for ${label} are owned by its enabled Project orchestrator${owner}. `
      + 'Message that orchestrator with threads_send_message instead, or disable it.';
  }
  if (caller.kind === 'project-orchestrator' && targetProjectId === caller.projectId) return undefined;
  if (caller.kind === 'project-member' && targetProjectId === caller.projectId) {
    return 'Only the Project orchestrator may write Manager notes for threads in this Project. Message the orchestrator with threads_send_message instead.';
  }
  return OUT_OF_SCOPE_MESSAGE;
}

export function canWriteManagerNotes(
  caller: CoordinationRole,
  targetProjectId: string | undefined,
  elevatedProjectId?: string,
  projects?: readonly OrchestratedProjectRef[],
): boolean {
  return explainManagerNotesDenial(caller, targetProjectId, elevatedProjectId, projects) === undefined;
}

export function assertProposalOwnership(
  existing: { sourceThreadId?: string } | undefined,
  callerThreadId: string,
): void {
  if (existing && existing.sourceThreadId !== callerThreadId) {
    throw new Error('A proposed reply from another orchestrator is already pending. Clear it first.');
  }
}

export function repairStaleProjectOrchestrators(
  projects: OrchestratedProjectRef[],
  threadProjectId: (threadId: string) => string | undefined,
  scheduledItems: Array<{ isOrchestratorHeartbeat?: boolean; targetThreadId?: string }>,
  portfolioOrchestratorThreadId?: string,
): boolean {
  let changed = false;
  for (const project of projects) {
    if (project.orchestratorEnabled === undefined) {
      project.orchestratorEnabled = true;
      changed = true;
    }
    if (project.orchestratorThreadId && threadProjectId(project.orchestratorThreadId) !== project.id) {
      project.orchestratorThreadId = undefined;
      changed = true;
    }
  }
  const validIds = new Set([portfolioOrchestratorThreadId, ...projects.map(project => project.orchestratorThreadId)].filter(Boolean));
  for (let index = scheduledItems.length - 1; index >= 0; index--) {
    const item = scheduledItems[index]!;
    if (item.isOrchestratorHeartbeat && item.targetThreadId && !validIds.has(item.targetThreadId)) {
      scheduledItems.splice(index, 1);
      changed = true;
    }
  }
  return changed;
}
