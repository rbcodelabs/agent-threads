import { ItemView, WorkspaceLeaf, setIcon, Notice, Platform } from 'obsidian';
import { handleKanbanWheel } from './kanbanWheel';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { Thread, TaskItem } from './types';
import { agentHarnessLabel } from './types';
import { renderQuestionFields, type QuestionDraft } from './QuestionForm';
import { approveProposedReply, discardProposedReply, takeProposedReplyForEdit } from './proposedReplyActions';
import { answerPendingQuestions } from './questionActions';
import { proposedReplyDeps, questionAnswerDeps } from './managerActionDeps';
import { threadNeedsInput, splitNeedsInput } from './needsInput';
import { canOpenDockLink, openDockLink, type DockLinkDeps } from './dockLinkOpener';
import { OrchestratorDock, dockModeForWidth, type DockMode } from './orchestratorDock';
import { decisionToQuestion } from './decisions';
import { formatToolName } from './ClaudeSession';
import { appendPermissionButtons, summarizePermissionDetail } from './permissionCard';
import { hostExecState } from './managedPolicy';
import { relativeTime, buildCwdLabel, isAwsSsoError, formatWakeupCountdown } from './dashboardUtils';
import { renderAwsReauthButton } from './awsReauthButton';
import { resolveGitRepoRoot, resolveThreadProjectName } from './pathUtils';
import { remoteGroup, threadCwdLabel } from './remote/threadLocation';
import { parsePrUrlRepo } from './gitDiffUtils';
import { partitionScheduledStacks, type ScheduledStack } from './scheduledStacks';
import { appendOrchestratorBadge } from './orchestrator-badge';
import { liveRowFlags, partitionThreads, classifyThreadRow, type ThreadRowState } from './threadRowState';
import { telemetry } from './telemetry';
import { attachStackArchiveMenu, attachThreadArchiveMenu, type ArchiveMenuDeps } from './threadArchiveMenu';
import { promptConfirm } from './confirmModal';
import { ACTIVE_AGENT_STATUSES } from './agentRuns/agentTreeModel';
import { nextKanbanGroupBy, normalizeKanbanGroupBy } from './kanbanGroupBy';
import type { KanbanGroupBy } from './types';
import { buildGalleryImages, type GalleryImage } from './galleryImages';
import { GalleryCard, type GalleryCardModel, type GalleryStatusKind } from './galleryCard';
import { defaultVisibilityObserverFactory, type VisibilityObserver, type VisibilityObserverFactory } from './galleryLazy';
import { vaultResourceUrl } from './imageSrc';

export const KANBAN_VIEW_TYPE = 'claude-threads:kanban';

/** The floating pill at rest is ~48px (desktop) / ~58px (44px mobile targets); taller means a wrapped reason or the status row. */
const RESTING_PILL_MAX_PX = 62;

export function isKanbanThread(thread: Pick<Thread, 'background'>): boolean {
  return !thread.background;
}

type RowState = 'running' | 'idle' | 'error' | 'empty' | 'waiting';

/** Label of the leftmost status-board lane collecting threads that need Rick's input. */
export const NEEDS_YOU_LABEL = 'Needs you';

type ColDef = { label: string; threads: Thread[]; state: RowState; accentClass?: string; badge?: number };
type ThreadGroup = { key: string; label: string };
type ThreadGroupEntry = { key: string; label: string; threads: Thread[] };

/** Group key + display label for a thread's app/project, used by folder grouping. */
const UNASSIGNED_GROUP = 'Unassigned';

/**
 * Kanban column labels eligible for scheduled-thread stacking. These are the
 * "quiet" columns — a run that's running, awaiting a permission/question, or
 * errored always renders as its own card and is never a candidate.
 *
 * 'Reviewed' is the project-columns mode's sidebar-style label for what the
 * status board calls 'Done' (see sectionsForColumn()) — included here so
 * stacking still applies to that section under its own name. It never
 * collides with status-board rendering, which always uses 'Done'.
 */
const QUIET_COLUMN_LABELS = new Set(['New', 'Done', 'Ready', 'Reviewed']);

/**
 * Maps a thread's {@link ThreadRowState} to the column label + card RowState it
 * lands in under the status board / folder swimlanes (both use `bucketize()`).
 * Kept in exact lock-step with `bucketize()` so `computeCardPlacement()` can
 * reproduce a card's column key without re-running the full render.
 */
const STATUS_COLUMN_MAP: Record<ThreadRowState, { label: string; state: RowState }> = {
  running:         { label: 'Working', state: 'running' },
  awaiting:        { label: 'Awaiting', state: 'running' },
  waiting:         { label: 'Waiting', state: 'waiting' },
  'idle-new':      { label: 'New', state: 'idle' },
  'idle-reviewed': { label: 'Done', state: 'idle' },
  error:           { label: 'Failed', state: 'error' },
  empty:           { label: 'Ready', state: 'empty' },
};

/**
 * Maps a thread's {@link ThreadRowState} to the section label + card RowState it
 * lands in under the project-columns board (`sectionsForColumn()`), which folds
 * 'awaiting' into 'Working' and labels reviewed-idle as 'Reviewed' (vs 'Done').
 */
const PROJECT_SECTION_MAP: Record<ThreadRowState, { label: string; state: RowState }> = {
  running:         { label: 'Working', state: 'running' },
  awaiting:        { label: 'Working', state: 'running' },
  waiting:         { label: 'Waiting', state: 'waiting' },
  'idle-new':      { label: 'New', state: 'idle' },
  'idle-reviewed': { label: 'Reviewed', state: 'idle' },
  error:           { label: 'Failed', state: 'error' },
  empty:           { label: 'Ready', state: 'empty' },
};


export class KanbanView extends ItemView {
  private plugin: ClaudeThreadsPlugin;
  private manager: ThreadManager;
  private unsubscribe: (() => void) | null = null;
  /** Half-answered inbox forms, keyed by `<threadId>:q` / `<threadId>:d:<decisionId>`; survives full rebuilds. */
  private inboxDrafts = new Map<string, QuestionDraft>();

  private boardEl!: HTMLElement;
  private dock: OrchestratorDock | null = null;
  private dockMode: DockMode = 'pill';
  private dockResizeObserver: ResizeObserver | null = null;
  private pillObserver: ResizeObserver | null = null;
  private searchBarEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private searchClearBtn!: HTMLButtonElement;
  private searchBtn!: HTMLButtonElement;
  private groupByBtn!: HTMLButtonElement;
  private searchQuery = '';

  // Per-card live-update elements
  private activityEls: Map<string, HTMLElement> = new Map();
  private timeEls: Map<string, HTMLElement> = new Map();
  private rowEls: Map<string, HTMLElement> = new Map();
  private taskEls: Map<string, HTMLElement> = new Map();
  private summaryEls: Map<string, HTMLElement> = new Map();
  /** Per-card orchestrator-inbox blocks, patched in place by their own events. */
  private replyEls: Map<string, HTMLElement> = new Map();
  private decisionEls: Map<string, HTMLElement> = new Map();
  private notesEls: Map<string, HTMLElement> = new Map();
  private needsYouOnlyBtn!: HTMLButtonElement;
  private needsYouOnly = false;
  private activeThreadId: string | null = null;

  // ── Gallery mode ──────────────────────────────────────────────────────────
  private galleryCards: Map<string, GalleryCard> = new Map();
  /** Per-thread hero position, so a rebuild or live refresh keeps the user's place. */
  private galleryPositions: Map<string, { key: string; atNewest: boolean }> = new Map();
  /** Per-thread debounce timers for live gallery card refreshes (message / tool_result_images). */
  private galleryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private galleryObserver: VisibilityObserver | null = null;
  /** Overridable in tests; production uses IntersectionObserver. */
  private galleryObserverFactory: VisibilityObserverFactory = defaultVisibilityObserverFactory;

  /**
   * Records each rendered card's column placement (combined bucket + group key)
   * and RowState so `handleEvent` can decide, on a state-change event, whether
   * the card merely needs an in-place patch (placement unchanged) or a full
   * board rebuild (the card moved columns / was created / deleted). Rebuilt
   * every render alongside the element maps.
   */
  private cardPlacements: Map<string, { bucketKey: string; state: RowState }> = new Map();

  private renderPending = false;
  /** True while a pointer is held down on an inbox form (between pointerdown and pointerup). */
  private formPointerDown = false;
  /** When a render was first held back for an in-progress form interaction (ms epoch), else null. */
  private renderDeferredSince: number | null = null;
  /** Per-thread debounce timers for `scheduleActivityRefresh` (one 800ms window each). */
  private activityTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private timeInterval: ReturnType<typeof setInterval> | null = null;
  // Lightweight sweep to pause spinners of wedged ("stale") running cards
  // within ~15s — see AgentDashboard.refreshStale for rationale.
  private staleInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Keys of currently-expanded scheduled-job stacks, formatted
   * `${scopeKey}:${scheduledItemId}` where scopeKey is the column label
   * ("New") in status-board mode or `${laneLabel}::${columnLabel}` in
   * folder/swimlane mode — this keeps keys from colliding across lanes.
   */
  private expandedScheduledStacks = new Set<string>();

  /** Built once; every card's archive menu shares it (all fields read live state). */
  private archiveDeps: ArchiveMenuDeps | null = null;

