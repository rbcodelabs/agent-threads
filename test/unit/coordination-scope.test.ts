import { describe, expect, it } from 'vitest';
import { assertProposalOwnership, authorizeProjectAssignment, authorizeThreadAccess, canWriteManagerNotes, repairStaleProjectOrchestrators, resolveCoordinationRole } from '../../src/coordinationScope';

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

  describe('canWriteManagerNotes', () => {
    const noteProjects = [
      { id: 'disabled-fresh', orchestratorEnabled: false },
      { id: 'disabled-toggled', orchestratorThreadId: 'orch-a', orchestratorEnabled: false },
      { id: 'enabled-explicit', orchestratorThreadId: 'orch-b', orchestratorEnabled: true },
      { id: 'enabled-legacy', orchestratorThreadId: 'orch-c' },
    ];

    it('lets portfolio write notes on unassigned threads with or without options', () => {
      const portfolio = { kind: 'portfolio' as const };
      expect(canWriteManagerNotes(portfolio, undefined)).toBe(true);
      expect(canWriteManagerNotes(portfolio, undefined, {})).toBe(true);
      expect(canWriteManagerNotes(portfolio, undefined, { elevatedProjectId: 'disabled-fresh', projects: noteProjects })).toBe(true);
    });

    it('lets portfolio write notes on a disabled Project thread with matching elevatedProjectId', () => {
      const portfolio = { kind: 'portfolio' as const };
      expect(canWriteManagerNotes(portfolio, 'disabled-fresh', { elevatedProjectId: 'disabled-fresh', projects: noteProjects })).toBe(true);
      expect(canWriteManagerNotes(portfolio, 'disabled-toggled', { elevatedProjectId: 'disabled-toggled', projects: noteProjects })).toBe(true);
    });

    it('denies portfolio writes to a disabled Project without matching elevatedProjectId or project list', () => {
      const portfolio = { kind: 'portfolio' as const };
      expect(canWriteManagerNotes(portfolio, 'disabled-fresh')).toBe(false);
      expect(canWriteManagerNotes(portfolio, 'disabled-fresh', { projects: noteProjects })).toBe(false);
      expect(canWriteManagerNotes(portfolio, 'disabled-fresh', { elevatedProjectId: 'disabled-toggled', projects: noteProjects })).toBe(false);
      expect(canWriteManagerNotes(portfolio, 'disabled-fresh', { elevatedProjectId: 'disabled-fresh' })).toBe(false);
    });

    it('denies portfolio writes to enabled or legacy Projects even with matching elevatedProjectId', () => {
      const portfolio = { kind: 'portfolio' as const };
      expect(canWriteManagerNotes(portfolio, 'enabled-explicit', { elevatedProjectId: 'enabled-explicit', projects: noteProjects })).toBe(false);
      expect(canWriteManagerNotes(portfolio, 'enabled-legacy', { elevatedProjectId: 'enabled-legacy', projects: noteProjects })).toBe(false);
    });

    it('restricts project-orchestrator note writes strictly to its own Project', () => {
      const orchestrator = { kind: 'project-orchestrator' as const, projectId: 'enabled-explicit' };
      expect(canWriteManagerNotes(orchestrator, 'enabled-explicit')).toBe(true);
      expect(canWriteManagerNotes(orchestrator, 'disabled-fresh', { elevatedProjectId: 'disabled-fresh', projects: noteProjects })).toBe(false);
      expect(canWriteManagerNotes(orchestrator, undefined)).toBe(false);
    });

    it('denies manager note writes for project-member and unassigned roles', () => {
      const member = { kind: 'project-member' as const, projectId: 'enabled-explicit' };
      const unassigned = { kind: 'unassigned' as const };
      expect(canWriteManagerNotes(member, 'enabled-explicit')).toBe(false);
      expect(canWriteManagerNotes(member, undefined)).toBe(false);
      expect(canWriteManagerNotes(unassigned, undefined)).toBe(false);
      expect(canWriteManagerNotes(unassigned, 'disabled-fresh', { elevatedProjectId: 'disabled-fresh', projects: noteProjects })).toBe(false);
    });
  });
});
