/** Peer API v1: orchestrators.ensure / orchestrators.setEnabled / extensions.registerSkill (extraction slices 2-4). */
import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1 } from '../../src/main';
import ClaudeThreadsPlugin from '../../src/main';
import { PeerSkillRegistry } from '../../src/PeerSkills';

const snap = (id: string, enabled = true) => ({ id, kind: id === 'portfolio' ? 'portfolio' : 'project', ...(id === 'portfolio' ? {} : { projectId: id.slice(8) }), threadId: enabled ? 't' : '', title: id, enabled });
function api(extra: Record<string, unknown> = {}) {
  const ensureOrchestrator = vi.fn(async (t: { id: string }) => t.id === 'project:none' ? null : snap(t.id));
  const setOrchestratorEnabled = vi.fn(async (t: { id: string }, enabled: boolean) => t.id === 'project:none' ? null : snap(t.id, enabled));
  const peerSkills = new PeerSkillRegistry();
  const service = createClaudeThreadsApiV1({
    getThreads: () => [], getThread: () => undefined, isRunning: () => false, createThread: vi.fn(), sendMessage: vi.fn(), openThread: vi.fn(),
    subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null, triggerHostEvent: vi.fn(),
    ensureOrchestrator, setOrchestratorEnabled, peerSkills, ...extra,
  } as never);
  return { service, api: service.api as any, ensureOrchestrator, setOrchestratorEnabled, peerSkills };
}

describe('capabilities', () => {
  it('advertises the new calls and no longer the wake-up delegate', () => {
    const { api: a } = api();
    expect(a.capabilities).toEqual(expect.arrayContaining(['orchestrators.ensure', 'orchestrators.setEnabled', 'extensions.registerSkill']));
    expect(a.capabilities).not.toContain('orchestrators.wakeup.delegate');
    expect(a.orchestrators.delegateWakeup).toBeUndefined();
  });
  it('omits each capability when its dependency is absent', () => {
    const { api: a } = api({ ensureOrchestrator: undefined, setOrchestratorEnabled: undefined, peerSkills: undefined });
    for (const c of ['orchestrators.ensure', 'orchestrators.setEnabled', 'extensions.registerSkill']) expect(a.capabilities).not.toContain(c);
  });
});