  /** Tracks which sidebars were collapsed by this view on open, so we can restore them on close. */
  private _didCollapseLeft = false;
  private _didCollapseRight = false;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeThreadsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.manager = plugin.manager;
  }

  getViewType(): string { return KANBAN_VIEW_TYPE; }
  getDisplayText(): string { return 'Agent Board'; }
  getIcon(): string { return 'kanban'; }

  async onOpen(): Promise<void> {
    this.activeThreadId = this.plugin.getActiveThreadId();
    this.buildUI();
    this.render();
    this.unsubscribe = this.manager.subscribe((threadId, event) => {
      this.handleEvent(threadId, event);
    });
    this.timeInterval = setInterval(() => this.refreshTimes(), 30_000);
    this.staleInterval = setInterval(() => this.refreshStale(), 15_000);
    this._applyPanelCollapse();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.dockResizeObserver?.disconnect();
    this.dockResizeObserver = null;
    this.pillObserver?.disconnect();
    this.pillObserver = null;
    this.dock?.destroy();
    this.dock = null;
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
    for (const timer of this.galleryTimers.values()) clearTimeout(timer);
    this.galleryTimers.clear();
    this.disposeGallery();
    if (this.timeInterval) clearInterval(this.timeInterval);
    if (this.staleInterval) clearInterval(this.staleInterval);
    this._restorePanels();
  }

  /**
   * Toggles `.ct-stale` on each running card so styles.css pauses its spinner
   * once the thread has been `isRunning` with no progress for STALE_MS.
   */
  private refreshStale(): void {
    for (const [id, el] of this.rowEls) {
      el.toggleClass('ct-stale', this.manager.isRunStale(id));
    }
  }

  /**
   * Collapse whichever sidebar(s) the user has configured for the kanban board,
   * but only if they are not already collapsed. We track what we touched so
   * _restorePanels() can undo exactly the change we made.
   */
  private _applyPanelCollapse(): void {
    const side = this.plugin.settings.kanbanCollapseSide ?? 'none';
    if (side === 'none') return;
    const { leftSplit, rightSplit } = this.app.workspace;
    if ((side === 'left' || side === 'both') && !leftSplit.collapsed) {
      this._didCollapseLeft = true;
      leftSplit.collapse();
    }
    if ((side === 'right' || side === 'both') && !rightSplit.collapsed) {
      this._didCollapseRight = true;
      rightSplit.collapse();
    }
  }

  /** Re-expand any sidebar we collapsed in _applyPanelCollapse(). */
  private _restorePanels(): void {
    const { leftSplit, rightSplit } = this.app.workspace;
    if (this._didCollapseLeft) {
      this._didCollapseLeft = false;
      leftSplit.expand();
    }
    if (this._didCollapseRight) {
      this._didCollapseRight = false;
      rightSplit.expand();
    }
  }

  /**
   * Hold board rebuilds while the user is mid-gesture on an inline form (see
   * isInteractingWithInboxForm): a rebuild between pointerdown and click would
   * otherwise eat the click.
   */
  private bindFormInteractionGuards(): void {
    this.boardEl.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-draft-key]')) this.formPointerDown = true;
    });
    const releasePointer = (): void => {
      if (!this.formPointerDown) return;
      this.formPointerDown = false;
      this.flushDeferredRender();
    };
    // Non-passive so a vertical wheel can be turned into horizontal board scroll.
    this.boardEl.addEventListener('wheel', handleKanbanWheel, { passive: false });
    this.boardEl.addEventListener('pointerup', releasePointer);
    this.boardEl.addEventListener('pointercancel', releasePointer);
    this.boardEl.addEventListener('focusout', () => {
      // Let focus settle (it may move to another field in the same form) before flushing.
      setTimeout(() => this.flushDeferredRender(), 0);
    });
  }

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-agents-root');
    root.toggleClass('ct-mobile', Platform.isMobile);

    this.boardEl = root.createDiv('ct-agents-list');
    this.bindFormInteractionGuards();
    // Floating panel — centered at bottom of the board (count, New thread, group/search)
    const dispatchWrapper = root.createDiv('ct-kanban-dispatch');

    // Meta strip: Ask-the-orchestrator dock (left, mounted below) + New thread / group-by / search (right)
    const metaRow = dispatchWrapper.createDiv('ct-agents-panel-meta');
    const metaActions = metaRow.createDiv('ct-agents-panel-actions');

    // The dispatch composer lives in the conversation panel now; this just opens it.
    const newThreadBtn = metaActions.createEl('button', {
      cls: 'ct-new-thread-btn mod-cta',
      attr: { type: 'button', title: 'New thread', 'aria-label': 'New thread', 'data-testid': 'new-thread-button' },
    });
    const newThreadIcon = newThreadBtn.createSpan('ct-new-thread-btn-icon');
    newThreadIcon.setAttribute('aria-hidden', 'true');
    setIcon(newThreadIcon, 'square-pen');
    newThreadBtn.createSpan({ cls: 'ct-new-thread-btn-label', text: 'New thread' });
    newThreadBtn.addEventListener('click', () => { void this.plugin.openNewConversation(); });

    this.needsYouOnlyBtn = metaActions.createEl('button', {
      cls: 'ct-kanban-needs-chip',
      text: 'Only needs you',
      attr: { type: 'button', 'aria-pressed': 'false', 'data-testid': 'kanban-needs-you-filter', title: 'Show only threads waiting on you' },
    });
    this.needsYouOnlyBtn.addEventListener('click', () => {
      this.needsYouOnly = !this.needsYouOnly;
      this.needsYouOnlyBtn.toggleClass('ct-kanban-needs-chip-active', this.needsYouOnly);
      this.needsYouOnlyBtn.setAttribute('aria-pressed', String(this.needsYouOnly));
      this.render();
    });

    this.groupByBtn = metaActions.createEl('button', {
      cls: 'ct-kanban-groupby clickable-icon',
    });
    this.groupByBtn.addEventListener('click', () => this.toggleGroupBy());
    this.updateGroupByBtn();

    this.searchBtn = metaActions.createEl('button', {
      cls: 'ct-agents-search-btn clickable-icon',
      attr: { title: 'Search threads', 'aria-label': 'Search threads' },
    });
    setIcon(this.searchBtn, 'search');
    this.searchBtn.addEventListener('click', () => this.toggleSearch());

    // Search bar — hidden by default, expands inside the panel when toggled
    this.searchBarEl = dispatchWrapper.createDiv('ct-agents-search-bar ct-hidden');
    const searchFieldEl = this.searchBarEl.createDiv('ct-agents-search-field');
    this.searchInputEl = searchFieldEl.createEl('input', {
      cls: 'ct-agents-search-input',
      attr: { type: 'text', placeholder: 'Search threads…' },
    });
    this.searchClearBtn = searchFieldEl.createEl('button', {
      cls: 'ct-agents-search-clear ct-hidden',
      attr: { type: 'button', 'aria-label': 'Clear search' },
    });
    setIcon(this.searchClearBtn, 'x');
    this.searchClearBtn.addEventListener('click', () => {
      this.searchInputEl.value = '';
      this.searchQuery = '';
      this.searchClearBtn.addClass('ct-hidden');
      this.searchInputEl.focus();
      this.render();
    });
    this.searchInputEl.addEventListener('input', () => {
      this.searchQuery = this.searchInputEl.value.toLowerCase().trim();
      this.searchClearBtn.toggleClass('ct-hidden', this.searchInputEl.value === '');
      this.scheduleRender();
    });
    this.searchInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeSearch();
    });

    this.mountOrchestratorDock(root, metaRow);
  }

  /**
   * The Ask-the-orchestrator dock leads the pill's meta row. It replaces the old
   * "N running · N total" count text: that text now lives in the dock dot's tooltip.
   */
  private mountOrchestratorDock(root: HTMLElement, metaRow: HTMLElement): void {
    this.dockResizeObserver?.disconnect();
    this.pillObserver?.disconnect();
    this.dock?.destroy();
    this.dockMode = dockModeForWidth(root.clientWidth);
    const plugin = this.plugin;
    this.dock = new OrchestratorDock(metaRow, {
      manager: this.manager,
      listThreads: () => this.manager.getThreads().filter(isKanbanThread),
      hasPendingWakeup: (id) => plugin.hasPendingWakeup(id),
      getOrchestratorThreadId: () => plugin.settings.orchestratorThreadId,
      // open=false: set up without stealing focus into the chat view; the dock then focuses its own field.
      ensureOrchestrator: () => plugin.ensureOrchestratorThread(false),
      openThread: (id) => plugin.openThreadInChatView(id),
      // Never the active leaf (the board): see dockLinkOpener.ts.
      openLink: (href) => openDockLink(this.dockLinkDeps(), href),
      resolveLink: (href) => canOpenDockLink(this.dockLinkDeps(), href),
      mode: () => this.dockMode,
      daemons: plugin.daemonRegistry
        ? {
            stateOf: (id) => plugin.daemonRegistry?.stateOf(id),
            onState: (l) => plugin.daemonRegistry?.onState(l) ?? (() => {}),
            reconnect: (id) => { plugin.daemonRegistry?.clientFor(id)?.reconnectNow(); },
          }
        : null,
    });
    this.dock.mount();
    // Narrow boards collapse the pill to the orb (+ New thread): re-derive when the view width crosses 640px.
    if (typeof ResizeObserver !== 'undefined') {
      this.dockResizeObserver = new ResizeObserver(() => {
        // One measure (clientWidth) for open AND resize: contentRect is fractional and padding-excluded, so mixing the two
        // could flip the mode at exactly 640px.
        const next = dockModeForWidth(root.clientWidth);
        if (next === this.dockMode) { this.dock?.layoutChanged(); return; } // the sheet's max height follows the view height
        this.dockMode = next;
        this.dock?.relayout(); // re-measures with the NEW mode
      });
      this.dockResizeObserver.observe(root);
      // The pill grows (wrapped reason, narrow status row): keep the board's scroll end clear of it, driven by the
      // measured height rather than fixed paddings. Only set when taller than the resting pill (see styles.css).
      const pill = metaRow.parentElement;
      if (pill) {
        this.pillObserver?.disconnect();
        // Above RESTING_PILL_MAX_PX the pill has grown; at rest the variable is unset so the board keeps its 76px.
        this.pillObserver = new ResizeObserver(() => {
          if (pill.offsetHeight > RESTING_PILL_MAX_PX) root.style.setProperty('--ct-pill-clearance', `${pill.offsetHeight + 36 + 4}px`);
          else root.style.removeProperty('--ct-pill-clearance');
        });
        this.pillObserver.observe(pill);
      }
    }
  }

  private dockLinkDeps(): DockLinkDeps {
    const plugin = this.plugin;
    return {
      getFirstLinkpathDest: (path, source) => this.app.metadataCache.getFirstLinkpathDest(path, source),
      isConversationFirst: () => plugin.isConversationFirst(),
      openInContextPanel: (href, source) => { void plugin.contextPanel.openLinkText(href, source); },
      openLinkText: (href, source, newLeaf) => { void this.app.workspace.openLinkText(href, source, newLeaf); },
    };
  }

  /** Cmd+J target (see orchestratorDockCommand.ts). */
  focusOrchestratorDock(): void {
    this.dock?.focusField();
  }

  private toggleSearch(): void {
    const hidden = this.searchBarEl.hasClass('ct-hidden');
    if (hidden) {
      this.searchBarEl.removeClass('ct-hidden');
      this.searchInputEl.focus();
      setIcon(this.searchBtn, 'x');
      this.searchBtn.setAttribute('title', 'Close search');
      this.searchBtn.setAttribute('aria-label', 'Close search');
    } else {
      this.closeSearch();
    }
  }

  private closeSearch(): void {
    this.searchBarEl.addClass('ct-hidden');
    this.searchQuery = '';
    this.searchInputEl.value = '';
    this.searchClearBtn.addClass('ct-hidden');
    setIcon(this.searchBtn, 'search');
    this.searchBtn.setAttribute('title', 'Search threads');
    this.searchBtn.setAttribute('aria-label', 'Search threads');
    this.render();
  }

  private get groupBy(): KanbanGroupBy {
    return normalizeKanbanGroupBy(this.plugin.settings.kanbanGroupBy);
  }

  private updateGroupByBtn(): void {
    const mode = this.groupBy;
    const ICONS: Record<KanbanGroupBy, string> = {
      status: 'columns-3',
      folder: 'folder-tree',
      project: 'layout-panel-left',
      gallery: 'layout-grid',
    };
    const LABELS: Record<KanbanGroupBy, string> = {
      status: 'Group by folder',
      folder: 'Grouping by folder — click to group by project',
      project: 'Grouping by project — click to group by gallery',
      gallery: 'Group by: Gallery — click to group by status',
    };
    setIcon(this.groupByBtn, ICONS[mode]);
    this.groupByBtn.toggleClass('ct-kanban-groupby-active', mode !== 'status');
    const label = LABELS[mode];
    this.groupByBtn.setAttribute('title', label);
    this.groupByBtn.setAttribute('aria-label', label);
  }

  private async toggleGroupBy(): Promise<void> {
    this.plugin.settings.kanbanGroupBy = nextKanbanGroupBy(this.plugin.settings.kanbanGroupBy);
    await this.plugin.saveSettings();
    this.updateGroupByBtn();
    this.render();
  }

  render(): void {
    // Telemetry: a full board rebuild. Paired with rendersScheduled, this
    // quantifies how effectively scheduleRender() coalesces event bursts (and
    // guards against a regression of the v0.25.7 incremental-render fix).
    telemetry.recordKanbanFullRebuild();
    const scrollState = this.captureScrollState();
    const focus = this.captureInboxFocus();

    this.boardEl.empty();
    this.activityEls.clear();
    this.timeEls.clear();
    this.rowEls.clear();
    this.taskEls.clear();
    this.summaryEls.clear();
    this.replyEls.clear();
    this.decisionEls.clear();
    this.notesEls.clear();
    this.cardPlacements.clear();
    this.disposeGallery();

    const q = this.searchQuery;
    const allThreads = this.manager.getThreads().filter(isKanbanThread);
    const searched = q
      ? allThreads.filter(t =>
          t.title.toLowerCase().includes(q) ||
          (t.summary ?? '').toLowerCase().includes(q) ||
          (t.recap ?? '').toLowerCase().includes(q)
        )
      : allThreads;
    const threads = this.needsYouOnly ? searched.filter(t => this.matchesNeedsYouFilter(t)) : searched;

    if (threads.length === 0) {
      const emptyEl = this.boardEl.createDiv('ct-agents-empty');
      if (this.needsYouOnly) {
        emptyEl.createDiv({ text: 'Nothing needs you right now.' });
      } else if (q) {
        emptyEl.createDiv({ text: 'No threads match your search.' });
      } else {
        emptyEl.createDiv({ text: 'No threads yet.' });
        emptyEl.createDiv({ cls: 'ct-agents-empty-sub', text: 'Use New thread to start a task.' });
      }
      this.dock?.refresh();
      return;
    }

    if (this.groupBy === 'folder') {
      this.renderFolderBoard(threads);
    } else if (this.groupBy === 'project') {
      this.renderProjectColumnsBoard(threads);
    } else if (this.groupBy === 'gallery') {
      this.renderGalleryBoard(threads);
    } else {
      this.renderStatusBoard(threads);
    }

    this.dock?.refresh();

    this.restoreScrollState(scrollState);
    this.restoreInboxFocus(focus);
    this.pruneInboxDrafts();
  }

  /** Remembers which inbox text field (and caret) has focus so a rebuild doesn't drop mid-typing. */
  private captureInboxFocus(): { draftKey: string; fieldKey: string; start: number | null; end: number | null } | null {
    const ae = document.activeElement;
    if (!(ae instanceof HTMLInputElement) || !this.boardEl.contains(ae)) return null;
    const draftKey = ae.closest<HTMLElement>('[data-draft-key]')?.dataset.draftKey;
    const fieldKey = ae.dataset.fieldKey;
    if (!draftKey || fieldKey === undefined) return null;
    return { draftKey, fieldKey, start: ae.selectionStart, end: ae.selectionEnd };
  }

  private restoreInboxFocus(focus: ReturnType<KanbanView['captureInboxFocus']>): void {
    if (!focus) return;
    for (const body of Array.from(this.boardEl.querySelectorAll<HTMLElement>('[data-draft-key]'))) {
      if (body.dataset.draftKey !== focus.draftKey) continue;
      const input = body.querySelector<HTMLInputElement>(`input[data-field-key="${focus.fieldKey}"]`);
      if (!input) return;
      input.focus({ preventScroll: true });
      if (focus.start !== null && focus.end !== null) {
        try { input.setSelectionRange(focus.start, focus.end); } catch { /* password inputs may refuse */ }
      }
      return;
    }
  }

  /** Drops drafts whose question or decision no longer exists (answered, cleared, thread gone). */
  private pruneInboxDrafts(): void {
    for (const key of Array.from(this.inboxDrafts.keys())) {
      const [threadId, kind, decisionId] = key.split(':');
      const thread = this.manager.getThread(threadId);
      const alive = !!thread && (kind === 'q'
        ? (thread.pendingQuestions?.length ?? 0) > 0
        : (thread.pendingDecisions ?? []).some((d) => d.id === decisionId));
      if (!alive) this.inboxDrafts.delete(key);
    }
  }

  /**
   * Captures scroll offsets for every real scrolling container in the board
   * (tagged with `data-scroll-key`), keyed by a stable identifier so they can
   * be restored after a full board rebuild. `this.boardEl` itself has
   * `overflow: hidden` in CSS and never scrolls — the actual scroll surfaces
   * are `.ct-kanban-board`, `.ct-kanban-lane-board` (folder mode), and each
   * `.ct-kanban-col-body`.
   */
  private captureScrollState(): Map<string, { left: number; top: number }> {
    const state = new Map<string, { left: number; top: number }>();
    this.boardEl.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach(el => {
      state.set(el.dataset.scrollKey!, { left: el.scrollLeft, top: el.scrollTop });
    });
    return state;
  }

  /**
   * Restores scroll offsets captured by captureScrollState(). Stale keys (a
   * removed column) are simply unused; new keys (a new column) default to 0 —
   * both are harmless.
   */
  private restoreScrollState(state: Map<string, { left: number; top: number }>): void {
    this.boardEl.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach(el => {
      const saved = state.get(el.dataset.scrollKey!);
      if (saved) { el.scrollLeft = saved.left; el.scrollTop = saved.top; }
    });
  }

  /** Classification flags for a thread, read live (shared by every bucketing path). */
  private rowFlags(t: Thread) {
    return liveRowFlags(this.manager, (id) => this.plugin.hasPendingWakeup(id), t);
  }

  /** True when an orchestrator staged something for Rick, or the agent is asking him a question. */
  private needsYou(thread: Thread): boolean {
    return threadNeedsInput(thread, this.manager.hasPendingQuestion(thread.id));
  }

  /** The card RowState a thread has by its own status, ignoring the Needs you lane. */
  private rowStateFor(thread: Thread): RowState {
    return STATUS_COLUMN_MAP[classifyThreadRow(this.rowFlags(thread))].state;
  }

  /**
   * Buckets threads into the status columns and sorts each by recency.
   * Shared by both the status board and each folder swimlane. With
   * `withNeedsLane` (status board only) threads needing Rick are pulled out of
   * their status column into a leading "Needs you" lane.
   */
  private bucketize(threads: Thread[], withNeedsLane = false): ColDef[] {
    const { needsInput, rest } = withNeedsLane
      ? splitNeedsInput(threads, (t) => this.needsYou(t))
      : { needsInput: [] as Thread[], rest: threads };
    const buckets = partitionThreads(rest, (t) => this.rowFlags(t));

    const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
    const running = buckets.running.sort(byRecency);
    const permReqs = buckets.awaiting.sort(byRecency);
    const waiting = buckets.waiting.sort(byRecency);
    const unreviewed = buckets['idle-new'].sort(byRecency);
    const reviewed = buckets['idle-reviewed'].sort(byRecency);
    const errors = buckets.error.sort(byRecency);
    const empty = buckets.empty.sort(byRecency);

    const cols: ColDef[] = [
      { label: 'Working', threads: running, state: 'running' },
      { label: 'Awaiting', threads: permReqs, state: 'running', accentClass: 'ct-kanban-col-permission' },
      { label: 'Waiting', threads: waiting, state: 'waiting', accentClass: 'ct-kanban-col-waiting' },
      { label: 'New', threads: unreviewed, state: 'idle', badge: unreviewed.length > 0 ? unreviewed.length : undefined },
      { label: 'Done', threads: reviewed, state: 'idle' },
      { label: 'Failed', threads: errors, state: 'error' },
      { label: 'Ready', threads: empty, state: 'empty' },
    ];
    if (withNeedsLane) {
      cols.unshift({
        label: NEEDS_YOU_LABEL,
        threads: needsInput.sort(byRecency),
        state: 'running',
        accentClass: 'ct-kanban-col-needs-you',
      });
    }
    return cols;
  }

  private renderStatusBoard(threads: Thread[]): void {
    const board = this.boardEl.createDiv('ct-kanban-board');
    board.dataset.scrollKey = '__board__';
    const cols = this.bucketize(threads, true);
    for (const col of cols) {
      const alwaysShow = col.label === 'Working' || col.label === 'New';
      if (!alwaysShow && col.threads.length === 0) continue;
      this.renderColumn(board, col.label, col.threads, col.state, col.accentClass, col.badge, col.label);
    }
  }

  /**
   * Groups threads by app/project (assigned Project name, falling back to a
   * working-directory label) and renders one horizontal swimlane per group.
   * Within each lane the threads are bucketed into the same status columns;
   * empty columns are omitted to keep lanes compact.
   */
  private renderFolderBoard(threads: Thread[]): void {
    const board = this.boardEl.createDiv('ct-kanban-board ct-kanban-swimlanes');
    board.dataset.scrollKey = '__board__';

    const groups = new Map<string, ThreadGroupEntry>();
    for (const t of threads) {
      const group = this.threadGroup(t);
      const bucket = groups.get(group.key);
      if (bucket) bucket.threads.push(t);
      else groups.set(group.key, { ...group, threads: [t] });
    }

    // Sort lanes alphabetically (case-insensitive) so they stay put as threads
    // update — the last-modified sort happens WITHIN each lane (per status column
    // in bucketize), not across lanes. The catch-all group always sinks last.
    const lanes = this.sortGroupEntries(Array.from(groups.values()));

    for (const { key, label, threads: laneThreads } of lanes) {
      const lane = board.createDiv('ct-kanban-lane');

      const header = lane.createDiv('ct-kanban-lane-header');
      const titleSpan = header.createSpan('ct-kanban-lane-title');
      const iconSpan = titleSpan.createSpan('ct-kanban-lane-icon');
      setIcon(iconSpan, label === UNASSIGNED_GROUP ? 'folder-minus' : 'folder');
      titleSpan.createSpan({ cls: 'ct-kanban-lane-name', text: label });
      header.createSpan({ cls: 'ct-kanban-lane-count', text: String(laneThreads.length) });

      const laneBoard = lane.createDiv('ct-kanban-lane-board');
      laneBoard.dataset.scrollKey = `lane::${key}`;
      const cols = this.bucketize(laneThreads);
      for (const col of cols) {
        if (col.threads.length === 0) continue;
        this.renderColumn(laneBoard, col.label, col.threads, col.state, col.accentClass, col.badge, `${key}::${col.label}`);
      }
    }
  }

  /**
   * Sorts group entries (folder-swimlane lanes or project columns) alphabetically
   * (case-insensitive) by label, with the `Unassigned` catch-all always sinking
   * last regardless of name. Shared by renderFolderBoard() and
   * renderProjectColumnsBoard() so both grouping modes agree on lane/column order.
   */
  private sortGroupEntries(entries: ThreadGroupEntry[]): ThreadGroupEntry[] {
    return entries.slice().sort((a, b) => {
      if (a.key === 'unassigned') return 1;
      if (b.key === 'unassigned') return -1;
      const byLabel = a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
      return byLabel || a.key.localeCompare(b.key);
    });
  }

  /**
   * Groups threads by app/project (via threadGroup(), same resolution as folder
   * swimlanes) and renders one vertical column per project — alphabetically
   * sorted, Unassigned last. Unlike renderFolderBoard()'s nested per-lane status
   * columns, each project column here stacks status SECTIONS vertically inside
   * a single scrolling body (see renderProjectColumn()/sectionsForColumn()),
   * matching the Agent Dashboard sidebar's grouping.
   */
  private renderProjectColumnsBoard(threads: Thread[]): void {
    const board = this.boardEl.createDiv('ct-kanban-board');
    board.dataset.scrollKey = '__board__';

    const groups = new Map<string, ThreadGroupEntry>();
    for (const t of threads) {
      const group = this.threadGroup(t);
      const bucket = groups.get(group.key);
      if (bucket) bucket.threads.push(t);
      else groups.set(group.key, { ...group, threads: [t] });
    }

    const columns = this.sortGroupEntries(Array.from(groups.values()));
    for (const { key, label, threads: colThreads } of columns) {
      this.renderProjectColumn(board, key, label, colThreads);
    }
  }

  /**
   * Renders one project column: header (project name + count, matching
   * renderColumn()'s header) plus a body containing one subsection per
   * non-empty status bucket from sectionsForColumn().
   */
  private renderProjectColumn(board: HTMLElement, groupKey: string, label: string, threads: Thread[]): void {
    const col = board.createDiv('ct-kanban-col ct-kanban-project-col');

    const header = col.createDiv('ct-kanban-col-header');
    const headerLeft = header.createDiv('ct-kanban-col-header-left');
    headerLeft.createSpan({ cls: 'ct-kanban-col-label', text: label });
    header.createSpan({ cls: 'ct-kanban-col-count', text: String(threads.length) });

    const body = col.createDiv('ct-kanban-col-body');
    body.dataset.scrollKey = `project::${groupKey}`;

    const sections = this.sectionsForColumn(threads);
    if (sections.length === 0) {
      body.createDiv({ cls: 'ct-kanban-col-empty', text: 'Nothing here' });
      return;
    }

    for (const section of sections) {
      const sectionEl = body.createDiv('ct-kanban-project-section');
      const labelEl = sectionEl.createDiv('ct-kanban-project-section-label');
      labelEl.createSpan({ cls: 'ct-kanban-project-section-name', text: section.label });
      if (section.badge !== undefined) {
        labelEl.createSpan({ cls: 'ct-agents-group-badge ct-kanban-badge', text: String(section.badge) });
      }
      this.populateCardBody(sectionEl, section.threads, section.state, section.label, `${groupKey}::${section.label}`);
    }
  }

  /**
   * Buckets threads for a single project column into fixed-order status
   * sections, mirroring AgentDashboard.render()'s sidebar grouping exactly:
   * 'awaiting' folds into 'Working' (no separate Awaiting section here, unlike
   * the status board), each section sorted by recency, empty sections omitted.
   * 'New' carries a badge with its thread count, matching the status board.
   */
  private sectionsForColumn(threads: Thread[]): ColDef[] {
    const buckets = partitionThreads(threads, (t) => this.rowFlags(t));

    const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
    const working = [...buckets.running, ...buckets.awaiting].sort(byRecency);
    const waiting = buckets.waiting.sort(byRecency);
    const unreviewed = buckets['idle-new'].sort(byRecency);
    const reviewed = buckets['idle-reviewed'].sort(byRecency);
    const errors = buckets.error.sort(byRecency);
    const empty = buckets.empty.sort(byRecency);

    const all: ColDef[] = [
      { label: 'Working', threads: working, state: 'running' },
      { label: 'Waiting', threads: waiting, state: 'waiting' },
      { label: 'New', threads: unreviewed, state: 'idle', badge: unreviewed.length > 0 ? unreviewed.length : undefined },
      { label: 'Reviewed', threads: reviewed, state: 'idle' },
      { label: 'Failed', threads: errors, state: 'error' },
      { label: 'Ready', threads: empty, state: 'empty' },
    ];
    return all.filter(section => section.threads.length > 0);
  }

  /**
   * The app/project label a thread belongs to when grouping by folder:
   * the assigned Project's name, else the thread's git repo / project name,
   * else the Unassigned catch-all.
   *
   * Uses the repo NAME (resolveThreadProjectName) rather than buildCwdLabel so
   * that every worktree of a repo collapses into a single lane — e.g. a main
   * checkout and its `feat-x` / temp worktrees all group under "my-repo" instead
   * of appearing as separate "my-repo · feat-x" lanes. Each card still shows its
   * own branch/worktree via the cwd chip in the footer.
   *
   * `resolveThreadProjectName` additionally prefers `thread.originRepoPath` /
   * `thread.projectNameOverride` when the live cwd can no longer resolve a repo
   * name (e.g. its worktree directory was deleted) — see pathUtils.ts.
   */
  private normalizedRepoOrCwd(cwd: string): string {
    const root = resolveGitRepoRoot(cwd);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');
    const normalized = nodePath.resolve(root ?? cwd);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('fs').realpathSync(normalized);
    } catch {
      return normalized;
    }
  }

  private threadGroup(thread: Thread): ThreadGroup {
    if (thread.projectId) {
      const project = this.manager.getProject(thread.projectId);
      if (project) return { key: `project:${project.id}`, label: project.name };
    }

    const remote = remoteGroup(thread, (id) => this.plugin.daemonRegistry?.nameOf(id) ?? id);
    if (remote) return remote;

    if (thread.cwd || thread.originRepoPath) {
      const threadRoot = this.normalizedRepoOrCwd(thread.originRepoPath || thread.cwd);
      const matchingProject = this.manager.getProjects()
        .filter(project => this.normalizedRepoOrCwd(this.manager.getProjectCwd(project)) === threadRoot)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (matchingProject) {
        return { key: `project:${matchingProject.id}`, label: matchingProject.name };
      }

      const repo = resolveThreadProjectName(thread);
      if (repo) {
        // Legacy orphaned worktrees predate originRepoPath. Their persisted PR
        // URL is the only stable repository identity left after the distinct
        // worktree cwd paths disappear; projectNameOverride remains display-only.
        if (!thread.originRepoPath && thread.projectNameOverride && !resolveGitRepoRoot(thread.cwd)) {
          const prRepo = parsePrUrlRepo(thread.prUrl);
          if (prRepo) {
            return {
              key: `github:${prRepo.owner.toLowerCase()}/${prRepo.repo.toLowerCase()}`,
              label: repo,
            };
          }
        }
        return { key: `cwd:${threadRoot}`, label: repo };
      }
      // Fallback for non-repo paths (resolveThreadProjectName already returns
      // the last path segment, but guard anyway): shortened cwd label.
      const label = buildCwdLabel(thread.cwd, this.manager.vaultRoot);
      if (label) return { key: `cwd:${threadRoot}`, label };
    }
    return { key: 'unassigned', label: UNASSIGNED_GROUP };
  }

  private renderColumn(
    board: HTMLElement,
    label: string,
    threads: Thread[],
    state: RowState,
    accentClass?: string,
    badge?: number,
    scrollKey?: string,
  ): void {
    const col = board.createDiv('ct-kanban-col' + (accentClass ? ' ' + accentClass : ''));

    const header = col.createDiv('ct-kanban-col-header');
    const headerLeft = header.createDiv('ct-kanban-col-header-left');
    headerLeft.createSpan({ cls: 'ct-kanban-col-label', text: label });
    if (badge !== undefined) {
      headerLeft.createSpan({ cls: 'ct-agents-group-badge ct-kanban-badge', text: String(badge) });
    }
    header.createSpan({ cls: 'ct-kanban-col-count', text: String(threads.length) });

    const body = col.createDiv('ct-kanban-col-body');
    if (scrollKey) body.dataset.scrollKey = scrollKey;
    this.populateCardBody(body, threads, state, label, scrollKey ?? label);
  }

  /**
   * (Re)populates a column/section body with its cards: standalone cards
   * always; quiet-column labels additionally interleave collapsed job-stack
   * rollups with standalone cards by recency. Shared by renderColumn() (one
   * call per status/folder-swimlane column) and renderProjectColumn() (one
   * call per status section within a project column) so both stay in sync.
   */
  private populateCardBody(body: HTMLElement, threads: Thread[], state: RowState, label: string, scopeKey: string): void {
    if (threads.length === 0) {
      body.createDiv({ cls: 'ct-kanban-col-empty', text: 'Nothing here' });
      return;
    }

    const stackingEnabled = QUIET_COLUMN_LABELS.has(label) && (this.plugin.settings.stackScheduledThreads ?? true);
    if (!stackingEnabled) {
      for (const thread of threads) {
        // The Needs you lane mixes statuses, so each card keeps its own.
        this.renderCard(thread, label === NEEDS_YOU_LABEL ? this.rowStateFor(thread) : state, body, scopeKey);
      }
      return;
    }

    // Interleave standalone cards and job stacks by recency (newest first),
    // using each stack's newest run as its sort key, so a stack doesn't
    // artificially sink to the bottom of an otherwise recency-ordered column.
    const { stacks, standalone } = partitionScheduledStacks(threads);
    const items: Array<
      | { kind: 'card'; thread: Thread; ts: number }
      | { kind: 'stack'; stack: ScheduledStack; ts: number }
    > = [
      ...standalone.map(thread => ({ kind: 'card' as const, thread, ts: thread.updatedAt })),
      ...stacks.map(stack => ({ kind: 'stack' as const, stack, ts: stack.threads[0].updatedAt })),
    ];
    items.sort((a, b) => b.ts - a.ts);

    for (const item of items) {
      if (item.kind === 'card') this.renderCard(item.thread, state, body, scopeKey);
      else this.renderStackCard(item.stack, state, body, scopeKey);
    }
  }

  /**
   * Renders a collapsed-by-default rollup card for repeat runs of the same
   * scheduled job: job name, run count, latest-run time, and a chevron that
   * expands into one normal `renderCard()` per underlying thread. Only used
   * in "quiet" columns (New/Done/Ready) — a run that's running, awaiting
   * input, or errored is always rendered individually via `renderCard()`.
   */
  private renderStackCard(stack: ScheduledStack, state: RowState, parent: HTMLElement, scopeKey: string): void {
    const key = `${scopeKey}:${stack.scheduledItemId}`;
    const expanded = this.expandedScheduledStacks.has(key);

    const card = parent.createDiv({
      cls: `ct-kanban-card ct-kanban-card-${state} ct-kanban-card-stack`,
    });

    const cardHeader = card.createDiv('ct-kanban-card-header ct-kanban-stack-header');
    const iconEl = cardHeader.createDiv('ct-kanban-card-icon ct-kanban-icon-stack');
    setIcon(iconEl, 'clock');
    cardHeader.createDiv({ cls: 'ct-kanban-card-title', text: stack.scheduledItemName });
    cardHeader.createSpan({ cls: 'ct-kanban-stack-count', text: `×${stack.threads.length}` });
    const chevron = cardHeader.createSpan('ct-expand-btn');
    setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');

    cardHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.expandedScheduledStacks.has(key)) this.expandedScheduledStacks.delete(key);
      else this.expandedScheduledStacks.add(key);
      this.scheduleRender();
    });

    // Attached to the HEADER, not the card: expanded child cards are nested
    // INSIDE this card (unlike the dashboard, which puts them in a sibling
    // div), so a card-level listener would open a second menu on every
    // right-click of a nested card.
    attachStackArchiveMenu(cardHeader, stack.scheduledItemId, stack.threads.map(t => t.id), this.archiveMenuDeps());

    const footer = card.createDiv('ct-kanban-card-footer');
    footer.createDiv({ cls: 'ct-kanban-chip ct-kanban-chip-time', text: relativeTime(stack.threads[0].updatedAt) });

    if (expanded) {
      const stackBody = card.createDiv('ct-kanban-stack-body');
      for (const thread of stack.threads) {
        this.renderCard(thread, state, stackBody, scopeKey);
      }
    }
  }

  private renderCard(thread: Thread, state: RowState, parent: HTMLElement, placementKey: string): void {
    const isActive = thread.id === this.activeThreadId;
    const isUnreviewed = state === 'idle' && !thread.reviewed;
    const hasQuestion = (thread.pendingQuestions?.length ?? 0) > 0 || this.manager.hasPendingQuestion(thread.id);
    const hasPendingPerm = state === 'running' && this.manager.hasPendingPermission(thread.id) && !hasQuestion;
    const hasPending = hasPendingPerm || (state === 'running' && hasQuestion);

    const card = parent.createDiv({
      cls: [
        'ct-kanban-card',
        `ct-kanban-card-${state}`,
        isActive ? 'ct-agents-row-active' : '',
        isUnreviewed ? 'ct-kanban-card-unreviewed' : '',
        hasPending ? 'ct-kanban-card-permission' : '',
      ].filter(Boolean).join(' '),
    });
    this.rowEls.set(thread.id, card);
    card.toggleClass('ct-stale', this.manager.isRunStale(thread.id));
    // Record where this card lives so handleEvent can patch-vs-rebuild. The key
    // is the same combined bucket+group scopeKey the column was rendered under.
    this.cardPlacements.set(thread.id, { bucketKey: placementKey, state });

    // Header: icon + title
    const cardHeader = card.createDiv('ct-kanban-card-header');
    const iconEl = cardHeader.createDiv('');
    if (hasPending) {
      iconEl.className = 'ct-kanban-card-icon ct-kanban-icon-permission';
      iconEl.setText('?');
    } else {
      this.applyStateIcon(iconEl, state);
    }
    const cardTitleEl = cardHeader.createDiv({ cls: 'ct-kanban-card-title', text: thread.title });
    appendOrchestratorBadge(cardTitleEl, thread.id, this.plugin.settings.orchestratorThreadId, thread.projectId ? this.manager.getProject(thread.projectId)?.orchestratorThreadId : undefined);
    this.applyAgentCount(cardHeader, thread.id);

    // Summary (idle threads only). Always created for idle cards — kept hidden
    // (display:none via ct-hidden) when empty — so a later `summary_updated`
    // patch can populate it in place without a full board rebuild.
    if (state === 'idle') {
      const summaryEl = card.createDiv({ cls: 'ct-kanban-card-summary' });
      this.summaryEls.set(thread.id, summaryEl);
      this.applySummary(summaryEl, thread);
    }

    // Orchestrator inbox: a pending question, orchestrator decisions and a
    // proposed reply, answerable inline. Sub-blocks are persistent containers
    // (hidden when empty) so each event patches only its own block and never
    // wipes text typed into a sibling form.
    this.renderInbox(card, thread, hasQuestion);

    // Task list (compact checklist from Claude Code's TodoWrite/TaskCreate).
    // Always created (even when there are no tasks yet) so a later
    // `tasks_updated` event can patch it in place via taskEls without a full
    // board rebuild; `.ct-hidden` keeps the empty section invisible and
    // spacing-free.
    const taskSection = card.createDiv('ct-kanban-tasks');
    this.taskEls.set(thread.id, taskSection);
    this.populateTaskSection(taskSection, thread.tasks);

    if (hasPendingPerm) {
      const pendingInfo = this.manager.getPendingPermission(thread.id);
      const permContent = card.createDiv('ct-kanban-card-permission-content');
      const toolRow = permContent.createDiv('ct-kanban-card-perm-tool');
      toolRow.createSpan({ cls: 'ct-agents-permission-tool', text: pendingInfo?.toolName ? formatToolName(pendingInfo.toolName) : 'permission' });
      if (pendingInfo?.detail) {
        toolRow.createSpan({ cls: 'ct-agents-permission-detail ct-kanban-perm-detail', text: summarizePermissionDetail(pendingInfo.detail) });
      }
      const activityEl = permContent.createDiv('ct-kanban-card-activity');
      this.activityEls.set(thread.id, activityEl);

      const btns = card.createDiv('ct-kanban-perm-actions');
      this.appendPermissionButtons(btns, thread.id, pendingInfo);
    } else {
      const activityEl = card.createDiv({ cls: 'ct-kanban-card-activity' });
      this.activityEls.set(thread.id, activityEl);
      activityEl.setText(this.getActivityText(thread, state));

      // AWS SSO reauth button for expired tokens
      if (state === 'error' && isAwsSsoError(thread.lastError)) {
        renderAwsReauthButton(card, this.plugin.settings, thread.lastError, { stopPropagation: true });
      }
    }

    // Orchestrator notes: one-line preview, expandable, read-only.
    const notesEl = card.createDiv('ct-kanban-notes');
    notesEl.addEventListener('click', (e) => e.stopPropagation());
    this.notesEls.set(thread.id, notesEl);
    this.patchNotesBlock(notesEl, thread);

    // Footer chips
    const footer = card.createDiv('ct-kanban-card-footer');
    this.buildFooter(footer, thread);

    card.addEventListener('click', () => {
      if (state === 'idle' && !thread.reviewed) this.markReviewed(thread.id);
      this.plugin.openThreadInChatView(thread.id);
    });

    attachThreadArchiveMenu(card, thread.id, this.archiveMenuDeps());
  }

  /**
   * The orchestrator inbox for a card (question, decisions, proposed reply),
   * with sub-blocks registered so each event patches only its own block. Shared
   * by renderCard() and the Gallery's featured card.
   */
  private renderInbox(parent: HTMLElement, thread: Thread, hasQuestion: boolean): void {
    const inbox = parent.createDiv('ct-kanban-inbox');
    inbox.addEventListener('click', (e) => e.stopPropagation());
    if (hasQuestion) this.renderQuestionBlock(inbox.createDiv('ct-kanban-question'), thread);
    const decisionsEl = inbox.createDiv('ct-kanban-decisions');
    this.decisionEls.set(thread.id, decisionsEl);
    this.patchDecisionsBlock(decisionsEl, thread);
    const replyEl = inbox.createDiv('ct-kanban-reply');
    this.replyEls.set(thread.id, replyEl);
    this.patchReplyBlock(replyEl, thread);
    this.syncInboxVisibility(thread);
  }

  /**
   * Deny / Allow (once) / Always buttons for a pending permission. The single
   * implementation behind both the Needs-you lane cards and the Gallery's
   * featured card, so the two can never drift apart.
   */
  private appendPermissionButtons(
    btns: HTMLElement,
    threadId: string,
    pendingInfo: ReturnType<ThreadManager['getPendingPermission']>,
  ): void {
    appendPermissionButtons(btns, threadId, pendingInfo, {
      manager: this.manager,
      getSettings: () => this.plugin.settings,
      saveSettings: () => this.plugin.saveSettings(),
      hostExecAllowAlways: hostExecState(this.plugin.managedPolicy?.peek()).allowAlways,
    });
  }

  // ── Gallery mode ───────────────────────────────────────────────────────────

  /** Featured (large) cards shown at most this many at once; further Needs-you threads get a chip. */
  private static readonly MAX_FEATURED = 2;
  /** Debounce for live gallery card refreshes (same window as the activity line). */
  private static readonly GALLERY_REFRESH_MS = 800;

  /** A thread that earns the large featured card: it needs Rick, or has a permission waiting. */
  private wantsFeatured(thread: Thread): boolean {
    return this.needsYou(thread) || this.manager.hasPendingPermission(thread.id);
  }

  /**
   * "Only needs you" predicate. Gallery counts a pending permission as needing
   * you (same as its banner and featured card); the status board keeps its
   * original needsYou()-only semantics (a permission shows in its own lane).
   */
  private matchesNeedsYouFilter(thread: Thread): boolean {
    return this.groupBy === 'gallery' ? this.wantsFeatured(thread) : this.needsYou(thread);
  }

  private disposeGallery(): void {
    this.galleryObserver?.disconnect();
    this.galleryObserver = null;
    this.galleryCards.clear();
  }

  /**
   * Gallery group-by: one larger card per thread. Needs-you threads become big
   * featured cards (with the lane's own inbox / Allow / Deny controls) above a
   * wrapping grid of the rest, sorted by recent activity. No horizontal scroll.
   */
  private renderGalleryBoard(threads: Thread[]): void {
    const board = this.boardEl.createDiv('ct-gallery-board');
    board.dataset.scrollKey = '__board__';

    const sorted = threads.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    const wanting = sorted.filter((t) => this.wantsFeatured(t));
    const featuredIds = new Set(wanting.slice(0, KanbanView.MAX_FEATURED).map((t) => t.id));

    if (wanting.length > 0) {
      const banner = board.createDiv({ cls: 'ct-gallery-banner', attr: { role: 'status' } });
      const icon = banner.createSpan('ct-gallery-banner-icon');
      icon.setAttribute('aria-hidden', 'true');
      setIcon(icon, 'lock');
      banner.createSpan({ text: `${wanting.length} thread${wanting.length === 1 ? '' : 's'} ${wanting.length === 1 ? 'needs' : 'need'} you` });
      banner.createSpan({ cls: 'ct-gallery-banner-sub', text: 'Others sorted by recent activity' });
    }

    const grid = board.createDiv('ct-gallery-grid');
    // Single-column (narrow) boards have room for a 4th filmstrip slot per compact card.
    const width = board.clientWidth;
    const compactCap = width > 0 && width <= 640 ? 4 : 3;

    this.galleryObserver = this.galleryObserverFactory((el, visible) => {
      const id = (el as HTMLElement).dataset?.threadId;
      if (id) this.galleryCards.get(id)?.setVisible(visible);
    }, board) ?? null;

    const ordered = [...sorted.filter((t) => featuredIds.has(t.id)), ...sorted.filter((t) => !featuredIds.has(t.id))];
    for (const thread of ordered) {
      this.renderGalleryCard(grid, thread, featuredIds.has(thread.id), featuredIds.has(thread.id) ? 5 : compactCap);
    }

    // Drop remembered positions for threads that no longer exist.
    for (const id of Array.from(this.galleryPositions.keys())) {
      if (!this.manager.getThread(id)) this.galleryPositions.delete(id);
    }
  }

  private renderGalleryCard(parent: HTMLElement, thread: Thread, featured: boolean, stripCap: number): void {
    const id = thread.id;
    const card = new GalleryCard(this.buildGalleryModel(thread, featured, stripCap), {
      resolveUrl: (img, kind) => this.galleryUrl(img, kind),
      requestThumbnail: async (img) => {
        const full = this.galleryUrl(img, 'full');
        const thumbPath = await this.manager.ensureImageThumbnail?.(id, img.messageId, img.index, full ?? undefined);
        return thumbPath ? vaultResourceUrl(this.app, thumbPath) : null;
      },
      openThread: () => {
        const live = this.manager.getThread(id);
        if (live && !live.reviewed && this.rowStateFor(live) === 'idle') this.markReviewed(id);
        this.plugin.openThreadInChatView(id);
      },
      onPosition: (key, atNewest) => { this.galleryPositions.set(id, { key, atNewest }); },
    });
    parent.appendChild(card.el);

    // Register in the same per-card maps the other boards use so the shared
    // event paths (active card, stale spinner, inbox patching, activity line,
    // patch-vs-rebuild placement) keep working unchanged.
    this.galleryCards.set(id, card);
    this.rowEls.set(id, card.el);
    this.activityEls.set(id, card.messageEl);
    this.cardPlacements.set(id, this.computeCardPlacement(thread));
    card.el.toggleClass('ct-agents-row-active', id === this.activeThreadId);
    card.el.toggleClass('ct-stale', this.manager.isRunStale(id));
    attachThreadArchiveMenu(card.el, id, this.archiveMenuDeps());

    if (featured) this.renderFeaturedControls(card, thread);

    if (this.galleryObserver) this.galleryObserver.observe(card.el);
    else card.setVisible(true);
  }

  /** Inbox blocks and Allow / Deny for a featured card: the Needs-you lane's own renderers. */
  private renderFeaturedControls(card: GalleryCard, thread: Thread): void {
    const hasQuestion = (thread.pendingQuestions?.length ?? 0) > 0 || this.manager.hasPendingQuestion(thread.id);
    this.renderInbox(card.slotEl, thread, hasQuestion);
    if (!this.manager.hasPendingPermission(thread.id) || hasQuestion) return;
    const info = this.manager.getPendingPermission(thread.id);
    const label = info?.toolName ? formatToolName(info.toolName) : 'permission';
    const detail = info?.detail ? ` ${summarizePermissionDetail(info.detail)}` : '';
    card.slotEl.createEl('pre', {
      cls: 'ct-gallery-cmd',
      text: `${label}${detail}`,
      attr: { tabindex: '0', 'aria-label': 'Command awaiting approval' },
    });
    const btns = card.slotEl.createDiv('ct-kanban-perm-actions ct-gallery-actions');
    this.appendPermissionButtons(btns, thread.id, info);
  }

  private buildGalleryModel(thread: Thread, featured: boolean, stripCap: number): GalleryCardModel {
    const rowState = classifyThreadRow(this.rowFlags(thread));
    const { label, state } = STATUS_COLUMN_MAP[rowState];
    const needs = this.wantsFeatured(thread);
    const KIND: Record<ThreadRowState, GalleryStatusKind> = {
      running: 'working', awaiting: 'working', waiting: 'waiting', 'idle-new': 'new',
      'idle-reviewed': 'reviewed', error: 'failed', empty: 'ready',
    };
    const images: GalleryImage[] = thread.private
      ? []
      : buildGalleryImages({
          messages: thread.messages,
          pending: this.manager.getPendingToolResultImages?.(thread.id),
          isPrivate: thread.private,
        });
    const pos = this.galleryPositions.get(thread.id);
    let projectName: string | undefined;
    try {
      const group = this.threadGroup(thread);
      if (group.key !== 'unassigned') projectName = group.label;
    } catch {
      projectName = undefined;
    }
    return {
      threadId: thread.id,
      title: thread.title,
      statusLabel: needs ? NEEDS_YOU_LABEL : label,
      statusKind: needs ? 'needs' : KIND[rowState],
      projectName,
      message: this.getActivityText(thread, state),
      excerpt: this.lastAssistantExcerpt(thread, 220),
      updatedAt: thread.updatedAt,
      images,
      featured,
      needsYouChip: needs && !featured,
      kicker: featured && needs ? `${NEEDS_YOU_LABEL} · ${relativeTime(thread.updatedAt)}` : undefined,
      stripCap,
      placeholderTag: thread.private ? 'Private thread · images not shown' : 'No images yet',
      startKey: pos && !pos.atNewest ? pos.key : undefined,
      atNewest: pos?.atNewest ?? true,
    };
  }

  private lastAssistantExcerpt(thread: Thread, max: number): string {
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const m = thread.messages[i];
      if (m.role !== 'assistant') continue;
      const text = m.content.replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim();
      if (text) return text.length > max ? text.slice(0, max) + '…' : text;
    }
    return 'No messages yet';
  }

  /** URL for a gallery image: the vault file when resolvable, else inline data, else null. */
  private galleryUrl(img: GalleryImage, kind: 'full' | 'thumb'): string | null {
    if (kind === 'thumb') return img.thumbPath ? vaultResourceUrl(this.app, img.thumbPath) : null;
    if (img.path) {
      const url = vaultResourceUrl(this.app, img.path);
      if (url) return url;
    }
    return img.data ? `data:${img.mediaType};base64,${img.data}` : null;
  }

  /**
   * Debounced per-thread refresh of one gallery card (hero, filmstrip, text)
   * when a message or tool-result image arrives. Touches only that card, so it
   * never adds a full board rebuild.
   */
  private scheduleGalleryRefresh(threadId: string): void {
    if (this.groupBy !== 'gallery' || !this.galleryCards.has(threadId) || this.galleryTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.galleryTimers.delete(threadId);
      this.refreshGalleryCard(threadId);
    }, KanbanView.GALLERY_REFRESH_MS);
    this.galleryTimers.set(threadId, timer);
  }

  private refreshGalleryCard(threadId: string): void {
    const card = this.galleryCards.get(threadId);
    const thread = this.manager.getThread(threadId);
    if (!card || !thread) return;
    card.update(this.buildGalleryModel(thread, card.model.featured, card.model.stripCap));
  }

  private draftFor(key: string): QuestionDraft {
    let d = this.inboxDrafts.get(key);
    if (!d) { d = { fields: {} }; this.inboxDrafts.set(key, d); }
    return d;
  }

  /** Hides the inbox container when it has nothing to show (no question, decision or reply). */
  private syncInboxVisibility(thread: Thread): void {
    const inbox = this.replyEls.get(thread.id)?.parentElement;
    if (!inbox) return;
    const hasQuestion = !!inbox.querySelector('.ct-kanban-question') ;
    inbox.toggleClass('ct-hidden', !hasQuestion && !thread.proposedReply && (thread.pendingDecisions?.length ?? 0) === 0);
  }

  /** Inline answer form for the thread's pending AskUserQuestion set. Answers are never echoed back into the card. */
  private renderQuestionBlock(block: HTMLElement, thread: Thread): void {
    const questions = thread.pendingQuestions;
    const head = block.createDiv('ct-kanban-inbox-head');
    const iconEl = head.createSpan('ct-kanban-inbox-icon');
    setIcon(iconEl, 'help-circle');
    const source = agentHarnessLabel(questions?.find((q) => q.source)?.source);
    head.createSpan({ cls: 'ct-kanban-inbox-label', text: `${source} needs your input` });
    if (!questions || questions.length === 0) {
      block.createDiv({ cls: 'ct-kanban-inbox-hint', text: 'Open the thread to answer.' });
      return;
    }
    const body = block.createDiv('ct-kanban-question-body');
    const draftKey = `${thread.id}:q`;
    body.dataset.draftKey = draftKey;
    const collect = renderQuestionFields(body, questions, undefined, this.draftFor(draftKey));
    const actions = block.createDiv('ct-kanban-inbox-actions');
    const submit = actions.createEl('button', { cls: 'ct-kanban-inbox-btn ct-kanban-inbox-primary', text: 'Submit', attr: { type: 'button' } });
    submit.addEventListener('click', () => {
      submit.disabled = true;
      this.inboxDrafts.delete(draftKey);
      try {
        answerPendingQuestions(questionAnswerDeps(this.manager, () => this.plugin.saveSettings()), thread.id, questions, collect());
      } catch (err) {
        submit.disabled = false;
        console.error('[claude-threads] failed to answer question from board:', err);
        new Notice('Could not submit the answer. See the console for details.');
      }
    });
  }

  /**
   * Syncs the decisions container with `thread.pendingDecisions` without
   * touching forms that are already showing (so half-typed answers survive a
   * sibling decision being posted or cleared).
   */
  private patchDecisionsBlock(container: HTMLElement, thread: Thread): void {
    const decisions = thread.pendingDecisions ?? [];
    const wanted = new Set(decisions.map((d) => d.id));
    container.querySelectorAll<HTMLElement>('[data-decision-id]').forEach((el) => {
      if (!wanted.has(el.dataset.decisionId!)) el.remove();
    });
    const have = new Set(Array.from(container.querySelectorAll<HTMLElement>('[data-decision-id]')).map((el) => el.dataset.decisionId));
    for (const decision of decisions) {
      if (have.has(decision.id)) continue;
      const el = container.createDiv('ct-kanban-decision');
      el.dataset.decisionId = decision.id;
      const head = el.createDiv('ct-kanban-inbox-head');
      const iconEl = head.createSpan('ct-kanban-inbox-icon');
      setIcon(iconEl, 'git-fork');
      const from = this.manager.getThread(decision.sourceThreadId)?.title;
      head.createSpan({ cls: 'ct-kanban-inbox-label', text: from ? `Decision for you · ${from}` : 'Decision for you' });
      const body = el.createDiv('ct-kanban-question-body');
      const draftKey = `${thread.id}:d:${decision.id}`;
      body.dataset.draftKey = draftKey;
      const collect = renderQuestionFields(body, [decisionToQuestion(decision)], undefined, this.draftFor(draftKey));
      const actions = el.createDiv('ct-kanban-inbox-actions');
      const submit = actions.createEl('button', { cls: 'ct-kanban-inbox-btn ct-kanban-inbox-primary', text: 'Send answer', attr: { type: 'button' } });
      submit.addEventListener('click', async () => {
        const answer = collect()[decision.id] ?? '';
        if (!answer.trim()) {
          new Notice('Choose an option or type an answer first.');
          return;
        }
        submit.disabled = true;
        try {
          await this.manager.answerDecision(thread.id, decision.id, answer);
          this.inboxDrafts.delete(draftKey);
          void this.plugin.saveSettings();
        } catch (err) {
          submit.disabled = false;
          console.error('[claude-threads] failed to deliver decision answer:', err);
          new Notice(err instanceof Error ? err.message : 'Could not deliver the answer.');
        }
      });
    }
  }

  /** Renders (or clears) the proposed-reply block; idempotent on `generatedAt`. */
  private patchReplyBlock(container: HTMLElement, thread: Thread): void {
    const proposed = thread.proposedReply;
    if (!proposed) {
      container.empty();
      delete container.dataset.generatedAt;
      container.addClass('ct-hidden');
      return;
    }
    container.removeClass('ct-hidden');
    if (container.dataset.generatedAt === String(proposed.generatedAt)) return;
    container.empty();
    container.dataset.generatedAt = String(proposed.generatedAt);

    const head = container.createDiv('ct-kanban-inbox-head');
    const iconEl = head.createSpan('ct-kanban-inbox-icon');
    setIcon(iconEl, 'reply');
    head.createSpan({ cls: 'ct-kanban-inbox-label', text: 'Proposed reply' });

    const textEl = container.createDiv({ cls: 'ct-kanban-reply-text', text: proposed.text });
    textEl.setAttribute('title', 'Click to expand');
    textEl.addEventListener('click', () => textEl.toggleClass('ct-expanded', !textEl.hasClass('ct-expanded')));

    const deps = proposedReplyDeps(this.manager, () => this.plugin.saveSettings());
    const actions = container.createDiv('ct-kanban-inbox-actions');
    const edit = actions.createEl('button', { cls: 'ct-kanban-inbox-btn ct-kanban-reply-edit', text: 'Edit', attr: { type: 'button' } });
    edit.addEventListener('click', () => {
      const text = takeProposedReplyForEdit(deps, thread.id);
      if (text) void this.plugin.openThreadWithPrefill(thread.id, text);
    });
    const discard = actions.createEl('button', { cls: 'ct-kanban-inbox-btn ct-kanban-reply-discard', text: 'Discard', attr: { type: 'button' } });
    discard.addEventListener('click', () => discardProposedReply(deps, thread.id));
    const approve = actions.createEl('button', { cls: 'ct-kanban-inbox-btn ct-kanban-inbox-primary ct-kanban-reply-approve', text: 'Approve & Send', attr: { type: 'button' } });
    approve.addEventListener('click', async () => {
      approve.disabled = true;
      try {
        await approveProposedReply(deps, thread.id);
      } catch (err) {
        console.error('[claude-threads] failed to send approved proposed reply:', err);
        new Notice('Failed to send the approved reply. See the console for details.');
      }
    });
  }

  /** Renders (or hides) the read-only orchestrator notes block, keeping its expanded state. */
  private patchNotesBlock(container: HTMLElement, thread: Thread): void {
    const notes = thread.managerNotes?.trim();
    const expanded = container.hasClass('ct-expanded');
    container.empty();
    if (!notes) {
      container.addClass('ct-hidden');
      container.removeClass('ct-expanded');
      return;
    }
    container.removeClass('ct-hidden');
    const head = container.createDiv('ct-kanban-notes-head');
    const iconEl = head.createSpan('ct-kanban-inbox-icon');
    setIcon(iconEl, 'sticky-note');
    head.createSpan({ cls: 'ct-kanban-inbox-label', text: 'Notes' });
    if (thread.managerNotesUpdatedAt) {
      head.createSpan({ cls: 'ct-kanban-notes-updated', text: `updated ${relativeTime(thread.managerNotesUpdatedAt)}` });
    }
    const chevron = head.createSpan('ct-kanban-notes-chevron');
    setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');
    container.createDiv({ cls: 'ct-kanban-notes-text', text: notes });
    head.addEventListener('click', () => {
      const open = !container.hasClass('ct-expanded');
      container.toggleClass('ct-expanded', open);
      setIcon(chevron, open ? 'chevron-down' : 'chevron-right');
    });
    container.toggleClass('ct-expanded', expanded);
  }


  /**
   * (Re)builds a card's footer chip row from scratch: time, edited-files, PR,
   * cwd, and message-count chips. Shared by initial render and `patchCard` so a
   * chip that appears/disappears (e.g. a PR chip once a PR URL lands) is handled
   * identically without rebuilding the whole card. Never touches the status
   * icon, so it can't restart the running-icon spin animation.
   */
  private buildFooter(footer: HTMLElement, thread: Thread): void {
    footer.empty();

    const timeEl = footer.createDiv({ cls: 'ct-kanban-chip ct-kanban-chip-time', text: relativeTime(thread.updatedAt) });
    this.timeEls.set(thread.id, timeEl);

    if ((thread.editedFiles?.length ?? 0) > 0) {
      const filesChip = footer.createDiv('ct-kanban-chip ct-kanban-chip-files');
      const iconSpan = filesChip.createSpan();
      setIcon(iconSpan, 'file-text');
      filesChip.createSpan({ text: String(thread.editedFiles!.length) });
    }

    if (thread.prUrl) {
      const prChip = footer.createEl('a', { cls: 'ct-kanban-chip ct-kanban-chip-pr', text: 'PR' });
      prChip.href = '#';
      prChip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(thread.prUrl, '_blank');
      });
    }

    if (thread.cwd) {
      footer.createDiv({ cls: 'ct-kanban-chip ct-kanban-chip-cwd', text: threadCwdLabel(thread, () => buildCwdLabel(thread.cwd, this.plugin.manager.vaultRoot), (id) => this.plugin.daemonRegistry?.nameOf(id) ?? id) });
    }

    if (thread.messages.length > 0) {
      const msgChip = footer.createDiv('ct-kanban-chip ct-kanban-chip-msgs');
      const iconSpan = msgChip.createSpan();
      setIcon(iconSpan, 'message-circle');
      msgChip.createSpan({ text: String(thread.messages.length) });
    }
  }

  /** Populate (or hide, when empty) an idle card's summary line in place. */
  private applySummary(el: HTMLElement, thread: Thread): void {
    const summary = thread.summary || thread.recap;
    if (summary) {
      el.setText(summary);
      el.removeClass('ct-hidden');
    } else {
      el.setText('');
      el.addClass('ct-hidden');
    }
  }

  /** Create, update, or remove a card's agent count without rebuilding the card. */
  private applyAgentCount(cardHeader: HTMLElement, threadId: string): void {
    // Some lightweight view adapters omit agent APIs; treat those as no runs.
    const runs = this.manager.getAgentRuns?.(threadId) ?? [];
    const existing = cardHeader.querySelector<HTMLElement>('.ct-kanban-agent-count');
    if (runs.length === 0) {
      existing?.remove();
      return;
    }

    const countEl = existing ?? cardHeader.createDiv('ct-kanban-agent-count');
    countEl.setText(`◉ ${runs.length}`);
    countEl.setAttribute('title', `${runs.length} native agent${runs.length === 1 ? '' : 's'}`);
    countEl.toggleClass('ct-agent-count-active', runs.some(run => ACTIVE_AGENT_STATUSES.has(run.status)));
  }

  /**
   * Computes the column placement a thread WOULD render into right now — the
   * same combined bucket+group `scopeKey` and RowState used at render time — so
   * `handleEvent` can compare against the recorded placement and decide between
   * an in-place `patchCard` (placement unchanged) and a full rebuild (it moved).
   * Mirrors `bucketize()` / `sectionsForColumn()` via the shared column maps.
   */
  private computeCardPlacement(thread: Thread): { bucketKey: string; state: RowState } {
    const rowState = classifyThreadRow(this.rowFlags(thread));

    const mode = this.groupBy;
    if (mode === 'gallery') {
      // Gallery has its own stable keys: the featured area vs the grid. Moving
      // between them (a thread starts or stops needing the user) is a rebuild.
      return {
        bucketKey: this.wantsFeatured(thread) ? 'gallery::featured' : 'gallery::grid',
        state: STATUS_COLUMN_MAP[rowState].state,
      };
    }
    if (mode === 'project') {
      const { label, state } = PROJECT_SECTION_MAP[rowState];
      return { bucketKey: `${this.threadGroup(thread).key}::${label}`, state };
    }
    const { label, state } = STATUS_COLUMN_MAP[rowState];
    if (mode === 'folder') {
      return { bucketKey: `${this.threadGroup(thread).key}::${label}`, state };
    }
    if (this.needsYou(thread)) return { bucketKey: NEEDS_YOU_LABEL, state };
    return { bucketKey: label, state };
  }

  /**
   * Updates only the mutable, in-column parts of an already-rendered card: the
   * activity line, the idle summary line, and the footer chips (time / files /
   * PR / msgs). Deliberately leaves the status-icon node untouched so the
   * running-icon CSS spin animation isn't restarted and no layout is forced.
   * Only ever called when the card's column placement is unchanged.
   */
  private patchCard(threadId: string): void {
    const card = this.rowEls.get(threadId);
    const thread = this.manager.getThread(threadId);
    if (!card || !thread) return;
    const state = this.cardPlacements.get(threadId)?.state ?? 'idle';

    const activityEl = this.activityEls.get(threadId);
    if (activityEl) activityEl.setText(this.getActivityText(thread, state));

    const cardHeader = card.querySelector<HTMLElement>('.ct-kanban-card-header');
    if (cardHeader) this.applyAgentCount(cardHeader, threadId);

    if (state === 'idle') {
      const summaryEl = this.summaryEls.get(threadId);
      if (summaryEl) this.applySummary(summaryEl, thread);
    }

    const footer = card.querySelector<HTMLElement>('.ct-kanban-card-footer');
    if (footer) this.buildFooter(footer, thread);
  }

  /**
   * (Re)populates a card's task-list section from scratch. Shared by initial
   * render and the targeted `tasks_updated` patch path so both stay in sync.
   */
  private populateTaskSection(container: HTMLElement, tasks: TaskItem[] | undefined): void {
    container.empty();
    if (!tasks || tasks.length === 0) {
      container.addClass('ct-hidden');
      return;
    }
    container.removeClass('ct-hidden');

    const completedCount = tasks.filter(t => t.status === 'completed').length;
    container.createDiv({
      cls: 'ct-kanban-tasks-progress',
      text: `${completedCount} / ${tasks.length} done`,
    });

    const STATUS_ICONS: Record<string, string> = {
      completed: 'circle-check',
      in_progress: 'loader-circle',
      pending: 'circle',
    };
    const MAX_TASKS = 5;
    const visibleTasks = tasks.slice(0, MAX_TASKS);
    for (const task of visibleTasks) {
      const row = container.createDiv(`ct-kanban-task-row ct-task-row-${task.status}`);
      const iconEl = row.createSpan({ cls: 'ct-kanban-task-icon' });
      setIcon(iconEl, STATUS_ICONS[task.status] ?? 'circle');
      const label = task.content.length > 60 ? task.content.slice(0, 60) + '…' : task.content;
      row.createSpan({ cls: 'ct-kanban-task-text', text: label });
    }

    if (tasks.length > MAX_TASKS) {
      container.createDiv({
        cls: 'ct-kanban-tasks-more',
        text: `+${tasks.length - MAX_TASKS} more`,
      });
    }
  }

  private applyStateIcon(el: HTMLElement, state: RowState): void {
    el.className = `ct-kanban-card-icon ct-kanban-icon-${state}`;
    switch (state) {
      case 'running': el.setText('✽'); break;
      case 'waiting': el.setText('⏳'); break;
      case 'idle':    el.setText('✓'); break;
      case 'error':   el.setText('✗'); break;
      default:        el.setText('○'); break;
    }
  }

  private getActivityText(thread: Thread, state: RowState): string {
    if (state === 'running') {
      return this.manager.getThreadActivity(thread.id) || 'Working...';
    }
    if (state === 'waiting') {
      const next = this.plugin.getPendingWakeups(thread.id)[0];
      if (!next) return 'Waiting to resume';
      const when = formatWakeupCountdown(next.fireAt);
      return next.reason ? `Resumes ${when} — ${next.reason}` : `Resumes ${when}`;
    }
    if (state === 'error') return thread.lastError ?? 'Error occurred';
    if (state === 'empty') return 'Ready to start';
    let lastAssistant: Thread['messages'][number] | undefined;
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      if (thread.messages[i].role === 'assistant') { lastAssistant = thread.messages[i]; break; }
    }
    if (lastAssistant) {
      const text = lastAssistant.content.replace(/```[\s\S]*?```/g, '[code]').replace(/\n/g, ' ').trim();
      return text.length > 90 ? text.slice(0, 90) + '…' : text;
    }
    return 'Completed';
  }

  private refreshTimes(): void {
    for (const [id, el] of this.timeEls) {
      const thread = this.manager.getThread(id);
      if (thread) el.setText(relativeTime(thread.updatedAt));
    }
    for (const card of this.galleryCards.values()) card.refreshTimes();
    // Keep waiting-card countdowns roughly current without a full re-render.
    for (const [id, el] of this.activityEls) {
      if (!this.manager.isRunning(id) && this.plugin.hasPendingWakeup(id)) {
        const thread = this.manager.getThread(id);
        if (thread) el.setText(this.getActivityText(thread, 'waiting'));
      }
    }
  }

  private markReviewed(id: string): void {
    const thread = this.manager.getThread(id);
    if (!thread) return;
    thread.reviewed = true;
    this.plugin.saveSettings();
    this.scheduleRender();
  }

  /** Adapter for the shared archive context menu (see threadArchiveMenu.ts). */
  private archiveMenuDeps(): ArchiveMenuDeps {
    return this.archiveDeps ??= {
      getThreads: () => this.manager.getThreads(),
      isRunning: (id) => this.manager.isRunning(id),
      getProjects: () => this.manager.getProjects(),
      getPortfolioOrchestratorThreadId: () => this.plugin.settings.orchestratorThreadId,
      // onlyIfHasMessages: bulk-archiving quiet scheduled runs must not litter
      // the vault with empty notes (same flag ThreadsView.closeThread passes).
      archiveThread: (id) => this.plugin.archiveThreadById(id, true),
      cancelWakeups: (id) => this.plugin.cancelWakeups(id),
      saveSettings: () => this.plugin.saveSettings(),
      confirm: (spec) => promptConfirm(this.app, spec),
      notify: (message) => { new Notice(message); },
    };
  }

  private handleEvent(threadId: string, event: ThreadEvent): void {
    if (event.type === 'projects_changed') {
      this.scheduleRender();
      return;
    }
    if (event.type === 'threads_loaded') {
      this.scheduleRender();
      return;
    }
    if (event.type === 'active_thread_changed') {
      this.setActiveCard(threadId);
      return;
    }
    if (event.type === 'active_thread_cleared') {
      if (this.activeThreadId) this.rowEls.get(this.activeThreadId)?.removeClass('ct-agents-row-active');
      this.activeThreadId = null;
      return;
    }
    if (
      event.type === 'permission_request' ||
      event.type === 'permission_resolved' ||
      event.type === 'question_ready' ||
      event.type === 'pending_question_changed'
    ) {
      this.scheduleRender();
      return;
    }
    if (event.type === 'done') {
      const thread = this.manager.getThread(threadId);
      if (thread) {
        thread.reviewed = false;
        this.plugin.saveSettings();
      }
    }

    // Orchestrator-inbox events patch only their own block. A reply or decision
    // can move a card into/out of the Needs you lane (status board), so compare
    // the recomputed placement first and fall back to a rebuild when it moved.
    if (
      event.type === 'proposed_reply_changed' ||
      event.type === 'pending_decisions_changed' ||
      event.type === 'manager_notes_changed'
    ) {
      this.handleInboxEvent(threadId, event.type);
      return;
    }

    // `tasks_updated` carries the thread's full task list (thread.tasks) — patch
    // the card's task section directly instead of rebuilding the whole board.
    // Task changes never move a thread between columns (bucketing depends only
    // on running/error/reviewed/message-count state, not tasks), so a targeted
    // patch is always sufficient when the card is currently rendered. If the
    // card isn't rendered (e.g. filtered out by search), fall back to a full
    // render so state still converges.
    if (event.type === 'tasks_updated') {
      const el = this.taskEls.get(threadId);
      if (el) {
        this.populateTaskSection(el, event.tasks);
      } else {
        this.scheduleRender();
      }
      return;
    }
    // `task_updated` tracks a separate background-subtask (Task tool call),
    // not `thread.tasks` — it doesn't currently back any rendered card field,
    // so it intentionally does not trigger a render.

    if (event.type === 'project_changed' || event.type === 'cwd_changed') {
      this.scheduleRender();
      return;
    }

    // Gallery mode: new messages / tool-result images refresh only their own card.
    if (event.type === 'message' || event.type === 'tool_result_images') {
      this.scheduleGalleryRefresh(threadId);
      return;
    }

    const isStateChange =
      event.type === 'streaming_start' ||
      event.type === 'done' ||
      event.type === 'error' ||
      event.type === 'thread_deleted' ||
      event.type === 'thread_created' ||
      event.type === 'summary_updated' ||
      event.type === 'agent_runs_changed' ||
      event.type === 'status_tags' ||
      event.type === 'wakeup_changed' ||
      event.type === 'reviewed_changed' ||
      event.type === 'run_state_settled';
    if (isStateChange) {
      // Patch the card in place when its column membership is unchanged; only
      // fall back to a full rebuild when it actually moved columns, or is a
      // create/delete (which have no matching recorded placement / rendered
      // card, so they naturally take the scheduleRender path below).
      const recorded = this.cardPlacements.get(threadId);
      const thread = this.manager.getThread(threadId);
      if (thread && recorded && this.rowEls.has(threadId)) {
        const next = this.computeCardPlacement(thread);
        if (next.bucketKey === recorded.bucketKey && next.state === recorded.state) {
          this.patchCard(threadId);
          return;
        }
      }
      this.scheduleRender();
      return;
    }
    // A background (skipTranscript) task — a `run_in_background: true` Agent
    // call, or a Workflow-tool task — resolved. This is the only place a
    // thread that's sitting in "Working" purely because of an outstanding
    // background task moves back out once that task's last one finishes;
    // `done`/`run_state_settled` already correctly move it INTO that state
    // (scheduleRender() re-reads hasActiveBackgroundTasks live), but nothing
    // previously re-checked when the background side of things settled.
    if (event.type === 'task_notification') {
      this.scheduleRender();
      return;
    }
    if (
      event.type === 'tool_use' ||
      event.type === 'task_started' ||
      event.type === 'task_progress'
    ) {
      this.scheduleActivityRefresh(threadId);
    }
  }

  private handleInboxEvent(threadId: string, type: 'proposed_reply_changed' | 'pending_decisions_changed' | 'manager_notes_changed'): void {
    const thread = this.manager.getThread(threadId);
    const recorded = this.cardPlacements.get(threadId);
    if (!thread || !recorded || !this.rowEls.has(threadId)) {
      // Not rendered (new to the board, or filtered out): converge with a rebuild.
      this.scheduleRender();
      return;
    }
    if (type !== 'manager_notes_changed') {
      const next = this.computeCardPlacement(thread);
      if (next.bucketKey !== recorded.bucketKey || next.state !== recorded.state) {
        this.scheduleRender();
        return;
      }
    }
    if (this.needsYouOnly && type !== 'manager_notes_changed' && !this.matchesNeedsYouFilter(thread)) {
      this.scheduleRender();
      return;
    }
    if (type === 'proposed_reply_changed') {
      const el = this.replyEls.get(threadId);
      if (el) this.patchReplyBlock(el, thread);
    } else if (type === 'pending_decisions_changed') {
      const el = this.decisionEls.get(threadId);
      if (el) this.patchDecisionsBlock(el, thread);
    } else {
      const el = this.notesEls.get(threadId);
      if (el) this.patchNotesBlock(el, thread);
    }
    this.syncInboxVisibility(thread);
  }

  private setActiveCard(threadId: string): void {
    if (this.activeThreadId) {
      this.rowEls.get(this.activeThreadId)?.removeClass('ct-agents-row-active');
    }
    this.activeThreadId = threadId;
    this.rowEls.get(threadId)?.addClass('ct-agents-row-active');
  }

  private scheduleRender(): void {
    // Telemetry: count every render request (pre-coalescing), even ones the
    // debounce below folds into an existing pending render.
    telemetry.recordRenderScheduled();
    if (this.renderPending) return;
    this.renderPending = true;
    // 120ms coalesces bursts of events that span multiple macrotasks (a plain
    // setTimeout(0) only debounces within a single macrotask, so back-to-back
    // events each on their own tick would still each trigger a full rebuild).
    setTimeout(() => this.runScheduledRender(), 120);
  }

  /** Max time a rebuild may be held back for a focused form before it runs anyway (drafts + focus are restored). */
  private static readonly MAX_RENDER_DEFER_MS = 60_000;

  private runScheduledRender(): void {
    if (!this.renderPending) return; // a flush already ran the deferred rebuild
    if (this.isInteractingWithInboxForm()) {
      const since = this.renderDeferredSince ??= Date.now();
      if (Date.now() - since < KanbanView.MAX_RENDER_DEFER_MS) {
        // Keep renderPending set so further events fold into this one deferred
        // rebuild; flushDeferredRender() (blur / pointer release) or the retry
        // below runs it once the user is done.
        setTimeout(() => this.runScheduledRender(), 500);
        return;
      }
    }
    this.renderDeferredSince = null;
    this.renderPending = false;
    this.render();
  }

  /** Runs a held-back rebuild right away once the interaction that blocked it ends. */
  private flushDeferredRender(): void {
    if (this.renderDeferredSince === null || this.isInteractingWithInboxForm()) return;
    this.runScheduledRender();
  }

  /**
   * True while the user is mid-gesture on an inline question/decision form: a
   * pointer is down on one, or one of its inputs has focus. Rebuilding then
   * would drop the click or the caret.
   */
  private isInteractingWithInboxForm(): boolean {
    if (this.formPointerDown) return true;
    const ae = document.activeElement;
    return ae instanceof HTMLInputElement && this.boardEl.contains(ae) && !!ae.closest('[data-draft-key]');
  }

  private scheduleActivityRefresh(threadId: string): void {
    // Per-thread debounce: one in-flight 800ms window PER thread, so a second
    // running thread's activity isn't starved by the first thread holding a
    // single shared timer.
    if (this.activityTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.activityTimers.delete(threadId);
      const el = this.activityEls.get(threadId);
      // Keep the activity line updating from subagent/workflow progress even
      // after the outer turn's own isRunning() has gone false — onTaskProgress
      // writes into threadActivity regardless of foreground/background state.
      if (el && (this.manager.isRunning(threadId) || this.manager.hasActiveBackgroundTasks(threadId))) {
        const thread = this.manager.getThread(threadId);
        if (thread) el.setText(this.getActivityText(thread, 'running'));
      }
    }, 800);
    this.activityTimers.set(threadId, timer);
  }
}
