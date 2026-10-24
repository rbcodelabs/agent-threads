import { ItemView, WorkspaceLeaf, setIcon, Notice, Platform, Menu, SearchComponent } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { Thread } from './types';
import { formatToolName } from './ClaudeSession';
import { canAlwaysAllow, summarizePermissionDetail, isHostExecPermission } from './permissionDetail';
import { recordAlwaysAllow } from './remoteAlwaysAllow';
import { addHostExecPrefix, hostExecAlwaysAllowOffer } from './hostExecPrefix';
import { hostExecState } from './managedPolicy';
import { relativeTime, buildCwdLabel, isAwsSsoError, formatWakeupCountdown } from './dashboardUtils';
import { renderAwsReauthButton } from './awsReauthButton';
import { partitionScheduledStacks, type ScheduledStack } from './scheduledStacks';
import { appendOrchestratorBadge } from './orchestrator-badge';
import { partitionThreads } from './threadRowState';
import { ACTIVE_AGENT_STATUSES } from './agentRuns/agentTreeModel';
import { resolveGitRepoRoot, resolveThreadProjectName } from './pathUtils';
import { remoteGroup, threadCwdLabel } from './remote/threadLocation';
import { parsePrUrlRepo } from './gitDiffUtils';
import { filterArchivedThreads, groupDashboardThreads, normalizeAgentsGroupBy, toggleAgentsGrouping, type AgentsGroupBy, type AgentsGroupingDimension } from './dashboardProjectGroups';
import { attachStackArchiveMenu, attachThreadArchiveMenu, type ArchiveMenuDeps } from './threadArchiveMenu';
import { promptConfirm } from './confirmModal';

export const AGENT_VIEW_TYPE = 'claude-threads:agents';

export function isDashboardThread(thread: Pick<Thread, 'background'>): boolean {
  return !thread.background;
}

type RowState = 'running' | 'waiting' | 'idle' | 'error' | 'empty';

export class AgentDashboard extends ItemView {
  private plugin: ClaudeThreadsPlugin;
  private manager: ThreadManager;
  private unsubscribe: (() => void) | null = null;

  private listEl!: HTMLElement;
  private searchBarEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private newThreadActionEl: HTMLElement | null = null;
  private searchActionEl: HTMLElement | null = null;
  private groupActionEl: HTMLElement | null = null;
  private searchQuery = '';
  private displayedThreadCount = 0;

  // Per-row activity text elements for live update without full re-render
  private activityEls: Map<string, HTMLElement> = new Map();
  private timeEls: Map<string, HTMLElement> = new Map();
  // Row elements for active-thread highlighting
  private rowEls: Map<string, HTMLElement> = new Map();
  private activeThreadId: string | null = null;

  // Debounce full re-render on state changes
  private renderPending = false;
  // Debounce activity-only refresh
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  // Periodic time refresh
  private timeInterval: ReturnType<typeof setInterval> | null = null;
  // Lightweight periodic sweep to pause spinners of wedged ("stale") running
  // threads within ~15s — faster than waiting on the 30s time refresh.
  private staleInterval: ReturnType<typeof setInterval> | null = null;

  /** IDs (Thread.scheduledItemId) of currently-expanded rows in the "Scheduled Jobs" section. */
  private expandedScheduledStacks = new Set<string>();
  /** Collapsed project / status groups (keys from groupKey). In-memory only. */
  private collapsedGroups = new Set<string>();
  /** Archived groups are collapsed by default; this tracks the ones the user opened. */
  private expandedArchivedGroups = new Set<string>();
  /** Archived threads read from vault notes (only loaded while "Show archived" is on). */
  private archivedThreads: Thread[] = [];

  /** Built once; every row's archive menu shares it (all fields read live state). */
  private archiveDeps: ArchiveMenuDeps | null = null;
  constructor(leaf: WorkspaceLeaf, plugin: ClaudeThreadsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.manager = plugin.manager;
    this.containerEl.addClass('mod-show-generic-header');
  }

  getViewType(): string { return AGENT_VIEW_TYPE; }
  getDisplayText(): string {
    return `${this.displayedThreadCount} thread${this.displayedThreadCount === 1 ? '' : 's'}`;
  }
  getIcon(): string { return 'list'; }

