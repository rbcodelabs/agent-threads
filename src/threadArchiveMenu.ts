/**
 * Right-click → Archive for the Agents List and the Kanban board.
 *
 * The two views are structural twins (row/card, rollup row/stack card), so all
 * of the menu model, the guard sequencing and the archive loop live here and
 * each view contributes only a ~10-line `ArchiveMenuDeps` adapter. Nothing about
 * archiving is duplicated between them.
 *
 * Desktop only: Obsidian Mobile does not fire `contextmenu` on touch, and the
 * repo's one long-press implementation (DispatchInput) would collide with the
 * row's existing click handler. Mobile is a deliberate follow-up.
 */

import { Menu, Platform } from 'obsidian';
import type { Project, Thread } from './types';
import { buildArchivePlan, type ArchiveConfirm } from './archivePlan';

/** What a menu item will archive, resolved against live state at click time. */
export type ArchiveMenuScope =
  /** One specific thread. */
  | { kind: 'thread'; threadId: string }
  /** The runs this particular rollup row is showing. */
  | { kind: 'stack'; scheduledItemId: string; threadIds: string[] }
  /** Every run of the job, including rollups rendered in other groups/projects. */
  | { kind: 'job'; scheduledItemId: string };

export interface ArchiveMenuAction {
  title: string;
  icon: string;
  scope: ArchiveMenuScope;
}

/** The view collaborators the menu closes over. Both views build this identically. */
export interface ArchiveMenuDeps {
  getThreads(): Thread[];
  isRunning(id: string): boolean;
  getProjects(): Project[];
  /** `settings.orchestratorThreadId`, read live so a mid-session change is seen. */
  getPortfolioOrchestratorThreadId(): string | undefined;
  /** Wraps `plugin.archiveThreadById(id, true)` — see ArchiveExecutorDeps. */
  archiveThread(id: string): Promise<void>;
  cancelWakeups(id: string): void;
  saveSettings(): Promise<void>;
  confirm(spec: ArchiveConfirm): Promise<boolean>;
  notify(message: string): void;
}

/** The subset `executeArchivePlan` needs, so the executor is testable on its own. */
export type ArchiveExecutorDeps = Pick<ArchiveMenuDeps, 'archiveThread' | 'cancelWakeups' | 'saveSettings'>;

// ── Menu model ───────────────────────────────────────────────────────────────

/** A thread row always offers exactly one item. */
export function buildThreadMenuActions(thread: Thread): ArchiveMenuAction[] {
  return [{ title: 'Archive thread', icon: 'archive', scope: { kind: 'thread', threadId: thread.id } }];
}

/**
 * A scheduled-job rollup offers one or two items.
 *
 * A job's runs split across status groups (New/Reviewed/Ready) and project
 * sections, so one job can render as several rollups. The first item clears
 * just this rollup; the second — offered only when the job genuinely has more
 * runs elsewhere (M > N) — clears all of them at once.
 *
 * Ids that no longer resolve to a live thread are filtered out *before* N is
 * counted, so a stale menu can't advertise "these 5 runs" for 3 survivors.
 */
export function buildStackMenuActions(
  scheduledItemId: string,
  stackThreadIds: string[],
  allThreads: Thread[],
): ArchiveMenuAction[] {
  const live = new Set(allThreads.map(thread => thread.id));
  const ids = [...new Set(stackThreadIds)].filter(id => live.has(id));
  if (ids.length === 0) return [];

  const total = allThreads.filter(thread => thread.scheduledItemId === scheduledItemId).length;
  const actions: ArchiveMenuAction[] = [{
    title: ids.length === 1 ? 'Archive this run' : `Archive these ${ids.length} runs`,
    icon: 'archive',
    scope: { kind: 'stack', scheduledItemId, threadIds: ids },
  }];

  if (total > ids.length) {
    actions.push({
      title: `Archive all ${total} runs of this job`,
      icon: 'archive',
      scope: { kind: 'job', scheduledItemId },
    });
  }

  return actions;
}

/**
 * Re-derives an action's id list from live threads at click time.
 *
 * `stack` keeps the ids the menu item promised (dead ones are dropped later by
 * `buildArchivePlan`); `job` recomputes from scratch, so runs that started
 * while the menu was open are included.
 */
export function resolveArchiveIds(scope: ArchiveMenuScope, threads: Thread[]): string[] {
  switch (scope.kind) {
    case 'thread': return [scope.threadId];
    case 'stack': return scope.threadIds;
    case 'job': return threads.filter(thread => thread.scheduledItemId === scope.scheduledItemId).map(thread => thread.id);
  }
}

