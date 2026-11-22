import { describe, expect, it } from 'vitest';
import { assertProposalOwnership, authorizeProjectAssignment, authorizeThreadAccess, canWriteManagerNotes, explainManagerNotesDenial, OUT_OF_SCOPE_MESSAGE, repairStaleProjectOrchestrators, resolveCoordinationRole } from '../../src/coordinationScope';

const projects = [
  { id: 'project-a', orchestratorThreadId: 'orch-a' },
  { id: 'project-b', orchestratorThreadId: 'orch-b' },
];

describe('coordination scope', () => {
  it('resolves portfolio, project orchestrator, project member, and unassigned roles', () => {
    expect(resolveCoordinationRole('portfolio', 'portfolio', undefined, projects)).toEqual({ kind: 'portfolio' });
    expect(resolveCoordinationRole('orch-a', 'portfolio', 'project-a', projects)).toEqual({ kind: 'project-orchestrator', projectId: 'project-a' });
    expect(resolveCoordinationRole('worker-a', 'portfolio', 'project-a', projects)).toEqual({ kind: 'project-member', projectId: 'project-a' });
    expect(resolveCoordinationRole('loose', 'portfolio', undefined, projects)).toEqual({ kind: 'unassigned' });
  });

  it('allows project callers only within their own project', () => {
    const caller = { kind: 'project-orchestrator' as const, projectId: 'project-a' };
    expect(authorizeThreadAccess(caller, 'project-a')).toBe(true);
    expect(authorizeThreadAccess(caller, 'project-b')).toBe(false);
    expect(authorizeThreadAccess(caller, undefined)).toBe(false);
  });

  it('requires per-call elevation for portfolio cross-project access', () => {
    const caller = { kind: 'portfolio' as const };
    expect(authorizeThreadAccess(caller, undefined)).toBe(true);
    expect(authorizeThreadAccess(caller, 'project-a')).toBe(false);
    expect(authorizeThreadAccess(caller, 'project-a', 'project-a')).toBe(true);
    expect(authorizeThreadAccess(caller, 'project-a', 'project-b')).toBe(false);
  });

  it('keeps ordinary unassigned callers within unassigned threads', () => {
    const caller = { kind: 'unassigned' as const };
    expect(authorizeThreadAccess(caller, undefined)).toBe(true);
    expect(authorizeThreadAccess(caller, 'project-a')).toBe(false);
  });

  it('lets an unassigned thread place itself into any Project', () => {
    // Without this, a thread created outside a Project is stranded forever: no role can
    // move it in, so `threads_set_project` always answered "outside coordination scope".
    const caller = { kind: 'unassigned' as const };
    expect(authorizeProjectAssignment(caller, 'project-a', { isSelf: true })).toBe(true);
    expect(authorizeProjectAssignment(caller, 'project-b', { isSelf: true })).toBe(true);
  });

  it('still blocks an unassigned thread from moving a different thread into a Project', () => {
    const caller = { kind: 'unassigned' as const };
    expect(authorizeProjectAssignment(caller, 'project-a', { isSelf: false })).toBe(false);
  });

  it('lets an unassigned thread detach itself or another unassigned thread', () => {
    const caller = { kind: 'unassigned' as const };
    expect(authorizeProjectAssignment(caller, undefined, { isSelf: true })).toBe(true);
    expect(authorizeProjectAssignment(caller, undefined, { isSelf: false })).toBe(true);
  });

  it('refuses to let a Project thread hop itself into another Project', () => {
    // Self-assignment is only an escape hatch out of statelessness, not a scope hop:
    // moving to project-b would grant read access to every project-b thread.
    const member = { kind: 'project-member' as const, projectId: 'project-a' };
    const orchestrator = { kind: 'project-orchestrator' as const, projectId: 'project-a' };
    expect(authorizeProjectAssignment(member, 'project-b', { isSelf: true })).toBe(false);
    expect(authorizeProjectAssignment(orchestrator, 'project-b', { isSelf: true })).toBe(false);
    // Staying put, and detaching, keep their existing authorizeThreadAccess answers.
    expect(authorizeProjectAssignment(member, 'project-a', { isSelf: true })).toBe(true);
    expect(authorizeProjectAssignment(member, undefined, { isSelf: true })).toBe(false);
  });

  it('still requires matching elevation for a portfolio caller assigning itself', () => {
    const caller = { kind: 'portfolio' as const };
    expect(authorizeProjectAssignment(caller, 'project-a', { isSelf: true })).toBe(false);
    expect(authorizeProjectAssignment(caller, 'project-a', { isSelf: true, elevatedProjectId: 'project-a' })).toBe(true);
    expect(authorizeProjectAssignment(caller, 'project-a', { isSelf: true, elevatedProjectId: 'project-b' })).toBe(false);
    expect(authorizeProjectAssignment(caller, undefined, { isSelf: true })).toBe(true);
  });

  it('treats legacy proposals without provenance as owned collisions', () => {
    expect(() => assertProposalOwnership({ text: 'legacy', generatedAt: 1 }, 'orch-a')).toThrow(/another orchestrator/);
    expect(() => assertProposalOwnership({ text: 'mine', generatedAt: 1, sourceThreadId: 'orch-a' }, 'orch-a')).not.toThrow();
  });

  it('repairs stale Project references and orphan heartbeats in one startup pass', () => {
    const mutableProjects = [{ id: 'a', orchestratorThreadId: 'stale', orchestratorEnabled: false }, { id: 'b', orchestratorThreadId: 'orch-b' }];
    const items = [
      { isOrchestratorHeartbeat: true, targetThreadId: 'stale' },
      { isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' },
    ];
    expect(repairStaleProjectOrchestrators(mutableProjects, id => id === 'orch-b' ? 'b' : undefined, items, 'portfolio')).toBe(true);
    expect(mutableProjects[0]!.orchestratorThreadId).toBeUndefined();
    expect(mutableProjects[0]!.orchestratorEnabled).toBe(false);
    expect(mutableProjects[1]!.orchestratorEnabled).toBe(true);
    expect(items).toEqual([{ isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' }]);
  });

  it('migrates legacy Projects to enabled and preserves persisted disabled state across reloads', () => {
    const serialized = JSON.stringify([
      { id: 'legacy', createdAt: 1 },
      { id: 'disabled', createdAt: 2, orchestratorEnabled: false },
    ]);
    const reloaded = JSON.parse(serialized) as Array<{ id: string; orchestratorEnabled?: boolean }>;

    expect(repairStaleProjectOrchestrators(reloaded, () => undefined, [], undefined)).toBe(true);
    expect(reloaded).toEqual([
      { id: 'legacy', createdAt: 1, orchestratorEnabled: true },
      { id: 'disabled', createdAt: 2, orchestratorEnabled: false },
    ]);
  });

  it('removes standalone orphan heartbeats even when every Project reference is valid', () => {
    const mutableProjects = [{ id: 'b', orchestratorThreadId: 'orch-b', orchestratorEnabled: true }];
    const items = [
      { isOrchestratorHeartbeat: true, targetThreadId: 'orphan' },
      { isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' },
    ];
    expect(repairStaleProjectOrchestrators(mutableProjects, () => 'b', items, 'portfolio')).toBe(true);
    expect(items).toEqual([{ isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' }]);
  });

  it('returns false when references and heartbeat targets are already valid', () => {
    const mutableProjects = [{ id: 'b', orchestratorThreadId: 'orch-b', orchestratorEnabled: true }];
    const items = [{ isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' }];
    expect(repairStaleProjectOrchestrators(mutableProjects, () => 'b', items, 'portfolio')).toBe(false);
  });
});

describe('manager notes denial reasons', () => {
  const projects = [
    { id: 'a', name: 'Alpha', orchestratorThreadId: 'orch-a', orchestratorEnabled: true },
    { id: 'b', name: 'Beta', orchestratorThreadId: 'orch-b', orchestratorEnabled: false },
  ];
  const portfolio = { kind: 'portfolio' } as const;
  const member = { kind: 'project-member', projectId: 'a' } as const;
  const orchestrator = { kind: 'project-orchestrator', projectId: 'a' } as const;

  it('allows without a reason where canWriteManagerNotes is true', () => {
    expect(explainManagerNotesDenial(portfolio, undefined, undefined, projects)).toBeUndefined();
    expect(explainManagerNotesDenial(portfolio, 'b', 'b', projects)).toBeUndefined();
    expect(explainManagerNotesDenial(orchestrator, 'a', undefined, projects)).toBeUndefined();
  });

  it('explains an enabled Project orchestrator owning the notes when elevation matches', () => {
    const reason = explainManagerNotesDenial(portfolio, 'a', 'a', projects)!;
    expect(reason).toContain('Alpha');
    expect(reason).toContain('thread orch-a');
    expect(reason).toContain('threads_send_message');
  });

  it('explains missing elevation without naming the Project or its orchestrator', () => {
    for (const elevated of [undefined, 'b']) {
      const reason = explainManagerNotesDenial(portfolio, 'a', elevated, projects)!;
      expect(reason).toContain('elevatedProjectId');
      expect(reason).toContain('disabled');
      expect(reason).not.toContain('Alpha');
      expect(reason).not.toContain('orch-a');
    }
  });

  it('tells a project member that only the orchestrator may write', () => {
    const reason = explainManagerNotesDenial(member, 'a', undefined, projects)!;
    expect(reason).toContain('Only the Project orchestrator');
    expect(reason).not.toContain('orch-a');
  });

  it('keeps the generic message for everything else and leaks nothing', () => {
    expect(explainManagerNotesDenial(member, 'b', undefined, projects)).toBe(OUT_OF_SCOPE_MESSAGE);
    expect(explainManagerNotesDenial(member, undefined, undefined, projects)).toBe(OUT_OF_SCOPE_MESSAGE);
    expect(explainManagerNotesDenial(orchestrator, 'b', undefined, projects)).toBe(OUT_OF_SCOPE_MESSAGE);
    expect(explainManagerNotesDenial({ kind: 'unassigned' }, 'a', undefined, projects)).toBe(OUT_OF_SCOPE_MESSAGE);
    expect(explainManagerNotesDenial(portfolio, 'zzz', 'zzz', projects)).toBe(OUT_OF_SCOPE_MESSAGE);
  });

  it('canWriteManagerNotes outcomes are unchanged across the role matrix', () => {
    const roles = [portfolio, member, orchestrator, { kind: 'unassigned' } as const];
    const targets = [undefined, 'a', 'b', 'zzz'];
    const elevations = [undefined, 'a', 'b', 'zzz'];
    for (const role of roles) for (const target of targets) for (const elevated of elevations) {
      const legacy = role.kind === 'portfolio'
        ? target === undefined || (target === elevated && projects.find(p => p.id === target)?.orchestratorEnabled === false)
        : role.kind === 'project-orchestrator' && target === role.projectId;
      expect(canWriteManagerNotes(role, target, elevated, projects)).toBe(legacy);
    }
  });
});