  async onOpen(): Promise<void> {
    this.activeThreadId = this.plugin.getActiveThreadId();
    this.buildUI();
    this.render();
    if (this.plugin.settings.agentsShowArchived) void this.refreshArchivedThreads();
    this.unsubscribe = this.manager.subscribe((threadId, event) => {
      this.handleEvent(threadId, event);
    });
    this.timeInterval = setInterval(() => this.refreshTimes(), 30_000);
    this.staleInterval = setInterval(() => this.refreshStale(), 15_000);
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    if (this.activityTimer) clearTimeout(this.activityTimer);
    if (this.timeInterval) clearInterval(this.timeInterval);
    if (this.staleInterval) clearInterval(this.staleInterval);
  }

  /**
   * Toggles `.ct-stale` on each running row so styles.css pauses its spinner
   * once the thread has been `isRunning` with no progress for STALE_MS. Cheap
   * Map walk; safe to call on a short interval and on every render.
   */
  private refreshStale(): void {
    for (const [id, el] of this.rowEls) {
      el.toggleClass('ct-stale', this.manager.isRunStale(id));
    }
  }

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-agents-root');
    root.addClass('ct-dashboard-root');
    root.toggleClass('ct-mobile', Platform.isMobile);

    this.ensureHeaderActions();

    // Search lives in the content area so the host-owned header stays stable.
    this.searchBarEl = root.createDiv('ct-agents-search-bar ct-hidden');
    const search = new SearchComponent(this.searchBarEl)
      .setPlaceholder('Search threads…')
      .onChange(value => {
        this.searchQuery = value.toLowerCase().trim();
        this.render();
      });
    this.searchInputEl = search.inputEl;
    this.searchInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeSearch();
    });

    // Scrollable thread list
    this.listEl = root.createDiv('ct-agents-list');
  }

  private ensureHeaderActions(): void {
    // "New thread" opens the conversation panel in new-conversation mode: the dispatch
    // composer (project picker, slash commands, attachments, harness picker) lives there.
    if (!this.newThreadActionEl) {
      this.newThreadActionEl = this.addAction('square-pen', 'New thread', () => { void this.plugin.openNewConversation(); });
      this.newThreadActionEl.setAttribute('data-testid', 'new-thread-button');
    }
    if (!this.searchActionEl) {
      this.searchActionEl = this.addAction('search', 'Search threads', () => this.toggleSearch());
      this.searchActionEl.setAttribute('aria-expanded', 'false');
    }
    if (!this.groupActionEl) {
      this.groupActionEl = this.addAction('list-filter', 'Group & filter agents', event => this.openGroupingMenu(event));
      this.groupActionEl.setAttribute('aria-haspopup', 'menu');
      this.groupActionEl.toggleClass('is-active', !!this.plugin.settings.agentsShowArchived);
    }
  }

  private openGroupingMenu(event: MouseEvent): void {
    const mode = this.currentGroupMode();
    const hasProject = mode !== 'status';
    const hasStatus = mode !== 'project';
    const menu = new Menu();
    this.addGroupingMenuItem(menu, 'Project', 'project', hasProject, hasProject && !hasStatus);
    this.addGroupingMenuItem(menu, 'Status', 'status', hasStatus, hasStatus && !hasProject);
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle('Show archived')
      .setIcon('archive')
      .setChecked(!!this.plugin.settings.agentsShowArchived)
      .onClick(() => void this.setShowArchived(!this.plugin.settings.agentsShowArchived)));
    menu.showAtMouseEvent(event);
  }

  private addGroupingMenuItem(
    menu: Menu,
    label: string,
    dimension: AgentsGroupingDimension,
    checked: boolean,
    disabled: boolean,
  ): void {
    menu.addItem(item => item
      .setTitle(label)
      .setChecked(checked)
      .setDisabled(disabled)
      .onClick(() => void this.setGroupingDimension(dimension)));
  }

  private async setShowArchived(show: boolean): Promise<void> {
    this.plugin.settings.agentsShowArchived = show;
    this.groupActionEl?.toggleClass('is-active', show);
    if (show) await this.refreshArchivedThreads();
    else { this.archivedThreads = []; this.render(); }
    await this.plugin.saveSettings();
  }

  private async refreshArchivedThreads(): Promise<void> {
    try {
      this.archivedThreads = await this.plugin.loadArchivedThreads();
    } catch (error) {
      console.error('[ClaudeThreads] Failed to load archived threads:', error);
      this.archivedThreads = [];
    }
    this.render();
  }

  private currentGroupMode(): AgentsGroupBy {
    return normalizeAgentsGroupBy(this.plugin.settings.agentsGroupBy);
  }

  private async setGroupingDimension(dimension: AgentsGroupingDimension): Promise<void> {
    const current = this.currentGroupMode();
    const next = toggleAgentsGrouping(current, dimension);
    if (next === current) return;
    this.plugin.settings.agentsGroupBy = next;
    this.render();
    await this.plugin.saveSettings();
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
    if (event.type === 'thread_deleted' && this.plugin.settings.agentsShowArchived) {
      // A thread that was just archived is written to its note before deletion;
      // give the vault index a moment, then pick it up in the Archived group.
      setTimeout(() => void this.refreshArchivedThreads(), 500);
    }
    if (event.type === 'threads_loaded') {
      this.scheduleRender();
      return;
    }
    if (event.type === 'active_thread_changed') {
      this.setActiveRow(threadId);
      return;
    }
    if (event.type === 'active_thread_cleared') {
      this.clearActiveRow();
      return;
    }
    if (
      event.type === 'permission_request' ||
      event.type === 'permission_resolved' ||
      event.type === 'question_ready' ||
      event.type === 'pending_question_changed' ||
      event.type === 'pending_plan_changed' ||
      event.type === 'plan_ready' ||
      event.type === 'plan_transition_error'
    ) {
      this.scheduleRender();
      return;
    }
    // A wake-up was registered, fired, or cancelled — re-partition so the
    // thread moves into/out of the "Waiting" group.
    if (event.type === 'wakeup_changed' || event.type === 'reviewed_changed') {
      this.scheduleRender();
      return;
    }
    // The session generation has fully unwound and isRunning() has reached
    // its final settled value — re-partition so a thread with a pending
    // wake-up doesn't stay stuck under "Working" until an unrelated re-render.
    if (event.type === 'run_state_settled') {
      this.scheduleRender();
      return;
    }
    // When a thread finishes a new run, mark it unreviewed so it surfaces in "New"
    if (event.type === 'done') {
      const thread = this.manager.getThread(threadId);
      if (thread) {
        thread.reviewed = false;
        this.plugin.saveSettings();
      }
    }


    const isStateChange =
      event.type === 'streaming_start' ||
      event.type === 'done' ||
      event.type === 'error' ||
      event.type === 'thread_deleted' ||
      event.type === 'thread_created' ||
      event.type === 'summary_updated' ||
      event.type === 'project_changed' ||
      event.type === 'cwd_changed' ||
      event.type === 'agent_runs_changed' ||
      event.type === 'status_tags';
    if (isStateChange) {
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

  private setActiveRow(threadId: string): void {
    // Remove active class from previous row
    if (this.activeThreadId) {
      this.rowEls.get(this.activeThreadId)?.removeClass('ct-agents-row-active');
    }
    this.activeThreadId = threadId;
    this.rowEls.get(threadId)?.addClass('ct-agents-row-active');
  }

  /** New-conversation mode: no thread is active, so no row should look selected. */
  private clearActiveRow(): void {
    if (this.activeThreadId) {
      this.rowEls.get(this.activeThreadId)?.removeClass('ct-agents-row-active');
    }
    this.activeThreadId = null;
  }

  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    setTimeout(() => {
      this.renderPending = false;
      this.render();
    }, 0);
  }

  private scheduleActivityRefresh(threadId: string): void {
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      const el = this.activityEls.get(threadId);
      // Keep the activity line updating from subagent/workflow progress even
      // after the outer turn's own isRunning() has gone false — onTaskProgress
      // writes into threadActivity regardless of foreground/background state.
      if (el && (this.manager.isRunning(threadId) || this.manager.hasActiveBackgroundTasks(threadId))) {
        const thread = this.manager.getThread(threadId);
        if (thread) el.setText(this.getActivityText(thread, 'running'));
      }
    }, 800);
  }

  render(): void {
    this.listEl.empty();
    this.activityEls.clear();
    this.timeEls.clear();
    this.rowEls.clear();

    const q = this.searchQuery;
    const allThreads = this.manager.getThreads().filter(isDashboardThread);
    const threads = q
      ? allThreads.filter(t =>
          t.title.toLowerCase().includes(q) ||
          (t.summary ?? '').toLowerCase().includes(q) ||
          (t.recap ?? '').toLowerCase().includes(q) ||
          this.manager.getAgentRuns(t.id).some(agent =>
            `${agent.role ?? ''} ${agent.description} ${agent.currentActivity ?? ''}`.toLowerCase().includes(q)
          )
        )
      : allThreads;
    if (threads.length === 0) {
      const emptyEl = this.listEl.createDiv('ct-agents-empty');
      if (q) {
        emptyEl.createDiv({ text: 'No threads match your search.' });
      } else {
        emptyEl.createDiv({ text: 'No threads yet.' });
        emptyEl.createDiv({ cls: 'ct-agents-empty-sub', text: 'Use New thread above to start a task.' });
      }
    }

    const mode = this.currentGroupMode();
    const archived = this.plugin.settings.agentsShowArchived
      ? filterArchivedThreads(this.archivedThreads, new Set(allThreads.map(t => t.id)), q)
      : [];
    if (mode === 'status') {
      for (const section of this.statusSections(threads)) {
        if (!section.threads.length) continue;
        this.renderGroup(
          section.label,
          section.threads,
          section.state,
          section.label === 'New' ? section.threads.length : undefined,
          this.listEl,
          'global',
        ).addClass('ct-agents-status-section');
      }
      this.renderArchivedGroup(this.listEl, 'global', archived);
    } else {
      const archivedKeys = new Map<string, Thread[]>();
      for (const group of groupDashboardThreads(archived, thread => this.threadGroup(thread))) archivedKeys.set(group.key, group.threads);
      const liveGroups = groupDashboardThreads(threads, thread => this.threadGroup(thread));
      const projects = [...liveGroups];
      // Projects whose only threads are archived still need a header to hang the Archived group on.
      for (const group of groupDashboardThreads(archived, thread => this.threadGroup(thread))) {
        if (!liveGroups.some(live => live.key === group.key)) projects.push({ ...group, threads: [] });
      }
      projects.sort((a, b) => a.key === 'unassigned' ? 1 : b.key === 'unassigned' ? -1 : a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key));
      for (const project of projects) {
        const projectEl = this.listEl.createEl('section', { cls: 'ct-agents-project', attr: { 'aria-label': project.label } });
        const header = projectEl.createDiv('ct-agents-project-header');
        const icon = header.createSpan('ct-agents-project-icon');
        setIcon(icon, project.key === 'unassigned' ? 'folder-minus' : 'folder');
        header.createSpan({ cls: 'ct-agents-project-name', text: project.label });
        header.createSpan({ cls: 'ct-agents-project-count', text: String(project.threads.length) });
        const projectCollapsed = this.bindGroupToggle(header, `project:${project.key}`);
        if (projectCollapsed) continue;
        if (mode === 'project-status') this.renderProjectStatuses(projectEl, project.key, project.threads);
        else this.renderProjectThreads(projectEl, project.key, project.threads);
        this.renderArchivedGroup(projectEl, project.key, archivedKeys.get(project.key) ?? []);
      }
    }

    this.updateDisplayedThreadCount(threads.length);
  }

  private statusSections(threads: Thread[]): Array<{ label: string; threads: Thread[]; state: RowState }> {
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
    return [
      { label: 'Working', threads: [...buckets.running, ...buckets.awaiting].sort(byRecency), state: 'running' },
      { label: 'Waiting', threads: buckets.waiting.sort(byRecency), state: 'waiting' },
      { label: 'New', threads: buckets['idle-new'].sort(byRecency), state: 'idle' },
      { label: 'Reviewed', threads: buckets['idle-reviewed'].sort(byRecency), state: 'idle' },
      { label: 'Failed', threads: buckets.error.sort(byRecency), state: 'error' },
      { label: 'Ready', threads: buckets.empty.sort(byRecency), state: 'empty' },
    ];
  }

  private renderProjectStatuses(parent: HTMLElement, projectKey: string, threads: Thread[]): void {
    for (const section of this.statusSections(threads)) {
      if (!section.threads.length) continue;
      this.renderGroup(section.label, section.threads, section.state, section.label === 'New' ? section.threads.length : undefined, parent, projectKey);
    }
  }

  private renderProjectThreads(parent: HTMLElement, projectKey: string, threads: Thread[]): void {
    const items: Array<
      | { kind: 'thread'; thread: Thread; state: RowState; updatedAt: number }
      | { kind: 'stack'; stack: ScheduledStack; updatedAt: number; scopeKey: string }
    > = [];
    for (const section of this.statusSections(threads)) {
      const stackable = (section.label === 'New' || section.label === 'Reviewed' || section.label === 'Ready')
        && (this.plugin.settings.stackScheduledThreads ?? true);
      const partitioned = stackable ? partitionScheduledStacks(section.threads, 1) : { stacks: [], standalone: section.threads };
      items.push(...partitioned.standalone.map(thread => ({ kind: 'thread' as const, thread, state: section.state, updatedAt: thread.updatedAt })));
      items.push(...partitioned.stacks.map(stack => ({ kind: 'stack' as const, stack, updatedAt: stack.threads[0].updatedAt, scopeKey: `${projectKey}:${section.label}` })));
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const item of items) {
      if (item.kind === 'thread') this.renderRow(item.thread, item.state, parent);
      else this.renderScheduledJobRow(item.stack, parent, item.scopeKey);
    }
  }

  /**
   * Renders one collapsed-by-default row for a scheduled job's quiet runs:
   * job name, run count, latest-run relative time, and a chevron that
   * expands into one normal `renderRow()` per underlying thread.
   */
  private renderScheduledJobRow(stack: ScheduledStack, parent: HTMLElement, scopeKey = ''): void {
    const key = `${scopeKey}:${stack.scheduledItemId}`;
    const expanded = this.expandedScheduledStacks.has(key);

    const row = parent.createDiv('ct-agents-row ct-agents-row-scheduled-stack');
    const iconEl = row.createDiv('ct-agents-icon ct-agents-icon-scheduled');
    setIcon(iconEl, 'clock');

    const body = row.createDiv('ct-agents-row-body');
    const primary = body.createDiv('ct-agents-row-primary');
    const titleRow = primary.createDiv('ct-agents-stack-title-row');
    const titleEl = titleRow.createDiv('ct-agents-row-title');
    titleEl.createSpan({ cls: 'ct-agents-row-title-text', text: stack.scheduledItemName });
    titleRow.createSpan({ cls: 'ct-agents-group-badge ct-agents-stack-count', text: `×${stack.threads.length}` });
    primary.createDiv({ cls: 'ct-agents-row-time', text: relativeTime(stack.threads[0].updatedAt) });
    const secondary = body.createDiv('ct-agents-row-secondary');
    secondary.createDiv({ cls: 'ct-agents-row-activity', text: `Last run ${relativeTime(stack.threads[0].updatedAt)}` });

    const chevron = row.createDiv('ct-expand-btn');
    setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.expandedScheduledStacks.has(key)) this.expandedScheduledStacks.delete(key);
      else this.expandedScheduledStacks.add(key);
      this.scheduleRender();
    });

    // Safe to attach to the row itself: expanded children go into a SIBLING
    // div below, never inside `row` (unlike Kanban's nested stack card).
    attachStackArchiveMenu(row, stack.scheduledItemId, stack.threads.map(t => t.id), this.archiveMenuDeps());

    if (expanded) {
      const nested = parent.createDiv('ct-agents-stack-body');
      for (const thread of stack.threads) {
        this.renderRow(thread, thread.messages.length === 0 ? 'empty' : 'idle', nested);
      }
    }
  }

  /** Makes `header` a click/keyboard toggle for a collapsible group; returns whether it is collapsed. */
  private bindGroupToggle(header: HTMLElement, key: string, defaultCollapsed = false): boolean {
    const set = defaultCollapsed ? this.expandedArchivedGroups : this.collapsedGroups;
    const collapsed = defaultCollapsed ? !set.has(key) : set.has(key);
    header.addClass('ct-agents-collapsible');
    header.toggleClass('is-collapsed', collapsed);
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', String(!collapsed));
    const chevron = header.createSpan({ cls: 'ct-agents-group-chevron' });
    setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
    header.prepend(chevron);
    const toggle = () => {
      if (set.has(key)) set.delete(key);
      else set.add(key);
      this.scheduleRender();
    };
    header.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    return collapsed;
  }

  private renderArchivedGroup(parent: HTMLElement, scopeKey: string, threads: Thread[]): void {
    if (!threads.length) return;
    const group = parent.createDiv('ct-agents-group ct-agents-archived-group');
    const labelEl = group.createDiv('ct-agents-group-label');
    labelEl.createSpan({ text: 'Archived' });
    labelEl.createSpan({ cls: 'ct-agents-project-count', text: String(threads.length) });
    if (this.bindGroupToggle(labelEl, `archived:${scopeKey}`, true)) return;
    for (const thread of threads) this.renderArchivedRow(thread, group);
  }

  private renderArchivedRow(thread: Thread, parent: HTMLElement): void {
    const row = parent.createDiv({ cls: 'ct-agents-row ct-agents-row-archived', attr: { role: 'button', tabindex: '0', 'aria-label': `Restore ${thread.title}` } });
    const iconEl = row.createDiv('ct-agents-icon ct-agents-icon-archived');
    setIcon(iconEl, 'archive');
    const body = row.createDiv('ct-agents-row-body');
    const primary = body.createDiv('ct-agents-row-primary');
    primary.createDiv('ct-agents-row-title').createSpan({ cls: 'ct-agents-row-title-text', text: thread.title });
    primary.createDiv({ cls: 'ct-agents-row-time', text: relativeTime(thread.updatedAt) });
    const summary = thread.summary ?? thread.recap;
    if (summary) body.createDiv('ct-agents-row-secondary').createDiv({ cls: 'ct-agents-row-activity', text: summary });
    const restore = row.createEl('button', { cls: 'ct-agents-restore-btn', text: 'Restore', attr: { title: 'Restore this thread' } });
    const run = async () => {
      this.archivedThreads = this.archivedThreads.filter(t => t.id !== thread.id);
      this.scheduleRender();
      try {
        await this.plugin.restoreArchivedThread(thread);
      } catch (error) {
        console.error('[ClaudeThreads] Failed to restore archived thread:', error);
        new Notice('Could not restore that thread.');
        await this.refreshArchivedThreads();
      }
    };
    restore.addEventListener('click', (e) => { e.stopPropagation(); void run(); });
    row.addEventListener('click', () => void run());
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void run(); } });
  }

  private renderGroup(label: string, threads: Thread[], state: RowState, badge?: number, parent = this.listEl, scopeKey = ''): HTMLElement {
    const group = parent.createDiv('ct-agents-group');
    const labelEl = group.createDiv('ct-agents-group-label');
    labelEl.createSpan({ text: label });
    if (badge !== undefined) {
      labelEl.createSpan({ cls: 'ct-agents-group-badge', text: String(badge) });
    }
    if (this.bindGroupToggle(labelEl, `status:${scopeKey}:${label}`)) {
      labelEl.createSpan({ cls: 'ct-agents-project-count', text: String(threads.length) });
      return group;
    }
    const stackable = (label === 'New' || label === 'Reviewed' || label === 'Ready')
      && (this.plugin.settings.stackScheduledThreads ?? true);
    // Preserve the dashboard's historical minCount=1 behavior: even a single
    // quiet run appears as a job rollup, now scoped to its project/status.
    const partitioned = stackable ? partitionScheduledStacks(threads, 1) : { stacks: [], standalone: threads };
    const items = [
      ...partitioned.standalone.map(thread => ({ kind: 'thread' as const, thread, updatedAt: thread.updatedAt })),
      ...partitioned.stacks.map(stack => ({ kind: 'stack' as const, stack, updatedAt: stack.threads[0].updatedAt })),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const item of items) {
      if (item.kind === 'thread') this.renderRow(item.thread, state, group);
      else this.renderScheduledJobRow(item.stack, group, `${scopeKey}:${label}`);
    }
    return group;
  }

  private renderRow(thread: Thread, state: RowState, parent: HTMLElement): void {
    const isActive = thread.id === this.activeThreadId;
    const isUnreviewed = state === 'idle' && !thread.reviewed;
    const hasPermission = this.manager.hasPendingPermission(thread.id);
    const hasQuestion = this.manager.hasPendingQuestion(thread.id);
    const hasPlan = this.manager.hasPendingPlan(thread.id);
    const hasPending = state === 'running' && (hasPermission || hasQuestion || hasPlan);
    const attentionClass = hasPlan ? ' ct-agents-row-plan' : hasQuestion ? ' ct-agents-row-question' : '';
    const row = parent.createDiv({
      cls: `ct-agents-row ct-agents-row-${state}${isActive ? ' ct-agents-row-active' : ''}${isUnreviewed ? ' ct-agents-row-unreviewed' : ''}${hasPending ? ' ct-agents-row-permission' : ''}${attentionClass}`,
    });
    this.rowEls.set(thread.id, row);
    row.toggleClass('ct-stale', this.manager.isRunStale(thread.id));

    const iconEl = row.createDiv('ct-agents-icon');
    if (hasPending) {
      iconEl.addClass('ct-agents-icon-permission');
      iconEl.setText('?');
    } else {
      this.applyStateIcon(iconEl, state);
    }

    const body = row.createDiv('ct-agents-row-body');
    const primary = body.createDiv('ct-agents-row-primary');
    const titleEl = primary.createDiv('ct-agents-row-title');
    titleEl.createSpan({ cls: 'ct-agents-row-title-text', text: thread.title });
    appendOrchestratorBadge(titleEl, thread.id, this.plugin.settings.orchestratorThreadId, thread.projectId ? this.manager.getProject(thread.projectId)?.orchestratorThreadId : undefined);
    const timeEl = primary.createDiv({ cls: 'ct-agents-row-time', text: relativeTime(thread.updatedAt) });
    this.timeEls.set(thread.id, timeEl);

    const secondary = body.createDiv('ct-agents-row-secondary');
    const activityEl = secondary.createDiv({ cls: 'ct-agents-row-activity' });
    this.activityEls.set(thread.id, activityEl);

    if (hasPending) {
      const pendingInfo = this.manager.getPendingPermission(thread.id);
      const attentionLabel = hasPlan ? 'Plan ready — open to review' : hasQuestion ? 'Question ready — open to answer' : pendingInfo?.toolName ? formatToolName(pendingInfo.toolName) : 'Permission required';
      activityEl.createSpan({ cls: 'ct-agents-permission-tool', text: attentionLabel });
      if (pendingInfo?.detail) {
        activityEl.createSpan({ cls: 'ct-agents-permission-detail', text: summarizePermissionDetail(pendingInfo.detail) });
      }

      if (hasPermission) {
        const btns = body.createDiv({ cls: 'ct-agents-permission-actions' });

        const deny = btns.createEl('button', { text: 'Deny', cls: 'ct-permission-btn ct-permission-deny' });
        deny.addEventListener('click', (e) => { e.stopPropagation(); this.manager.resolvePermission(thread.id, false); });

        const allow = btns.createEl('button', { text: !!pendingInfo && isHostExecPermission(pendingInfo.toolName) ? 'Allow once' : 'Allow', cls: 'ct-permission-btn ct-permission-allow' });
        allow.addEventListener('click', (e) => { e.stopPropagation(); this.manager.resolvePermission(thread.id, true); });

        const hostExecPrefix = hostExecAlwaysAllowOffer(pendingInfo, hostExecState(this.plugin.managedPolicy.peek()).allowAlways);
        if (hostExecPrefix) {
          const alwaysPrefix = btns.createEl('button', { text: `Always allow \`${hostExecPrefix}\``, cls: 'ct-permission-btn ct-permission-always' });
          alwaysPrefix.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (addHostExecPrefix(this.plugin.settings, hostExecPrefix)) await this.plugin.saveSettings();
            this.manager.resolvePermission(thread.id, true);
          });
        }

        if (!pendingInfo || canAlwaysAllow(pendingInfo.toolName)) {
          const always = btns.createEl('button', { text: 'Always Allow', cls: 'ct-permission-btn ct-permission-always' });
          always.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (pendingInfo) {
              if (recordAlwaysAllow(this.plugin.settings, pendingInfo.toolName, this.manager.getRemoteScope(thread.id))) await this.plugin.saveSettings();
            }
            this.manager.resolvePermission(thread.id, true);
          });
        }
      }
    } else {
      activityEl.setText(this.getActivityText(thread, state));

      // ── Scheduled wake-up: show a Cancel button ──────────────────────────
      if (state === 'waiting') {
        const btns = body.createDiv({ cls: 'ct-agents-wakeup-actions' });
        const cancel = btns.createEl('button', { text: 'Cancel', cls: 'ct-permission-btn ct-wakeup-cancel' });
        cancel.addEventListener('click', (e) => {
          e.stopPropagation();
          this.plugin.cancelWakeups(thread.id);
        });
      }

      // ── AWS SSO reauth button ────────────────────────────────────────────
      // When the session failed due to an expired SSO token, show a one-click
      // "Re-authenticate" button so the user doesn't have to leave Obsidian.
      if (state === 'error' && isAwsSsoError(thread.lastError)) {
        renderAwsReauthButton(body, this.plugin.settings, thread.lastError, { stopPropagation: true });
      }
    }

    if (this.currentGroupMode() === 'status') {
      secondary.createDiv({ cls: 'ct-agents-row-project', text: this.threadGroup(thread).label });
    } else if (thread.cwd) {
      secondary.createDiv({ cls: 'ct-agents-row-cwd', text: threadCwdLabel(thread, () => buildCwdLabel(thread.cwd, this.plugin.manager.vaultRoot), (id) => this.plugin.daemonRegistry?.nameOf(id) ?? id) });
    }

    const agentRuns = this.manager.getAgentRuns(thread.id);
    if (agentRuns.length) {
      const hasActiveAgent = agentRuns.some(run => ACTIVE_AGENT_STATUSES.has(run.status));
      const button = secondary.createEl('button', {
        cls: `ct-dashboard-agent-count${hasActiveAgent ? ' ct-agent-count-active' : ''}`,
        attr: { 'aria-label': `Open ${agentRuns.length} agent${agentRuns.length === 1 ? '' : 's'} in ${thread.title}` },
      });
      const icon = button.createSpan({ cls: 'ct-dashboard-agent-count-icon' });
      setIcon(icon, 'users');
      button.createSpan({ text: `${agentRuns.length} agent${agentRuns.length === 1 ? '' : 's'}` });
      button.addEventListener('click', e => {
        e.stopPropagation();
        void this.plugin.openAgentTeamInChatView(thread.id);
      });
    }

    row.addEventListener('click', () => {
      if (state === 'idle' && !thread.reviewed) this.markReviewed(thread.id);
      this.plugin.openThreadInChatView(thread.id);
    });

    attachThreadArchiveMenu(row, thread.id, this.archiveMenuDeps());
  }

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

  /** Resolve the same stable project/repository identity used by Kanban grouping. */
  private threadGroup(thread: Thread): { key: string; label: string } {
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
      if (matchingProject) return { key: `project:${matchingProject.id}`, label: matchingProject.name };
      const repo = resolveThreadProjectName(thread);
      if (repo) {
        if (!thread.originRepoPath && thread.projectNameOverride && !resolveGitRepoRoot(thread.cwd)) {
          const prRepo = parsePrUrlRepo(thread.prUrl);
          if (prRepo) return { key: `github:${prRepo.owner.toLowerCase()}/${prRepo.repo.toLowerCase()}`, label: repo };
        }
        return { key: `cwd:${threadRoot}`, label: repo };
      }
      const label = buildCwdLabel(thread.cwd, this.manager.vaultRoot);
      if (label) return { key: `cwd:${threadRoot}`, label };
    }
    return { key: 'unassigned', label: 'Unassigned' };
  }

  private applyStateIcon(el: HTMLElement, state: RowState): void {
    el.className = `ct-agents-icon ct-agents-icon-${state}`;
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
    // Summary is shown in its own element above; fall back to last message preview
    const lastAssistant = [...thread.messages].reverse().find(m => m.role === 'assistant');
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
    // Keep waiting-row countdowns roughly current without a full re-render.
    for (const [id, el] of this.activityEls) {
      if (!this.manager.isRunning(id) && this.plugin.hasPendingWakeup(id)) {
        const thread = this.manager.getThread(id);
        if (thread) el.setText(this.getActivityText(thread, 'waiting'));
      }
    }
  }

  private updateDisplayedThreadCount(total: number): void {
    if (this.displayedThreadCount === total) return;
    this.displayedThreadCount = total;
    (this.leaf as WorkspaceLeaf & { updateHeader(): void }).updateHeader();
  }

  private markReviewed(id: string): void {
    const thread = this.manager.getThread(id);
    if (!thread) return;
    thread.reviewed = true;
    this.plugin.saveSettings();
    this.scheduleRender();
  }

  /** Open the most recently completed unreviewed thread and mark it reviewed.
   *  Can be called repeatedly to triage through the queue. */
  public jumpToLatestUnreviewed(): void {
    const candidate = this.manager.getThreads()
      .filter(t => isDashboardThread(t) && !this.manager.isRunning(t.id) && !t.lastError && t.messages.length > 0 && !t.reviewed)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (!candidate) {
      new Notice('No unreviewed completed agents');
      return;
    }
    this.markReviewed(candidate.id);
    this.plugin.openThreadInChatView(candidate.id);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  private toggleSearch(): void {
    if (this.searchBarEl.hasClass('ct-hidden')) {
      this.searchBarEl.removeClass('ct-hidden');
      this.searchActionEl?.setAttribute('aria-expanded', 'true');
      this.searchInputEl.focus();
    } else {
      this.closeSearch();
    }
  }

  private closeSearch(): void {
    this.searchBarEl.addClass('ct-hidden');
    this.searchQuery = '';
    this.searchInputEl.value = '';
    this.searchActionEl?.setAttribute('aria-expanded', 'false');
    this.render();
  }

}
