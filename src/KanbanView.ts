import type { AgentHarness } from './types';
import { ItemView, WorkspaceLeaf, setIcon, Notice, Platform } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { Thread, TaskItem } from './types';
import { formatToolName } from './ClaudeSession';
import { relativeTime, buildCwdLabel, isAwsSsoError, extractAwsProfile, resolveAwsBinary, awsExecEnv, formatWakeupCountdown } from './dashboardUtils';
import { resolveGitRepoRoot, resolveThreadProjectName } from './pathUtils';
import { parsePrUrlRepo } from './gitDiffUtils';
import { partitionScheduledStacks, type ScheduledStack } from './scheduledStacks';
import { DispatchInput } from './DispatchInput';
import { DISPATCH_BUILTIN_COMMANDS, DISPATCH_ARG_COMPLETIONS, parseDispatchDirective, goalKickoffMessage, escalationCommand } from './slashCommands';
import { buildMessageWithAttachment, deriveDispatchTitle } from './attachmentUtils';
import { appendOrchestratorBadge } from './orchestrator-badge';
import { partitionThreads, classifyThreadRow, type ThreadRowState } from './threadRowState';
import { telemetry } from './telemetry';
import { handleContributedDispatch } from './slashCommandRouting';
import { attachStackArchiveMenu, attachThreadArchiveMenu, type ArchiveMenuDeps } from './threadArchiveMenu';
import { promptConfirm } from './confirmModal';
import { ACTIVE_AGENT_STATUSES } from './agentRuns/agentTreeModel';

export const KANBAN_VIEW_TYPE = 'claude-threads:kanban';

export function isKanbanThread(thread: Pick<Thread, 'background'>): boolean {
  return !thread.background;
}

