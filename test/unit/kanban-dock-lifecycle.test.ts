/**
 * kanban-dock-lifecycle.test.ts
 * @vitest-environment jsdom
 *
 * KanbanView <-> OrchestratorDock wiring: open mounts the dock first in the pill
 * meta row and subscribes (manager, daemon registry, ResizeObserver); close
 * tears every one of them down. Also pins one width measure for the 640px
 * breakpoint (initial layout and the observer must agree).
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (n: string) => n }));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class { mount() {} destroy() {} setValue() {} } }));

import { KanbanView } from '../../src/KanbanView';

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public cb: (entries: Array<{ contentRect: { width: number } }>) => void) { FakeResizeObserver.instances.push(this); }
  observe(el: Element) { this.observed.push(el); }
  disconnect() { this.disconnected = true; }
  fire(width: number) { this.cb([{ contentRect: { width } }]); }
}

function make(rootWidth = 0) {
  const unsubManager = vi.fn();
  const unsubDaemon = vi.fn();
  const manager = {
    vaultRoot: '/v', getThreads: () => [], getThread: () => undefined, isRunning: () => false,
    hasPendingPermission: () => false, hasPendingQuestion: () => false, hasPendingPlan: () => false,
    hasActiveBackgroundTasks: () => false, isRunStale: () => false, getProjects: () => [], getProject: () => undefined,
    subscribe: vi.fn(() => unsubManager),
  };
  const plugin = {
    manager,
    settings: { kanbanGroupBy: 'status', stackScheduledThreads: false, alwaysAllowedTools: [], extraEnv: '', kanbanCollapseSide: 'none' },
    hasPendingWakeup: () => false, getPendingWakeups: () => [], getActiveThreadId: () => null,
    ensureOrchestratorThread: vi.fn(async () => {}), openThreadInChatView: vi.fn(),
    daemonRegistry: { stateOf: () => undefined, onState: vi.fn(() => unsubDaemon), clientFor: () => undefined },
  };
  const view = new KanbanView({} as never, plugin as never);
  (view as unknown as { app: unknown }).app = { workspace: { leftSplit: { collapsed: true }, rightSplit: { collapsed: true } } };
  const root = view.containerEl.children[1] as HTMLElement;
  Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => rootWidth });
  return { view, root, manager, plugin, unsubManager, unsubDaemon };
}

afterEach(() => { FakeResizeObserver.instances = []; vi.unstubAllGlobals(); });

describe('KanbanView dock lifecycle', () => {
  it('open mounts the dock first in the meta row; close unsubscribes, disconnects and removes the DOM', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const t = make(1000);
    await t.view.onOpen();
    const meta = t.root.querySelector('.ct-kanban-dispatch .ct-agents-panel-meta')!;
    expect(meta.firstElementChild?.classList.contains('ct-orch-dock')).toBe(true);
    expect(t.plugin.daemonRegistry.onState).toHaveBeenCalledTimes(1);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0].observed).toEqual([t.root]);

    await t.view.onClose();
    expect(t.unsubManager).toHaveBeenCalled(); // KanbanView's own + the dock's both return this spy
    expect(t.unsubManager.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(t.unsubDaemon).toHaveBeenCalledTimes(1);
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
    expect(t.root.querySelector('.ct-orch-dock')).toBeNull();
  });

  it('focusOrchestratorDock focuses the field', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const t = make(1000);
    document.body.appendChild(t.view.containerEl);
    await t.view.onOpen();
    // No orchestrator in this fixture: the Set up button takes focus.
    t.view.focusOrchestratorDock();
    expect(document.activeElement?.classList.contains('ct-orch-action')).toBe(true);
    await t.view.onClose();
  });

  it('A12: one measure (clientWidth) everywhere: exactly 640 is a pill at open and in the observer', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const t = make(640);
    await t.view.onOpen();
    const dock = () => t.root.querySelector('.ct-orch-dock') as HTMLElement;
    expect(dock().dataset.mode).toBe('pill');
    // contentRect (fractional, padding-excluded) disagrees with clientWidth: the observer must not flip the mode.
    FakeResizeObserver.instances[0].fire(639.5);
    expect(dock().dataset.mode).toBe('pill');
    await t.view.onClose();
  });

  it('A12: below 640 by clientWidth is an orb, and the observer re-measures', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const t = make(639);
    await t.view.onOpen();
    const dock = () => t.root.querySelector('.ct-orch-dock') as HTMLElement;
    expect(dock().dataset.mode).toBe('orb');
    Object.defineProperty(t.root, 'clientWidth', { configurable: true, get: () => 700 });
    FakeResizeObserver.instances[0].fire(0);
    expect(dock().dataset.mode).toBe('pill');
    await t.view.onClose();
  });
});