describe('orchestrators.ensure', () => {
  it('returns the host snapshot (frozen) for portfolio and project targets', async () => {
    const h = api();
    const p = await h.api.orchestrators.ensure({ id: 'portfolio' });
    expect(p).toMatchObject({ id: 'portfolio', enabled: true }); expect(Object.isFrozen(p)).toBe(true);
    await expect(h.api.orchestrators.ensure({ id: 'project:a' })).resolves.toMatchObject({ id: 'project:a' });
    expect(h.ensureOrchestrator).toHaveBeenCalledTimes(2);
  });
  it('unknown project => ORCHESTRATOR_NOT_FOUND', async () => {
    await expect(api().api.orchestrators.ensure({ id: 'project:none' })).rejects.toMatchObject({ code: 'ORCHESTRATOR_NOT_FOUND' });
  });
  it.each([[undefined], [null], [{}], [{ id: '' }], [{ id: 5 }], [{ id: 'bogus' }], [{ id: 'project:' }], [{ id: 'x'.repeat(300) }]])('invalid target %# => INVALID_ARGUMENT, host untouched', async (target) => {
    const h = api();
    await expect(h.api.orchestrators.ensure(target)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(h.ensureOrchestrator).not.toHaveBeenCalled();
  });
  it('rejects after stop()', async () => {
    const h = api(); h.service.stop();
    await expect(h.api.orchestrators.ensure({ id: 'portfolio' })).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
  });
});

describe('orchestrators.setEnabled', () => {
  it('passes the flag through and returns the snapshot', async () => {
    const h = api();
    await expect(h.api.orchestrators.setEnabled({ id: 'project:a' }, false)).resolves.toMatchObject({ enabled: false, threadId: '' });
    await expect(h.api.orchestrators.setEnabled({ id: 'project:a' }, true)).resolves.toMatchObject({ enabled: true });
    expect(h.setOrchestratorEnabled.mock.calls.map(c => c[1])).toEqual([false, true]);
  });
  it('portfolio cannot be toggled', async () => {
    const h = api();
    await expect(h.api.orchestrators.setEnabled({ id: 'portfolio' }, false)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.api.orchestrators.setEnabled({ id: 'portfolio' }, true)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(h.setOrchestratorEnabled).not.toHaveBeenCalled();
  });
  it.each([['yes'], [1], [undefined], [null]])('non-boolean enabled (%s) => INVALID_ARGUMENT', async (v) => {
    const h = api();
    await expect(h.api.orchestrators.setEnabled({ id: 'project:a' }, v)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(h.setOrchestratorEnabled).not.toHaveBeenCalled();
  });
  it('malformed target => INVALID_ARGUMENT; unknown project => ORCHESTRATOR_NOT_FOUND', async () => {
    const h = api();
    await expect(h.api.orchestrators.setEnabled({ id: 'nope' }, true)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.api.orchestrators.setEnabled({ id: 'project:none' }, true)).rejects.toMatchObject({ code: 'ORCHESTRATOR_NOT_FOUND' });
  });
});

describe('extensions.registerSkill', () => {
  const spec = { name: 'thread-orchestrator', description: 'd', content: 'c' };
  it('registers into the host registry and disposes', () => {
    const h = api();
    const d = h.api.extensions.registerSkill({ pluginId: 'p' }, spec);
    expect(h.peerSkills.list().map(s => s.name)).toEqual(['thread-orchestrator']);
    d.dispose();
    expect(h.peerSkills.list()).toEqual([]);
  });
  it('invalid spec throws INVALID_ARGUMENT', () => {
    expect(() => api().api.extensions.registerSkill({ pluginId: 'p' }, { ...spec, name: 'Bad Name' })).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
  it('stop() drops every registration made through the API; stale dispose is a no-op', () => {
    const h = api();
    const d = h.api.extensions.registerSkill({ pluginId: 'p' }, spec);
    h.service.stop();
    expect(h.peerSkills.list()).toEqual([]);
    expect(() => d.dispose()).not.toThrow();
  });
  it('rejects after stop()', () => {
    const h = api(); h.service.stop();
    expect(() => h.api.extensions.registerSkill({ pluginId: 'p' }, spec)).toThrowError(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }));
  });
});

describe('plugin wiring: ensurePublicOrchestrator / setPublicOrchestratorEnabled', () => {
  function plugin(projects: any[]) {
    const state = projects.map(p => ({ ...p }));
    const threads: Record<string, any> = { orch: { id: 'orch', title: 'Port' }, pa: { id: 'pa', title: 'A' } };
    const updateProject = vi.fn((id: string, patch: any) => { Object.assign(state.find(p => p.id === id)!, patch); });
    const ensureProjectOrchestratorThread = vi.fn(async (id: string) => {
      const p = state.find(x => x.id === id)!;
      if (p.orchestratorEnabled === false) return undefined;
      p.orchestratorThreadId ||= 'pa'; return p.orchestratorThreadId;
    });
    const ensureOrchestratorThread = vi.fn(async function (this: any) { this.settings.orchestratorThreadId ||= 'orch'; });
    const saveSettings = vi.fn(async () => {});
    const p = Object.assign(Object.create(ClaudeThreadsPlugin.prototype), {
      settings: { orchestratorThreadId: undefined as string | undefined },
      manager: { getThread: (id: string) => threads[id], getProjects: () => state, getProject: (id: string) => state.find(x => x.id === id), updateProject },
      ensureOrchestratorThread, ensureProjectOrchestratorThread, saveSettings,
    }) as any;
    return { p, updateProject, ensureProjectOrchestratorThread, ensureOrchestratorThread, saveSettings, state };
  }
  it('ensure(portfolio) creates without opening and returns the snapshot; idempotent', async () => {
    const { p, ensureOrchestratorThread } = plugin([]);
    const a = await p.ensurePublicOrchestrator({ id: 'portfolio' });
    const b = await p.ensurePublicOrchestrator({ id: 'portfolio' });
    expect(a).toEqual({ id: 'portfolio', kind: 'portfolio', threadId: 'orch', title: 'Port', enabled: true });
    expect(b).toEqual(a);
    expect(ensureOrchestratorThread).toHaveBeenCalledWith(false);
  });
  it('ensure(project) creates the thread; unknown project => null', async () => {
    const { p } = plugin([{ id: 'a', name: 'Alpha' }]);
    await expect(p.ensurePublicOrchestrator({ id: 'project:a' })).resolves.toMatchObject({ id: 'project:a', threadId: 'pa', enabled: true });
    await expect(p.ensurePublicOrchestrator({ id: 'project:zzz' })).resolves.toBeNull();
  });
  it('ensure(project) re-enables a disabled project (explicit opt-in)', async () => {
    const { p, state } = plugin([{ id: 'a', name: 'Alpha', orchestratorEnabled: false }]);
    await expect(p.ensurePublicOrchestrator({ id: 'project:a' })).resolves.toMatchObject({ enabled: true, threadId: 'pa' });
    expect(state[0].orchestratorEnabled).toBe(true);
  });
  it('setEnabled(false) disables without archiving or clearing the thread reference', async () => {
    const { p, state, saveSettings } = plugin([{ id: 'a', name: 'Alpha', orchestratorThreadId: 'pa' }]);
    const out = await p.setPublicOrchestratorEnabled({ id: 'project:a' }, false);
    expect(state[0]).toMatchObject({ orchestratorEnabled: false, orchestratorThreadId: 'pa' });
    expect(out).toMatchObject({ id: 'project:a', enabled: false, threadId: 'pa' });
    expect(saveSettings).toHaveBeenCalled();
  });
  it('setEnabled(false) on a project with no thread reports a thread-less disabled snapshot', async () => {
    const { p } = plugin([{ id: 'a', name: 'Alpha' }]);
    await expect(p.setPublicOrchestratorEnabled({ id: 'project:a' }, false)).resolves.toEqual({ id: 'project:a', kind: 'project', projectId: 'a', threadId: '', title: 'Alpha orchestrator', enabled: false });
  });
  it('setEnabled(true) == ensure; unknown project => null', async () => {
    const { p } = plugin([{ id: 'a', name: 'Alpha', orchestratorEnabled: false }]);
    await expect(p.setPublicOrchestratorEnabled({ id: 'project:a' }, true)).resolves.toMatchObject({ enabled: true, threadId: 'pa' });
    await expect(p.setPublicOrchestratorEnabled({ id: 'project:q' }, true)).resolves.toBeNull();
  });
});