type RowState = 'running' | 'idle' | 'error' | 'empty' | 'waiting';

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

  private boardEl!: HTMLElement;
  private headerCountEl!: HTMLElement;
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
  private activeThreadId: string | null = null;

  /**
   * Records each rendered card's column placement (combined bucket + group key)
   * and RowState so `handleEvent` can decide, on a state-change event, whether
   * the card merely needs an in-place patch (placement unchanged) or a full
   * board rebuild (the card moved columns / was created / deleted). Rebuilt
   * every render alongside the element maps.
   */
  private cardPlacements: Map<string, { bucketKey: string; state: RowState }> = new Map();

  private renderPending = false;
  /** Per-thread debounce timers for `scheduleActivityRefresh` (one 800ms window each). */
  private activityTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private timeInterval: ReturnType<typeof setInterval> | null = null;
  // Lightweight sweep to pause spinners of wedged ("stale") running cards
  // within ~15s — see AgentDashboard.refreshStale for rationale.
  private staleInterval: ReturnType<typeof setInterval> | null = null;
  private dispatchInput!: DispatchInput;
  private selectedProjectId = '';
  private projectSelectEl!: HTMLSelectElement;

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
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
    if (this.timeInterval) clearInterval(this.timeInterval);
    if (this.staleInterval) clearInterval(this.staleInterval);
    this.dispatchInput?.destroy();
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

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-agents-root');
    root.toggleClass('ct-mobile', Platform.isMobile);

    this.boardEl = root.createDiv('ct-agents-list');

    // Floating dispatch panel — centered at bottom of the board
    const dispatchWrapper = root.createDiv('ct-kanban-dispatch ct-panel-collapsible');

    // Meta strip: thread count (left) + search button (right)
    const metaRow = dispatchWrapper.createDiv('ct-agents-panel-meta');
    this.headerCountEl = metaRow.createDiv('ct-agents-count');
    this.addProjectSelector(metaRow);
    const metaActions = metaRow.createDiv('ct-agents-panel-actions');

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

    this.dispatchInput = new DispatchInput({
      app: this.app,
      placeholder: 'Dispatch a new task',
      inlineLayout: true,
      builtinCommands: () => {
        const esc = escalationCommand(this.plugin.settings, true);
        const commands = [...DISPATCH_BUILTIN_COMMANDS, ...(this.plugin.slashCommands?.list('dispatch') ?? [])];
        return esc ? [...commands, esc] : commands;
      },
      subscribeCommands: listener => this.plugin.slashCommands?.subscribe(listener) ?? (() => {}),
      argCompletions: DISPATCH_ARG_COMPLETIONS,
      harnessPicker: { initialHarness: this.plugin.settings.agentHarness ?? 'claude' },
      onSend: async ({ text, images, attachment, agentHarness }) => {
        // Intercept contributed commands, then core model/goal/loop directives.
        // Apply directives instead of sending command text to the agent verbatim.
        let dispatchOpts: { model?: string; goal?: string; loop?: { intervalSeconds: number }; agentHarness?: AgentHarness; projectId?: string } = {
          agentHarness,
          projectId: this.selectedProjectId || undefined,
        };
        let titleText = text;
        if (await handleContributedDispatch({
          registry: this.plugin.slashCommands, text, images, attachment, agentHarness,
          projectId: dispatchOpts.projectId, input: this.dispatchInput,
        })) return;
        const directive = parseDispatchDirective(
          text,
          this.plugin.settings.escalationEnabled ? this.plugin.settings.escalationKeyword : undefined,
        );
        if (directive) {
          if (directive.error) {
            new Notice(directive.error);
            this.dispatchInput.setValue(text);
            return;
          }
          if (directive.kind === 'model') {
            if (!directive.rest && images.length === 0 && !attachment) {
              new Notice('Include a prompt after /model — e.g. "/model opus fix the login bug"');
              this.dispatchInput.setValue(text);
              return;
            }
            dispatchOpts = { ...dispatchOpts, model: directive.model };
            text = titleText = directive.rest;
          } else if (directive.kind === 'goal') {
            dispatchOpts = { ...dispatchOpts, goal: directive.goal };
            text = goalKickoffMessage(directive.goal);
            titleText = directive.goal;
          } else if (directive.kind === 'loop') {
            dispatchOpts = { ...dispatchOpts, loop: { intervalSeconds: directive.intervalSeconds } };
            text = titleText = directive.prompt;
          }
          // 'escalate' directives always carry `error` (handled above) — no
          // success case, so nothing to do here; fall through to dispatch
          // the raw text as-is via the ThreadManager keyword path.
        }

        let messageText = buildMessageWithAttachment(text, attachment);

        // Resolve @[[basename]] file mentions — append each file's content as context
        const mentionRegex = /@\[\[([^\]]+)\]\]/g;
        const mentions = [...messageText.matchAll(mentionRegex)].map(m => m[1]);
        if (mentions.length > 0) {
          const fileContextParts: string[] = [];
          for (const basename of mentions) {
            const file = this.app.vault.getMarkdownFiles().find(f => f.basename === basename);
            if (file) {
              try {
                const content = await this.app.vault.cachedRead(file);
                fileContextParts.push(`**File: ${file.path}**\n\`\`\`\n${content}\n\`\`\``);
              } catch { /* skip */ }
            }
          }
          if (fileContextParts.length > 0) {
            messageText = messageText + '\n\n---\nReferenced files:\n\n' + fileContextParts.join('\n\n');
          }
        }

        const titleHint = deriveDispatchTitle(titleText, attachment, images.length);
        const threadId = await this.plugin.dispatchNewThread(
          messageText,
          images.length > 0 ? images : undefined,
          titleHint,
          dispatchOpts,
        );
        await this.plugin.openThreadInChatView(threadId);
      },
      getPttKey: () => this.plugin.settings.pttKey ?? '',
    });
    this.dispatchInput.mount(dispatchWrapper);
  }

  private addProjectSelector(container: HTMLElement): void {
    const label = container.createEl('label', { cls: 'ct-dispatch-project' });
    label.createSpan({ text: 'Project', cls: 'ct-dispatch-project-label' });
    this.projectSelectEl = label.createEl('select', { attr: { 'aria-label': 'Dispatch Project' } });
    this.projectSelectEl.addEventListener('change', () => { this.selectedProjectId = this.projectSelectEl.value; });
    this.refreshProjectSelector();
  }

  private refreshProjectSelector(): void {
    const select = this.projectSelectEl;
    select.empty();
    select.createEl('option', { text: 'Unassigned', attr: { value: '' } });
    for (const project of this.manager.getProjects()) {
      select.createEl('option', { text: project.name, attr: { value: project.id } });
    }
    const selectionStillExists = !this.selectedProjectId || this.manager.getProject(this.selectedProjectId);
    if (!selectionStillExists) this.selectedProjectId = '';
    select.value = this.selectedProjectId;
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

  private get groupBy(): 'status' | 'folder' | 'project' {
    return this.plugin.settings.kanbanGroupBy ?? 'status';
  }

  private updateGroupByBtn(): void {
    const mode = this.groupBy;
    const ICONS: Record<'status' | 'folder' | 'project', string> = {
      status: 'columns-3',
      folder: 'folder-tree',
      project: 'layout-panel-left',
    };
    const LABELS: Record<'status' | 'folder' | 'project', string> = {
      status: 'Group by folder',
      folder: 'Grouping by folder — click to group by project',
      project: 'Grouping by project — click to group by status',
    };
    setIcon(this.groupByBtn, ICONS[mode]);
    this.groupByBtn.toggleClass('ct-kanban-groupby-active', mode !== 'status');
    const label = LABELS[mode];
    this.groupByBtn.setAttribute('title', label);
    this.groupByBtn.setAttribute('aria-label', label);
  }

  private async toggleGroupBy(): Promise<void> {
    const NEXT: Record<'status' | 'folder' | 'project', 'status' | 'folder' | 'project'> = {
      status: 'folder',
      folder: 'project',
      project: 'status',
    };
    this.plugin.settings.kanbanGroupBy = NEXT[this.groupBy];
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

    this.boardEl.empty();
    this.activityEls.clear();
    this.timeEls.clear();
    this.rowEls.clear();
    this.taskEls.clear();
    this.summaryEls.clear();
    this.cardPlacements.clear();

    const q = this.searchQuery;
    const allThreads = this.manager.getThreads().filter(isKanbanThread);
    const threads = q
      ? allThreads.filter(t =>
          t.title.toLowerCase().includes(q) ||
          (t.summary ?? '').toLowerCase().includes(q) ||
          (t.recap ?? '').toLowerCase().includes(q)
        )
      : allThreads;

    if (threads.length === 0) {
      const emptyEl = this.boardEl.createDiv('ct-agents-empty');
      if (q) {
        emptyEl.createDiv({ text: 'No threads match your search.' });
      } else {
        emptyEl.createDiv({ text: 'No threads yet.' });
        emptyEl.createDiv({ cls: 'ct-agents-empty-sub', text: 'Use the dispatch input below to start a task.' });
      }
      this.updateHeader(0, 0);
      return;
    }

    if (this.groupBy === 'folder') {
      this.renderFolderBoard(threads);
    } else if (this.groupBy === 'project') {
      this.renderProjectColumnsBoard(threads);
    } else {
      this.renderStatusBoard(threads);
    }

    const runningCount = threads.filter(t => this.manager.isRunning(t.id)).length;
    this.updateHeader(threads.length, runningCount);

    this.restoreScrollState(scrollState);
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

  /**
   * Buckets threads into the six status columns and sorts each by recency.
   * Shared by both the status board and each folder swimlane.
   */
  private bucketize(threads: Thread[]): ColDef[] {
    const buckets = partitionThreads(threads, (t) => ({
      isRunning: this.manager.isRunning(t.id),
      hasPendingPermission: this.manager.hasPendingPermission(t.id) || this.manager.hasPendingQuestion(t.id) || this.manager.hasPendingPlan(t.id),
      hasActiveBackgroundTasks: this.manager.hasActiveBackgroundTasks(t.id),
      hasPendingWakeup: this.plugin.hasPendingWakeup(t.id),
      lastError: t.lastError,
      messageCount: t.messages.length,
      reviewed: t.reviewed,
    }));

    const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
    const running = buckets.running.sort(byRecency);
    const permReqs = buckets.awaiting.sort(byRecency);
    const waiting = buckets.waiting.sort(byRecency);
    const unreviewed = buckets['idle-new'].sort(byRecency);
    const reviewed = buckets['idle-reviewed'].sort(byRecency);
    const errors = buckets.error.sort(byRecency);
    const empty = buckets.empty.sort(byRecency);

    return [
      { label: 'Working', threads: running, state: 'running' },
      { label: 'Awaiting', threads: permReqs, state: 'running', accentClass: 'ct-kanban-col-permission' },
      { label: 'Waiting', threads: waiting, state: 'waiting', accentClass: 'ct-kanban-col-waiting' },
      { label: 'New', threads: unreviewed, state: 'idle', badge: unreviewed.length > 0 ? unreviewed.length : undefined },
      { label: 'Done', threads: reviewed, state: 'idle' },
      { label: 'Failed', threads: errors, state: 'error' },
      { label: 'Ready', threads: empty, state: 'empty' },
    ];
  }

  private renderStatusBoard(threads: Thread[]): void {
    const board = this.boardEl.createDiv('ct-kanban-board');
    board.dataset.scrollKey = '__board__';
    const cols = this.bucketize(threads);
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
    const buckets = partitionThreads(threads, (t) => ({
      isRunning: this.manager.isRunning(t.id),
      hasPendingPermission: this.manager.hasPendingPermission(t.id) || this.manager.hasPendingQuestion(t.id) || this.manager.hasPendingPlan(t.id),
      hasActiveBackgroundTasks: this.manager.hasActiveBackgroundTasks(t.id),
      hasPendingWakeup: this.plugin.hasPendingWakeup(t.id),
      lastError: t.lastError,
      messageCount: t.messages.length,
      reviewed: t.reviewed,
    }));

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
        this.renderCard(thread, state, body, scopeKey);
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
    const hasPending = state === 'running' && (this.manager.hasPendingPermission(thread.id) || this.manager.hasPendingQuestion(thread.id));

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

    // Task list (compact checklist from Claude Code's TodoWrite/TaskCreate).
    // Always created (even when there are no tasks yet) so a later
    // `tasks_updated` event can patch it in place via taskEls without a full
    // board rebuild; `.ct-hidden` keeps the empty section invisible and
    // spacing-free.
    const taskSection = card.createDiv('ct-kanban-tasks');
    this.taskEls.set(thread.id, taskSection);
    this.populateTaskSection(taskSection, thread.tasks);

    if (hasPending) {
      const pendingInfo = this.manager.getPendingPermission(thread.id);
      const permContent = card.createDiv('ct-kanban-card-permission-content');
      const toolRow = permContent.createDiv('ct-kanban-card-perm-tool');
      toolRow.createSpan({ cls: 'ct-agents-permission-tool', text: pendingInfo?.toolName ? formatToolName(pendingInfo.toolName) : 'permission' });
      if (pendingInfo?.detail) {
        toolRow.createSpan({ cls: 'ct-agents-permission-detail ct-kanban-perm-detail', text: pendingInfo.detail });
      }
      const activityEl = permContent.createDiv('ct-kanban-card-activity');
      this.activityEls.set(thread.id, activityEl);

      const btns = card.createDiv('ct-kanban-perm-actions');
      const deny = btns.createEl('button', { text: 'Deny', cls: 'ct-permission-btn ct-permission-deny' });
      deny.addEventListener('click', (e) => { e.stopPropagation(); this.manager.resolvePermission(thread.id, false); });
      const allow = btns.createEl('button', { text: 'Allow', cls: 'ct-permission-btn ct-permission-allow' });
      allow.addEventListener('click', (e) => { e.stopPropagation(); this.manager.resolvePermission(thread.id, true); });
      const always = btns.createEl('button', { text: 'Always', cls: 'ct-permission-btn ct-permission-always' });
      always.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (pendingInfo) {
          this.plugin.settings.alwaysAllowedTools.push(pendingInfo.toolName);
          await this.plugin.saveSettings();
        }
        this.manager.resolvePermission(thread.id, true);
      });
    } else {
      const activityEl = card.createDiv({ cls: 'ct-kanban-card-activity' });
      this.activityEls.set(thread.id, activityEl);
      activityEl.setText(this.getActivityText(thread, state));

      // AWS SSO reauth button for expired tokens
      if (state === 'error' && isAwsSsoError(thread.lastError)) {
        const profile = extractAwsProfile(this.plugin.settings.extraEnv ?? '');
        const reauthBtn = card.createEl('button', {
          cls: 'ct-aws-reauth-btn',
          text: '🔑 Re-authenticate AWS SSO',
        });
        reauthBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          reauthBtn.setText('Authenticating…');
          reauthBtn.disabled = true;
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { exec } = require('child_process') as typeof import('child_process');
            const awsBin = resolveAwsBinary();
            const cmd = profile ? `${awsBin} sso login --profile ${profile}` : `${awsBin} sso login`;
            await new Promise<void>((resolve, reject) => {
              exec(cmd, { env: awsExecEnv() }, (err, _stdout, stderr) => {
                if (err) reject(new Error(stderr?.trim() || err.message));
                else resolve();
              });
            });
            new Notice('AWS SSO login successful — retry your request');
            reauthBtn.setText('✓ Done — retry your request');
          } catch (err) {
            new Notice(`AWS SSO login failed: ${(err as Error).message}`);
            reauthBtn.setText('🔑 Re-authenticate AWS SSO');
            reauthBtn.disabled = false;
          }
        });
      }
    }

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
      footer.createDiv({ cls: 'ct-kanban-chip ct-kanban-chip-cwd', text: buildCwdLabel(thread.cwd, this.plugin.manager.vaultRoot) });
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
    const rowState = classifyThreadRow({
      isRunning: this.manager.isRunning(thread.id),
      hasPendingPermission: this.manager.hasPendingPermission(thread.id) || this.manager.hasPendingQuestion(thread.id) || this.manager.hasPendingPlan(thread.id),
      hasActiveBackgroundTasks: this.manager.hasActiveBackgroundTasks(thread.id),
      hasPendingWakeup: this.plugin.hasPendingWakeup(thread.id),
      lastError: thread.lastError,
      messageCount: thread.messages.length,
      reviewed: thread.reviewed,
    });

    const mode = this.groupBy;
    if (mode === 'project') {
      const { label, state } = PROJECT_SECTION_MAP[rowState];
      return { bucketKey: `${this.threadGroup(thread).key}::${label}`, state };
    }
    const { label, state } = STATUS_COLUMN_MAP[rowState];
    if (mode === 'folder') {
      return { bucketKey: `${this.threadGroup(thread).key}::${label}`, state };
    }
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
    // Keep waiting-card countdowns roughly current without a full re-render.
    for (const [id, el] of this.activityEls) {
      if (!this.manager.isRunning(id) && this.plugin.hasPendingWakeup(id)) {
        const thread = this.manager.getThread(id);
        if (thread) el.setText(this.getActivityText(thread, 'waiting'));
      }
    }
  }

  private updateHeader(total: number, running: number): void {
    if (running > 0) {
      this.headerCountEl.setText(`${running} running · ${total} total`);
    } else {
      this.headerCountEl.setText(`${total} thread${total !== 1 ? 's' : ''}`);
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
      if (this.projectSelectEl) this.refreshProjectSelector();
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
    setTimeout(() => {
      this.renderPending = false;
      this.render();
    }, 120);
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
