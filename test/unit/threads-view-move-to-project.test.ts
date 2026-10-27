import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';

/**
 * Covers the "Move to Project…" action in the composer settings popover and the
 * `moveThreadToProject` handler the project popover calls.
 *
 * Before this, a thread created outside a Project could never be moved into one:
 * `threads_set_project` rejected it at the coordination layer and ThreadsView only
 * exposed a Project at thread *creation* time. This menu is the human-side escape hatch.
 *
 * ThreadsView is a full Obsidian ItemView and is not constructible under vitest, so these
 * call the real prototype methods against a stub receiver — the production code under
 * test is the actual shipped implementation, not a mirror.
 */

interface Ctx {
  view: ThreadsView;
  setThreadProject: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  renderComposerContext: ReturnType<typeof vi.fn>;
}

function makeView(opts: {
  activeThreadId: string;
  threads: Array<{ id: string; projectId?: string }>;
  projects?: Array<{ id: string; name: string; orchestratorThreadId?: string }>;
  portfolioOrchestratorThreadId?: string;
  setThreadProjectImpl?: (...args: unknown[]) => void;
}): Ctx {
  const projects = opts.projects ?? [];
  const setThreadProject = vi.fn(opts.setThreadProjectImpl);
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const renderComposerContext = vi.fn();

  // Built on the real prototype so the methods under test call each other for real —
  // only collaborators and DOM-bound repaint helpers are stubbed.
  const view = Object.assign(Object.create(ThreadsView.prototype), {
    activeThreadId: opts.activeThreadId,
    compressedView: false,
    escalatedTurnModels: new Map(),
    manager: {
      getThread: (id: string) => opts.threads.find(t => t.id === id) ?? null,
      getProjects: () => projects,
      getProject: (id: string) => projects.find(p => p.id === id) ?? null,
      setThreadProject,
      getHarnessSwitchBlockReason: () => undefined,
      policyTargetFor: () => ({ kind: 'machine' }),
    },
    plugin: {
      settings: { orchestratorThreadId: opts.portfolioOrchestratorThreadId },
      discoveredModelsByHarness: { claude: [], codex: [], opencode: [] },
      getClaudeCliProblems: () => [],
      saveSettings,
    },
    renderComposerContext,
    // Referenced by the other ⋯ items; never invoked in these tests.
    toggleCompressView: vi.fn(),
    summarizeThread: vi.fn(),
    forkThread: vi.fn(),
  }) as ThreadsView;

  return { view, setThreadProject, saveSettings, renderComposerContext };
}

/** Private-by-convention methods; reached through the prototype for testing. */
const proto = ThreadsView.prototype as unknown as {
  buildSettingsPopoverModel(this: ThreadsView, threadId: string): { actions: Array<{ id: string; label: string }> };
  moveThreadToProject(this: ThreadsView, threadId: string, projectId: string | null): Promise<void>;
};

const actionIds = (view: ThreadsView, id: string) => proto.buildSettingsPopoverModel.call(view, id).actions.map(a => a.id);
const PROJECTS = [
  { id: 'p1', name: 'Agentic PM Playbook' },
  { id: 'p2', name: 'Golden Wealth', orchestratorThreadId: 'orch-p2' },
];

describe('ThreadsView — Move to Project…', () => {
  it('offers the item for a normal unassigned thread', () => {
    const { view } = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    expect(actionIds(view, 't1')).toContain('project');
  });

  it('offers the item for a thread that is a plain member of a Project', () => {
    const { view } = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1', projectId: 'p1' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    expect(actionIds(view, 't1')).toContain('project');
  });

  it('hides the item for the Portfolio orchestrator, which can never be assigned', () => {
    const { view } = makeView({
      activeThreadId: 'portfolio',
      threads: [{ id: 'portfolio' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    expect(actionIds(view, 'portfolio')).not.toContain('project');
    // The rest of the popover actions are untouched.
    expect(actionIds(view, 'portfolio')).toContain('fork');
  });

  it('hides the item for a Project orchestrator, which cannot be reassigned', () => {
    const { view } = makeView({
      activeThreadId: 'orch-p2',
      threads: [{ id: 'orch-p2', projectId: 'p2' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    expect(actionIds(view, 'orch-p2')).not.toContain('project');
  });

  it('selecting a Project calls setThreadProject with alignCwd true and persists', async () => {
    const ctx = makeView({ activeThreadId: 't1', threads: [{ id: 't1' }], projects: PROJECTS });

    await proto.moveThreadToProject.call(ctx.view, 't1', 'p1');

    expect(ctx.setThreadProject).toHaveBeenCalledWith('t1', 'p1', true);
    expect(ctx.saveSettings).toHaveBeenCalled();
    expect(ctx.renderComposerContext).toHaveBeenCalledOnce();
  });

  it('selecting (No project) detaches by passing null', async () => {
    const ctx = makeView({ activeThreadId: 't1', threads: [{ id: 't1', projectId: 'p1' }], projects: PROJECTS });

    await proto.moveThreadToProject.call(ctx.view, 't1', null);

    expect(ctx.setThreadProject).toHaveBeenCalledWith('t1', null, true);
  });

  it('does not repaint the active-thread chrome when moving a non-active thread', async () => {
    const ctx = makeView({
      activeThreadId: 'other',
      threads: [{ id: 't1' }, { id: 'other' }],
      projects: PROJECTS,
    });

    await proto.moveThreadToProject.call(ctx.view, 't1', 'p1');

    expect(ctx.setThreadProject).toHaveBeenCalledWith('t1', 'p1', true);
    expect(ctx.renderComposerContext).not.toHaveBeenCalled();
  });

  it('surfaces a ThreadManager rejection instead of throwing out of the click handler', async () => {
    const ctx = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1' }],
      projects: PROJECTS,
      setThreadProjectImpl: () => { throw new Error('Project not found: p9'); },
    });

    await expect(proto.moveThreadToProject.call(ctx.view, 't1', 'p9')).resolves.toBeUndefined();
    expect(ctx.saveSettings).not.toHaveBeenCalled();
  });
});