// ── Attach helpers ───────────────────────────────────────────────────────────

/**
 * Wires the per-thread menu onto a row/card.
 *
 * Eligibility is checked *before* `preventDefault()` (the pattern from
 * `ThreadsView.attachUserMessageMenu`): if the thread no longer resolves we fall
 * through so the host's native context menu still works rather than swallowing
 * the gesture.
 */
export function attachThreadArchiveMenu(el: HTMLElement, threadId: string, deps: ArchiveMenuDeps): void {
  el.addEventListener('contextmenu', (event) => {
    if (Platform.isMobile) return;
    const thread = deps.getThreads().find(candidate => candidate.id === threadId);
    if (!thread) return;

    const actions = buildThreadMenuActions(thread);
    if (actions.length === 0) return;

    event.preventDefault();
    // Belt-and-braces for cards nested inside a Kanban stack card: the rollup
    // menu is attached to the stack *header*, not the card, so this is not the
    // only thing preventing a double menu — but it keeps the guarantee local.
    event.stopPropagation();
    showArchiveMenu(event, actions, deps);
  });
}

/** Wires the rollup menu onto a scheduled-job row (dashboard) or stack header (Kanban). */
export function attachStackArchiveMenu(
  el: HTMLElement,
  scheduledItemId: string,
  stackThreadIds: string[],
  deps: ArchiveMenuDeps,
): void {
  el.addEventListener('contextmenu', (event) => {
    if (Platform.isMobile) return;
    const actions = buildStackMenuActions(scheduledItemId, stackThreadIds, deps.getThreads());
    if (actions.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    showArchiveMenu(event, actions, deps);
  });
}

function showArchiveMenu(event: MouseEvent, actions: ArchiveMenuAction[], deps: ArchiveMenuDeps): void {
  const menu = new Menu();
  for (const action of actions) {
    menu.addItem(item => item
      .setTitle(action.title)
      .setIcon(action.icon)
      .onClick(() => runArchiveAction(action, deps)));
  }
  menu.showAtMouseEvent(event);
}

/**
 * One `buildArchivePlan` call, at most one modal, then the archive loop.
 * Exported for the view tests, which invoke a recorded menu item's handler.
 */
export async function runArchiveAction(action: ArchiveMenuAction, deps: ArchiveMenuDeps): Promise<void> {
  const threads = deps.getThreads();
  const plan = buildArchivePlan(resolveArchiveIds(action.scope, threads), {
    threads,
    isRunning: id => deps.isRunning(id),
    orchestrator: {
      portfolioThreadId: deps.getPortfolioOrchestratorThreadId(),
      projects: deps.getProjects(),
    },
  });

  if (plan.blocked) {
    deps.notify(plan.blockedMessage ?? 'Nothing to archive.');
    return;
  }
  if (plan.confirm && !(await deps.confirm(plan.confirm))) return;

  const total = plan.ids.length;
  const { archived, failed } = await executeArchivePlan(plan.ids, deps);
  deps.notify(
    failed > 0
      ? `Archived ${archived} of ${total} — ${failed} failed (see console)`
      : `Archived ${archived} thread${archived === 1 ? '' : 's'}`,
  );
}

// ── Executor ─────────────────────────────────────────────────────────────────

/**
 * Archives `ids` using the same contract as `main.ts sweepIdleThreads`: a
 * sequential `for…of` with `await`, a per-item try/catch that logs and
 * continues, and a SINGLE `saveSettings()` after the loop.
 *
 * `archiveThreadById` deliberately does not save (see its contract comment in
 * main.ts) — each caller persists once. Do not parallelize with `Promise.all`:
 * the sequential loop is what keeps that persistence fence coherent.
 *
 * `cancelWakeups` runs immediately before each archive so an archived thread
 * can't be resurrected by a pending `ScheduleWakeup`.
 */
export async function executeArchivePlan(
  ids: string[],
  deps: ArchiveExecutorDeps,
): Promise<{ archived: number; failed: number }> {
  let archived = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      deps.cancelWakeups(id);
      await deps.archiveThread(id);
      archived++;
    } catch (err) {
      failed++;
      console.error(`[ClaudeThreads] Archive failed for thread ${id}:`, err);
    }
  }

  if (archived > 0) await deps.saveSettings();
  return { archived, failed };
}
