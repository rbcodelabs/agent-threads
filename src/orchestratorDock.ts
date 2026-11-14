/**
 * orchestratorDock.ts
 *
 * The OrchestratorDock: an "Ask the orchestrator" field, an orb whose ring spins
 * while work runs, and a needs-you dot. Host-agnostic (it mounts into whatever
 * element it is given and talks to the world only through `OrchestratorDockDeps`),
 * so the Agent Board's floating pill is host #1 and a list-view dock can reuse it.
 *
 * State comes from orchestratorDockModel; this class owns the pill DOM, the subscriptions and the
 * controller logic for the reply sheet (orchestratorDockSheet.ts is its presentation): sheet open
 * state, the streaming buffer, the coalesced-message set, unread + peek, suggestion chips, Stop.
 */
import { Notice, Platform, setIcon } from 'obsidian';
import type { ThreadManager } from './ThreadManager';
import type { Thread } from './types';
import type { ConnectionState } from './remote/DaemonClient';
import { liveRowFlags } from './threadRowState';
import { threadNeedsInput } from './needsInput';
import {
  attentionItems,
  deriveDockState,
  needsYouCount,
  suggestionChips,
  tooltipText,
  unreadState,
  type AttentionCandidate,
  type AttentionItem,
  type DockState,
  type SuggestionChip,
} from './orchestratorDockModel';
import { capTranscript, peekLine, sheetBlock, sheetTranscript } from './dockSheetModel';
import { createDockMessageEnv, type DockMessageHostDeps } from './dockMessageEnv';
import { InputHistory } from './dockInputHistory';
import { createDraftStore, MAX_DRAFT_CHARS, type DraftStore } from './dockDraftStore';
import { KeyboardInsetTracker } from './dockKeyboardInset';
import { DockSheet, type SheetView } from './orchestratorDockSheet';
import { DockTray, type TrayEntry } from './orchestratorDockTray';
import { trayItems } from './dockTrayModel';
import type { PermissionButtonDeps } from './permissionCard';

export type DockMode = 'pill' | 'orb';

/** Under this host width the pill collapses to the orb (+ dot). */
export const DOCK_ORB_BREAKPOINT = 640;

/** A width of 0 means "not measured yet" (first layout, jsdom): stay a pill. */
export function dockModeForWidth(width: number): DockMode {
  return width > 0 && width < DOCK_ORB_BREAKPOINT ? 'orb' : 'pill';
}

export interface OrchestratorDockDeps {
  manager: Pick<ThreadManager,
    'getThread' | 'isRunning' | 'hasPendingPermission' | 'hasPendingQuestion' | 'hasPendingPlan'
    | 'hasActiveBackgroundTasks' | 'sendMessage' | 'subscribe' | 'interrupt' | 'getQueuedMessages'
    | 'removeQueuedMessageAt' | 'getThreadActivity' | 'getPendingPermission' | 'resolvePermission' | 'getRemoteScope'>;
  /** Board threads (the host applies its own filter, e.g. isKanbanThread): the source of total/running/attention. */
  listThreads(): Thread[];
  hasPendingWakeup(threadId: string): boolean;
  getOrchestratorThreadId(): string | undefined;
  /** plugin.ensureOrchestratorThread(false): creates the thread WITHOUT opening it. */
  ensureOrchestrator(): Promise<void>;
  /** plugin.openThreadInChatView */
  openThread(threadId: string): void | Promise<void>;
  /**
   * Opens a `[[note]]` / vault link from an orchestrator reply (never the board's own leaf, an unresolved link opens
   * nothing: dockLinkOpener). Absent: those links do nothing when clicked.
   */
  openLink?(href: string): void;
  /**
   * What the shared message renderer needs from the app so the sheet renders a conversation like the main panel (opening
   * URLs, bridges, vault probe, clock, tool-call style). Absent: inert defaults (no URL opener, no bridges, no vault files).
   */
  messageHost?: DockMessageHostDeps;
  /** Source for an attached / tool-result image: a vault resource URL when it has a path, else a data URL. Absent: data URLs. */
  imageSrc?(ref: { path?: string; mediaType: string }, inlineData: string | undefined): string;
  /**
   * Highlights a thread's card on the board while its `[[thread:...]]` link is hovered / focused in the sheet. Returns
   * false when the thread has no card (archived, filtered out): then nothing happens. Absent: links do not highlight.
   */
  focusCard?(threadId: string, opts: { scroll: boolean; flash: boolean }): boolean;
  /** Removes that highlight (leave, blur, sheet close, destroy). */
  clearCardFocus?(): void;
  /**
   * What the tray's permission buttons need (the board card's own deps). Absent: a permission card hands off to its
   * thread instead of offering buttons.
   */
  permissionCard?: Omit<PermissionButtonDeps, 'manager' | 'hostExecAllowAlways'> & { hostExecAllowAlways(): boolean };
  mode(): DockMode;
  /**
   * Where the Ask field's draft lives (IN MEMORY ONLY, see dockDraftStore). The host passes a long-lived one so a board
   * re-mount keeps the draft; absent: private to this dock instance.
   */
  drafts?: DraftStore;
  /** Absent (or null) means local-only: the orchestrator can then never be offline. */
  daemons?: {
    stateOf(daemonId: string): ConnectionState | undefined;
    onState(listener: (daemonId: string, state: ConnectionState) => void): () => void;
    reconnect(daemonId: string): void;
  } | null;
}

type BodyKind = 'input' | 'none' | 'offline' | 'error';

/**
 * The ONLY manager events that re-derive the dock. An allowlist (not a blocklist) so a new high-frequency
 * event can never silently turn into a per-token refresh. Mirrors what KanbanView re-renders on, plus the
 * connection/auth events deriveDockState reads through thread.lastError / status.
 */
const REFRESH_EVENTS: ReadonlySet<string> = new Set([
  'done', 'interrupted', 'error', 'reconnecting', 'auth_retry', 'streaming_start', 'run_state_settled',
  'permission_request', 'permission_resolved', 'pending_question_changed', 'pending_plan_changed',
  'plan_ready', 'question_ready', 'proposed_reply_changed', 'pending_decisions_changed',
  'thread_created', 'thread_deleted', 'threads_loaded', 'projects_changed', 'wakeup_changed',
  'reviewed_changed', 'status_tags', 'summary_updated', 'agent_runs_changed', 'task_notification',
  'background_tasks_pending', 'user_message_added', 'message',
  // A remote thread's turnInFlight / queue flipped: isRunning() (ring, working) can change with no paired done/streaming_start.
  'remote_pending_changed',
]);

/** Orchestrator-thread events that only change the sheet (not the board-wide dock state). */
const SHEET_EVENTS: ReadonlySet<string> = new Set(['queued', 'dequeued', 'tool_use', 'tool_progress', 'status', 'stream_reset']);

const PEEK_MS = 8000;
/** The reason wraps (P2 D1), so only a stack-trace-sized error is cut; the full text is in the tooltip. */
const MAX_ERROR_CHARS = 120;
/** 4 lines at 20px with NO vertical padding on the scroller (scrolled text shows through padding): a long draft clips on a line boundary. */
const MAX_INPUT_PX = 80;
/** The error / offline announcement is one short sentence; a stack trace is cut. */
const MAX_ANNOUNCE_CHARS = 160;
/** The numeric badge on the narrow attention dot: more than this shows `9+`. */
const MAX_BADGE = 9;
/** The pill's offset from the view bottom (styles.css --ct-kanban-pill-bottom), and the smaller gap it keeps above a keyboard. */
export const PILL_BOTTOM_PX = 36; // keep equal to --ct-kanban-pill-bottom in styles.css (orchestrator-dock-polish.test.ts checks)
const PILL_BOTTOM_KBD_PX = 8;
/** A recovery is announced only once it has held this long. */
export const RECOVERY_DEBOUNCE_MS = 1000;
type Health = 'ok' | 'error' | 'offline' | 'none';

export class OrchestratorDock {
  private rootEl: HTMLElement | null = null;
  /** Narrow-mode status row: sits immediately BEFORE the host (above the orb / New row) while none/error/offline. */
  private statusEl: HTMLElement | null = null;
  private fieldEl!: HTMLElement;
  private orbEl!: HTMLButtonElement;
  private bodyEl!: HTMLElement;
  private dotEl!: HTMLElement;
  private inputEl: HTMLTextAreaElement | null = null;
  private actionEl: HTMLButtonElement | null = null;
  private reasonEl: HTMLElement | null = null;
  private stopEl: HTMLButtonElement | null = null;
  private sendEl: HTMLButtonElement | null = null;
  private sheet: DockSheet | null = null;
  private tray: DockTray | null = null;
  private peekEl: HTMLElement | null = null;
  private peekTextEl: HTMLElement | null = null;
  private chipsEl: HTMLElement | null = null;
  private peekTimer: ReturnType<typeof setTimeout> | null = null;
  /** Persistent visually hidden polite status for error / offline / recovered (separate from the sheet's and the tray's regions). */
  private stateLiveEl: HTMLElement | null = null;
  private stateLiveTimer: ReturnType<typeof setTimeout> | null = null;
  /** null until the first refresh: what is already true at mount is not news. */
  private health: Health | null = null;
  private summaryText = '';
  private keyboard: KeyboardInsetTracker | null = null;
  private keyboardPx = 0;
  /** The inset as visualViewport reports it, before the pill-mode clamp. */
  private keyboardRaw = 0;
  /** Sends that failed after the orchestrator was swapped: their text, per orchestrator id, comes back if the user returns. */
  private readonly lostSends = new Map<string, string>();
  private keyboardRoot: HTMLElement | null = null;
  private readonly history = new InputHistory();
  private readonly drafts: DraftStore;
  /** The store version after this dock's last read / write: a different version means another dock changed the draft since. */
  private syncedVersion = 0;
  /** The draft key (orchestrator id) the current textarea was built for. */
  private inputKey = '';
  /** Caret position the dock itself set after the last recall (a freshly recalled single line keeps walking history). */
  private recallCaret = -1;
  /** Last health announced as a problem ('error' / 'offline'), or 'ok'. A recovery is announced only after one. */
  private announced: Health | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The announcement waiting to be written is a problem report (error / offline) that can still be withdrawn. */
  private pendingProblem = false;

  /** Orchestrator id the per-thread state below belongs to; a change resets it. */
  private trackedId: string | undefined;
  /** The last defined orchestrator id seen (survives the thread being deleted, so a re-setup with a NEW id is a swap). */
  private lastOrchestratorId: string | undefined;
  private streamBuf = '';
  /** Partial reply of an interrupted turn. The manager does not persist it (onInterrupted only rolls user messages back). */
  private stoppedText = '';
  /** A13: set when our own message was echoed (user_message_added) while its send was still pending. */
  private sendEcho = false;
  /** Stop was clicked and not yet accounted for; with the snapshot of what was streaming at that moment. */
  private stopRequested = false;
  private stopSnapshot = '';
  private sendingText = '';
  private txCache: { ref: unknown; len: number; lastId: string | undefined; lastLen: number; lastTools: number; entries: ReturnType<typeof sheetTranscript> } | null = null;
  /** User message ids that landed while a turn was running (coalesced into it): "Sent, will be picked up". */
  private readonly pickupIds = new Set<string>();
  /** Latest assistant message id the user has seen; per dock instance, seeded when the thread is first seen. */
  private lastSeenId: string | undefined;
  private seeded = false;
  private stopping = false;
  private attention: AttentionItem[] = [];
  private trayEntries: TrayEntry[] = [];

  private bodyKind: BodyKind | null = null;
  private state: DockState = 'none';
  private currentMode: DockMode = 'pill';
  private sending = false;
  private settingUp = false;
  private destroyed = false;
  private unsubscribeManager: (() => void) | null = null;
  private unsubscribeDaemons: (() => void) | null = null;

  constructor(private readonly host: HTMLElement, private readonly deps: OrchestratorDockDeps) {
    this.drafts = deps.drafts ?? createDraftStore();
  }

  /** Write-through: every change reaches the (in-memory) store, so a re-mounted dock starts from it. */
  private get draft(): string { return this.drafts.get(this.draftKey); }
  private set draft(text: string) {
    if (text) this.drafts.set(text, this.draftKey); else this.drafts.clear();
    this.syncedVersion = this.drafts.version;
  }
  /** The draft belongs to one orchestrator thread: a swapped / re-set-up orchestrator never reads it. */
  private get draftKey(): string { return this.deps.getOrchestratorThreadId() ?? ''; }

  mount(): void {
    if (this.rootEl) return;
    const root = this.host.createDiv({ cls: 'ct-orch-dock', attr: { 'data-testid': 'orchestrator-dock' } });
    // First element of the host: the field leads the pill (design decision 1).
    this.host.prepend(root);
    this.rootEl = root;

    this.fieldEl = root.createDiv('ct-orch-field');
    this.orbEl = this.fieldEl.createEl('button', {
      cls: 'ct-orch-orb',
      attr: { type: 'button', 'aria-label': 'Ask the portfolio orchestrator', 'data-testid': 'orchestrator-orb' },
    });
    this.orbEl.createSpan('ct-orch-orb-ring');
    const core = this.orbEl.createSpan('ct-orch-orb-core');
    core.setAttribute('aria-hidden', 'true');
    setIcon(core, 'sparkles');
    this.orbEl.addEventListener('click', () => this.onOrbClick());
    this.bodyEl = this.fieldEl.createDiv('ct-orch-body');

    const status = this.host.ownerDocument.createElement('div');
    status.className = 'ct-orch-status';
    status.dataset.testid = 'orchestrator-status';
    status.hidden = true;
    if (this.host.parentNode) this.host.before(status); else root.prepend(status);
    this.statusEl = status;

    this.dotEl = root.createSpan({ cls: 'ct-orch-dot', attr: { role: 'img', 'data-testid': 'orchestrator-dot' } });
    // In the dock root (always rendered), not in the sheet: a closed sheet is `hidden` and would never announce.
    this.stateLiveEl = root.createDiv({ cls: 'ct-orch-state-live', attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'data-testid': 'orchestrator-state-live' } });

    this.mountSheetParts();
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229 || !this.sheet?.isOpen) return; // Escape cancels an IME composition
      e.stopPropagation();
      this.closeSheet();
    });

    this.unsubscribeManager = this.deps.manager.subscribe((threadId, event) => {
      const id = this.deps.getOrchestratorThreadId();
      if (id && threadId === id) this.onOrchestratorEvent(event as { type: string; [k: string]: unknown });
      if (REFRESH_EVENTS.has(event.type)) this.refresh();
      else if (id && threadId === id && SHEET_EVENTS.has(event.type)) this.renderSheet();
    });
    this.unsubscribeDaemons = this.deps.daemons?.onState(() => this.refresh()) ?? null;
    this.refresh();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeManager?.();
    this.unsubscribeDaemons?.();
    this.unsubscribeManager = null;
    this.unsubscribeDaemons = null;
    if (this.peekTimer) clearTimeout(this.peekTimer);
    this.peekTimer = null;
    if (this.stateLiveTimer) clearTimeout(this.stateLiveTimer);
    this.stateLiveTimer = null;
    this.cancelRecovery();
    this.stopKeyboardTracking();
    this.keyboard = null;
    this.history.clear();
    this.host.parentElement?.classList.remove('ct-orch-pill-mode', 'ct-orch-kbd-up');
    this.tray?.destroy();
    this.tray = null;
    this.sheet?.destroy();
    this.peekEl?.remove();
    this.chipsEl?.remove();
    this.sheet = this.peekEl = this.chipsEl = this.peekTextEl = null;
    this.stopEl = this.sendEl = null;
    this.rootEl?.remove();
    this.statusEl?.remove();
    this.rootEl = null;
    this.stateLiveEl = null;
    this.statusEl = null;
    this.inputEl = null;
    this.actionEl = null;
    this.reasonEl = null;
  }

  /** Re-read the layout mode (the host calls this when its width changes). */
  relayout(): void {
    this.refresh();
  }

  /** Cmd+J target. Safe to call when already focused. */
  focusField(): void {
    if (this.destroyed || !this.rootEl) return;
    if (this.currentMode === 'orb') { void this.openOrSetUp(); return; }
    const input = this.inputEl;
    if (input && input.ownerDocument.activeElement === input) { input.select(); return; }
    (input ?? this.actionEl)?.focus();
  }

  /** Re-derive state from live manager values and patch the DOM in place. */
  refresh(): void {
    if (this.destroyed || !this.rootEl) return;
    const { manager } = this.deps;
    const listed = this.deps.listThreads();
    // The orchestrator needs the user too, even if the board's filter hides it (e.g. a peer plugin flagged it `background`).
    const ownId = this.deps.getOrchestratorThreadId();
    const own = ownId && !listed.some((t) => t.id === ownId) ? manager.getThread(ownId) : undefined;
    const threads = own ? [...listed, own] : listed;
    const candidates: AttentionCandidate[] = threads.map((t) => ({
      threadId: t.id,
      title: t.title,
      flags: liveRowFlags(manager, this.deps.hasPendingWakeup, t),
      needsInput: threadNeedsInput(t, manager.hasPendingQuestion(t.id)),
      pending: {
        permission: manager.hasPendingPermission(t.id),
        question: manager.hasPendingQuestion(t.id),
        plan: manager.hasPendingPlan(t.id),
      },
    }));
    this.attention = attentionItems(candidates);
    this.trayEntries = this.computeTrayEntries();
    const needsYou = needsYouCount(this.attention);
    const running = threads.filter((t) => manager.isRunning(t.id)).length;

    const orchestratorId = this.deps.getOrchestratorThreadId();
    const thread = orchestratorId ? manager.getThread(orchestratorId) : undefined;
    this.trackOrchestrator(orchestratorId, thread);
    const unread = thread ? unreadState(this.transcriptOf(thread), this.lastSeenId) : { hasUnread: false, latestAssistantId: undefined };
    const daemon = thread?.remote ? this.deps.daemons?.stateOf(thread.remote.daemonId) : undefined;
    const focusBefore = this.host.ownerDocument.activeElement;
    this.state = deriveDockState({
      orchestratorId,
      thread,
      isRunning: !!orchestratorId && manager.isRunning(orchestratorId),
      daemon,
      needsYouCount: needsYou,
      hasUnreadReply: unread.hasUnread,
    });
    this.trackHealth(thread);
    const previousMode = this.currentMode;
    if (this.state === 'none' && this.sheet?.isOpen) this.closeSheet(false);
    this.currentMode = this.deps.mode();
    if (previousMode !== this.currentMode && this.keyboard && this.keyboardRaw > 0) this.applyKeyboard(); // the clamp depends on the mode

    const root = this.rootEl;
    root.dataset.state = this.state;
    root.dataset.mode = this.currentMode;
    // A class on the pill (not :has()) lets styles.css lift it above the soft keyboard in pill mode.
    this.host.parentElement?.classList.toggle('ct-orch-pill-mode', this.currentMode === 'pill');
    // Pill mode: the field is the keyboard stop (the orb only calls focusField). Orb mode: the orb is the control.
    if (this.currentMode === 'pill') this.orbEl.setAttribute('tabindex', '-1'); else this.orbEl.removeAttribute('tabindex');
    // Narrow mode hides the field, so none/error/offline must show on the orb: a static tint, no spinning ring.
    const alertTint = this.currentMode === 'orb' && (this.state === 'none' || this.state === 'error' || this.state === 'offline');
    this.orbEl.toggleClass('ct-orch-orb-alert', alertTint);
    this.orbEl.toggleClass('ct-orch-orb-alert-warn', alertTint && this.state === 'none');
    this.orbEl.toggleClass('ct-orch-orb-spinning', !alertTint && (running > 0 || (!!orchestratorId && manager.isRunning(orchestratorId))));

    const tip = tooltipText({ running, total: threads.length, needsYou });
    const dotTip = unread.hasUnread ? `${tip} · unread reply` : tip;
    this.dotEl.toggleClass('ct-orch-dot-attention', needsYou > 0 || unread.hasUnread);
    this.dotEl.setAttribute('title', dotTip);
    this.dotEl.setAttribute('aria-label', dotTip);
    this.summaryText = tip;
    this.renderBadge(needsYou);

    this.sheet?.el.setAttribute('data-mode', this.currentMode);
    this.renderBody(thread);
    this.placeBody();
    // A draft edited while the field was hidden (orb mode) was measured at scrollHeight 0: re-measure now it is visible.
    if (previousMode === 'orb' && this.currentMode === 'pill' && this.inputEl) this.autosize(this.inputEl);
    this.updateInputControls();
    if (this.sheet?.isOpen) this.layoutChanged(); // after the mode update: the room above the pill differs per mode
    this.renderSheet();
    this.renderTray();
    this.renderChips();
    // After the sheet re-rendered (the modal inert state follows the mode): only then is it known what can hold focus.
    if (previousMode !== this.currentMode && this.sheet?.isOpen) this.keepFocusAcrossModeChange(focusBefore);
  }

  // ── Error / offline announcer, count badge ────────────────────────────────

  /**
   * A CHANGE of health announces (to error / offline); mount, repeats and setup (none) are silent. `working` is neutral: a
   * retry runs the orchestrator (deriveDockState reports error only while idle), and the error stands until it ends one
   * way or the other. A recovery is announced only after it has held for RECOVERY_DEBOUNCE_MS, so a flap (retry that fails
   * again, a daemon bounce) is never announced as "recovered".
   */
  private trackHealth(thread: Thread | undefined): void {
    if (this.state === 'working') return;
    const h: Health = this.state === 'error' ? 'error' : this.state === 'offline' ? 'offline' : this.state === 'none' ? 'none' : 'ok';
    const prev = this.health;
    this.health = h;
    const bad = h === 'error' || h === 'offline';
    if (prev === null || prev === 'none') { this.announced = bad ? h : 'ok'; return; } // first sight / setup: not news
    if (h === prev) return;
    if (h === 'none') { this.cancelRecovery(); this.announced = 'ok'; return; }
    if (h === 'ok') {
      if (this.stateLiveTimer && this.pendingProblem) {
        // The problem recovered before its text was ever written: announce nothing (not a lone "recovered").
        clearTimeout(this.stateLiveTimer);
        this.stateLiveTimer = null;
        this.pendingProblem = false;
        this.announced = 'ok';
        return;
      }
      if (this.announced === 'error' || this.announced === 'offline') this.scheduleRecovery();
      return;
    }
    this.cancelRecovery();
    if (this.announced === h) return; // flapped back into the problem that was already announced
    this.announced = h;
    this.announceState(this.reasonFor(h, thread).text, true);
  }

  private scheduleRecovery(): void {
    this.cancelRecovery();
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.destroyed || this.health !== 'ok') return;
      this.announced = 'ok';
      this.announceState('Orchestrator recovered');
    }, RECOVERY_DEBOUNCE_MS);
  }

  private cancelRecovery(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  /** Cleared first, then set on the next tick, so the same text twice is still read. */
  private announceState(raw: string, problem = false): void {
    const el = this.stateLiveEl;
    if (!el) return;
    const text = raw.replace(/\u00a0/g, ' ').trim();
    const capped = text.length > MAX_ANNOUNCE_CHARS ? `${text.slice(0, MAX_ANNOUNCE_CHARS - 1)}…` : text;
    if (this.stateLiveTimer) clearTimeout(this.stateLiveTimer);
    el.textContent = '';
    this.pendingProblem = problem;
    this.stateLiveTimer = setTimeout(() => {
      this.stateLiveTimer = null;
      this.pendingProblem = false;
      if (!this.destroyed) el.textContent = capped;
    }, 0);
  }

  /** Narrow mode has no hover: the needs-you count shows on the dot as a number (aria-hidden; the dot keeps its label). */
  private renderBadge(needsYou: number): void {
    const text = this.currentMode === 'orb' && needsYou > 0 ? (needsYou > MAX_BADGE ? `${MAX_BADGE}+` : String(needsYou)) : '';
    let badge = this.dotEl.querySelector<HTMLElement>('.ct-orch-dot-count');
    if (!text) { badge?.remove(); this.dotEl.toggleClass('ct-orch-dot-has-count', false); return; }
    if (!badge) badge = this.dotEl.createSpan({ cls: 'ct-orch-dot-count', attr: { 'aria-hidden': 'true' } });
    if (badge.textContent !== text) badge.textContent = text;
    this.dotEl.toggleClass('ct-orch-dot-has-count', true);
  }

  // ── Per-orchestrator state ────────────────────────────────────────────────

  /** A new orchestrator thread (first sight, re-setup) starts with a clean buffer, and its history counts as read. */
  private trackOrchestrator(id: string | undefined, thread: Thread | undefined): void {
    if (id !== this.trackedId) {
      // A swapped / re-set-up orchestrator thread must not inherit what was typed for the previous one.
      // (Deleted and re-created with the SAME id keeps it: only a different, defined id clears, and only a draft that is NOT
      // already the new orchestrator's: a second board noticing the swap late must not wipe what was typed for it meanwhile.)
      if (id !== undefined && this.lastOrchestratorId !== undefined && id !== this.lastOrchestratorId) {
        if (this.drafts.get(id) === '') this.drafts.clear();
        this.syncedVersion = this.drafts.version;
        if (this.inputEl) { this.inputEl.value = this.drafts.get(id); this.autosize(this.inputEl); }
        this.history.reset();
      }
      // First sight of an orchestrator (a board re-mount): whatever the store holds for ANOTHER orchestrator is dropped, not kept hidden.
      if (id !== undefined && this.lastOrchestratorId === undefined && this.drafts.get(id) === '') {
        this.drafts.clear();
        this.syncedVersion = this.drafts.version;
      }
      this.trackedId = id;
      if (id !== undefined) this.lastOrchestratorId = id;
      // A send that failed while the user was on another orchestrator comes back when they return to this one.
      const lost = id ? this.lostSends.get(id) : undefined;
      if (id && lost !== undefined) {
        this.lostSends.delete(id);
        if (this.drafts.get(id) === '') {
          this.drafts.set(lost, id);
          this.syncedVersion = this.drafts.version;
          if (this.inputEl) { this.inputEl.value = lost; this.autosize(this.inputEl); }
        }
      }
      this.streamBuf = '';
      this.stoppedText = '';
      this.txCache = null;
      this.pickupIds.clear();
      this.seeded = false;
      this.lastSeenId = undefined;
      this.stopping = false;
    }
    if (!thread) return;
    const latest = unreadState(this.transcriptOf(thread), undefined).latestAssistantId;
    if (!this.seeded || this.sheet?.isOpen) { this.lastSeenId = latest; this.seeded = true; }
  }

  private onOrchestratorEvent(event: { type: string; [k: string]: unknown }): void {
    const id = this.deps.getOrchestratorThreadId();
    if (!id) return;
    switch (event.type) {
      case 'token': {
        const first = this.streamBuf === '';
        this.streamBuf += String(event.text ?? '');
        if (this.sheet?.isOpen) {
          this.sheet.setStreaming(this.streamBuf);
          if (first) this.sheet.announce('Orchestrator is replying');
        }
        break;
      }
      case 'stream_reset':
        this.streamBuf = '';
        break;
      case 'streaming_start':
        this.streamBuf = '';
        this.stoppedText = '';
        this.stopRequested = false;
        break;
      case 'user_message_added': {
        // The event precedes streaming_start, so isRunning() still reflects the PRIOR state: true means the
        // manager coalesced this message into the turn in flight (ADR-0002), and it is not yet answered.
        const msg = event.message as { id?: string; content?: string } | undefined;
        if (msg?.id && this.deps.manager.isRunning(id)) this.pickupIds.add(msg.id);
        // A13: our own send was recorded: a later failure must not restore the draft (it would send a duplicate).
        if (this.sending && msg?.content === this.sendingText) { this.sendEcho = true; this.sheet?.pinOnNextRender(); }
        this.stoppedText = '';
        this.stopRequested = false;
        break;
      }
      case 'message':
        this.streamBuf = '';
        this.stoppedText = '';
        this.stopRequested = false; // the reply completed anyway: nothing was stopped
        this.onAssistantMessage(event.message as { role?: string; content?: string } | undefined);
        break;
      case 'interrupted':
      case 'done':
      case 'error':
      case 'run_state_settled':
        // An interrupt drops the in-progress assistant text (never persisted): keep it visible, dimmed, until the next send.
        // Remote sessions may end a stopped turn with done / run_state_settled / error and no `interrupted`: when Stop was
        // clicked, any end-of-turn event keeps the partial (from the buffer, or the snapshot taken at the click).
        if (!this.stoppedText && (event.type === 'interrupted' || this.stopRequested)) {
          const partial = this.streamBuf || (this.stopRequested ? this.stopSnapshot : '');
          if (partial) this.stoppedText = partial;
        }
        if (event.type !== 'done') this.stopRequested = false;
        this.streamBuf = '';
        this.pickupIds.clear();
        if (event.type !== 'done') this.stopping = false;
        break;
      case 'tool_use':
      case 'tool_progress':
      case 'status':
        this.sheet?.setActivity(this.deps.manager.getThreadActivity(id) ?? '');
        break;
    }
  }

  /** Assistant text arrived: read at once when the sheet is open, otherwise unread + a one-line peek. */
  private onAssistantMessage(message: { role?: string; content?: string } | undefined): void {
    if (message?.role !== 'assistant') return;
    const id = this.deps.getOrchestratorThreadId();
    const thread = id ? this.deps.manager.getThread(id) : undefined;
    if (!thread) return;
    const u = unreadState(this.transcriptOf(thread), this.lastSeenId);
    const line = peekLine(message.content ?? '', this.threadRefs());
    if (this.sheet?.isOpen) {
      this.lastSeenId = u.latestAssistantId;
      if (line) this.sheet.announce(`Orchestrator replied: ${line}`, true);
    } else if (u.hasUnread && line) {
      this.showPeek(line);
    }
  }

  private threadRefs(): { id: string; title: string }[] {
    return this.deps.listThreads().map((t) => ({ id: t.id, title: t.title }));
  }

  // ── Sheet, peek, chips ────────────────────────────────────────────────────

  private mountSheetParts(): void {
    // Inside the dock root (absolutely positioned: the pill is still the containing block) so Tab reaches the sheet and
    // the chips right after the field instead of after every pill button.
    const parent = this.rootEl ?? this.host.parentElement ?? this.host;
    this.sheet = new DockSheet(parent, {
      close: () => this.closeSheet(),
      openFull: () => { const id = this.deps.getOrchestratorThreadId(); if (id) void this.openQuietly(id); },
      imageSrc: this.deps.imageSrc ? (ref, inline) => this.deps.imageSrc!(ref, inline) : undefined,
      messages: createDockMessageEnv({
        threadId: () => this.deps.getOrchestratorThreadId(),
        getThread: (id) => this.deps.manager.getThread(id),
        openNote: (href) => { this.deps.openLink?.(href); },
        // Defence in depth: an anchor injected into the DOM after render can carry any id; only threads the board knows open.
        openThread: (threadId) => { if (this.deps.manager.getThread(threadId)) void this.openQuietly(threadId); },
        deps: this.deps.messageHost,
      }),
      removeWaiting: (index, text) => this.removeWaiting(index, text),
      pickChip: (chip) => { void this.submitText(chip.prompt); },
      linkEnter: (threadId) => { this.deps.focusCard?.(threadId, { scroll: true, flash: true }); },
      linkLeave: () => { this.deps.clearCardFocus?.(); },
    });
    this.tray = new DockTray(this.sheet.trayHost, {
      manager: this.deps.manager,
      permissionCard: this.deps.permissionCard,
      openThread: (threadId) => { void this.openQuietly(threadId); },
      announce: (text) => this.sheet?.announceTray(text),
      refresh: () => this.refresh(),
      focusFallback: () => { if (this.inputEl) this.inputEl.focus(); else this.sheet?.focusClose(); },
    });
    const peek = parent.createDiv({ cls: 'ct-orch-peek', attr: { role: 'status', 'data-testid': 'orchestrator-peek' } });
    peek.hidden = true;
    const orb = peek.createSpan({ cls: 'ct-orch-peek-orb', attr: { 'aria-hidden': 'true' } });
    setIcon(orb, 'sparkles');
    const text = peek.createSpan('ct-orch-peek-text');
    this.peekTextEl = text;
    peek.createEl('button', { cls: 'ct-orch-peek-open', text: 'Open', attr: { type: 'button' } })
      .addEventListener('click', () => this.openSheet());
    const dismiss = peek.createEl('button', { cls: 'ct-orch-peek-dismiss', attr: { type: 'button', 'aria-label': 'Dismiss' } });
    const dx = dismiss.createSpan({ cls: 'ct-orch-icon', attr: { 'aria-hidden': 'true' } });
    setIcon(dx, 'x');
    dismiss.addEventListener('click', () => this.hidePeek());
    this.peekEl = peek;

    const chips = parent.createDiv({ cls: 'ct-orch-chips', attr: { 'data-testid': 'orchestrator-chips' } });
    chips.hidden = true;
    // Keep focus in the field while a chip is pressed, so the strip does not vanish before the click lands.
    chips.addEventListener('mousedown', (e) => e.preventDefault());
    // Tab from the field into the strip keeps it open; focus leaving both closes it.
    chips.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && (chips.contains(to) || to === this.inputEl)) return;
      chips.hidden = true;
    });
    this.chipsEl = chips;
  }

  /** sheetTranscript per (messages array, length, last id): refresh() reads it several times per event. */
  private transcriptOf(thread: Thread): ReturnType<typeof sheetTranscript> {
    const msgs = thread.messages;
    const lastMsg = msgs[msgs.length - 1];
    const last = lastMsg?.id;
    const lastLen = lastMsg?.content.length ?? 0;
    // A tool call appended to the last message changes the merged row with no new message and no new text.
    const lastTools = lastMsg?.toolCalls?.length ?? 0;
    const c = this.txCache;
    if (c && c.ref === msgs && c.len === msgs.length && c.lastId === last && c.lastLen === lastLen && c.lastTools === lastTools) return c.entries;
    const entries = sheetTranscript(msgs);
    this.txCache = { ref: msgs, len: msgs.length, lastId: last, lastLen, lastTools, entries };
    return entries;
  }

  private hasTranscript(): boolean {
    const id = this.deps.getOrchestratorThreadId();
    const thread = id ? this.deps.manager.getThread(id) : undefined;
    return !!thread && this.transcriptOf(thread).length > 0;
  }

  openSheet(): void {
    if (this.destroyed || !this.sheet || !this.deps.getOrchestratorThreadId()) return;
    const wasOpen = this.sheet.isOpen;
    this.sheet.open();
    this.startKeyboardTracking();
    this.hidePeek();
    this.layoutChanged();
    this.refresh();
    if (!wasOpen) this.focusIntoDialog();
  }

  /**
   * The dialog sits last in the DOM, so Tab would otherwise walk the whole pill first. Opening moves focus to the
   * composer (the field in the pill, the textarea in the bottom sheet) or, when there is no input (error / offline),
   * to a control inside the dialog. Focus already inside the dock or the sheet is left alone.
   */
  private focusIntoDialog(): void {
    const active = this.host.ownerDocument.activeElement;
    if (active && this.sheet?.el.contains(active)) return;
    // Pill mode: focus already in the field stays there. Narrow: the orb / field is inert behind the modal sheet, so focus ALWAYS moves in.
    if (this.currentMode === 'pill' && active && active !== this.host.ownerDocument.body && this.rootEl?.contains(active)) return;
    if (this.inputEl) this.inputEl.focus();
    else if (this.actionEl && this.sheet?.el.contains(this.actionEl)) this.actionEl.focus();
    else this.sheet?.focusClose();
  }

  closeSheet(returnFocus = true): void {
    if (this.destroyed || !this.sheet?.isOpen) return;
    const doc = this.host.ownerDocument;
    // A programmatic close (orchestrator deleted, state none) must not drop focus from inside the sheet to the page.
    const hadFocus = !!doc.activeElement && this.sheet.el.contains(doc.activeElement);
    this.sheet.close(); // also clears the board-card highlight of a hovered link
    if (!this.touchFieldFocused()) this.stopKeyboardTracking();
    else this.layoutChanged();
    this.tray?.reset();
    this.refresh();
    if (!returnFocus && !hadFocus) return;
    if (this.currentMode === 'orb') this.orbEl.focus();
    else (this.inputEl ?? this.actionEl)?.focus();
  }

  /**
   * The mode flipped under an open sheet: the focused control may have moved, been hidden (Send exists only in the narrow
   * sheet) or gone inert. Keep focus where it was if it can still hold it, else the composer / field, else the dialog.
   */
  private keepFocusAcrossModeChange(before: Element | null): void {
    const doc = this.host.ownerDocument;
    const sheet = this.sheet;
    if (!sheet) return;
    // Focus on the page (the user clicked blank space) was not ours to begin with: do not pull it into the dialog.
    if (!before || before === doc.body) return;
    const active = doc.activeElement;
    if (active && active !== doc.body && sheet.isFocusable(active)) return;
    if (before && before !== doc.body && sheet.isFocusable(before)) { (before as HTMLElement).focus(); return; }
    if (this.inputEl && sheet.isFocusable(this.inputEl)) this.inputEl.focus();
    else if (this.actionEl && sheet.isFocusable(this.actionEl)) this.actionEl.focus();
    else sheet.focusClose();
  }

  /** The inset goes on the sheet (narrow bottom sheet) and on the view root (so a pill-mode pill can lift, see styles.css). */
  /** Applies the raw keyboard inset under the CURRENT mode (also re-run when the mode flips under an open keyboard). */
  private applyKeyboard(): void {
    // Pill mode lifts the whole pill: never further than leaves the pill inside a small view.
    const px = this.currentMode === 'pill' ? this.clampLift(this.keyboardRaw) : this.keyboardRaw;
    this.keyboardPx = px;
    this.host.parentElement?.classList.toggle('ct-orch-kbd-up', px > 0);
    this.setKeyboardVar(px);
    if (this.sheet?.isOpen) this.layoutChanged();
  }

  private clampLift(px: number): number {
    const rootH = this.keyboardRoot?.clientHeight ?? 0;
    if (!rootH || px <= 0) return px;
    const pill = (this.host.parentElement ?? this.host).offsetHeight;
    return Math.min(px, Math.max(0, rootH - pill - PILL_BOTTOM_KBD_PX));
  }

  private setKeyboardVar(px: number | null): void {
    this.sheet?.setKeyboardInset(px);
    const root = this.keyboardRoot ?? this.host.closest<HTMLElement>('.ct-agents-root');
    if (!root) return;
    if (px === null) root.style.removeProperty('--ct-orch-kbd-inset'); else root.style.setProperty('--ct-orch-kbd-inset', `${px}px`);
  }

  private stopKeyboardTracking(): void {
    this.keyboard?.stop();
    this.keyboardPx = 0;
    this.keyboardRaw = 0;
    this.host.parentElement?.classList.remove('ct-orch-kbd-up');
    this.setKeyboardVar(null);
  }

  private touchFieldFocused(): boolean {
    return Platform.isMobile && !!this.inputEl && this.host.ownerDocument.activeElement === this.inputEl;
  }

  /** While the sheet is open (or, on touch, the field is focused) the soft keyboard (visualViewport) lifts the narrow bottom sheet's composer above it. */
  private startKeyboardTracking(): void {
    if (this.keyboard) { this.keyboard.start(); return; }
    const win = this.host.ownerDocument.defaultView;
    if (!win) return;
    // Cached: destroy() may run after the host was detached from the board root, and the variable must still come off it.
    this.keyboardRoot = this.host.closest<HTMLElement>('.ct-agents-root');
    this.keyboard = new KeyboardInsetTracker(
      win,
      () => (this.host.closest('.ct-agents-root') ?? this.rootEl)?.getBoundingClientRect().bottom ?? 0,
      (raw) => {
        if (this.destroyed) return;
        this.keyboardRaw = raw;
        this.applyKeyboard();
      },
    );
    this.keyboard.start();
  }

  /**
   * Re-measure the sheet's max height: 60% of the view, never taller than the space above the pill (narrow: or above the
   * keyboard). A pinned transcript stays on its latest message when the height shrinks (QA N10): the pin is read BEFORE the
   * change, so a user who scrolled up is left where they are.
   */
  layoutChanged(): void {
    if (this.destroyed || !this.sheet) return;
    const root = this.host.closest('.ct-agents-root') as HTMLElement | null;
    const h = root?.clientHeight ?? 0;
    const sheet = this.sheet;
    this.keyboard?.measure(); // the view may have moved under an open keyboard (it reports only a change)
    sheet.keepPinned(() => {
      if (!h) { sheet.setMaxHeight(null); return; }
      const pill = (this.host.parentElement ?? this.host).offsetHeight;
      // Narrow: the bottom sheet covers the pill, so only the 60% cap and the keyboard apply (8px breathing room above the
      // keyboard-lifted sheet). Wide: it sits above the pill (36px offset + 8px gap).
      // Pill mode (landscape phone, tablet): the whole pill lifts by the keyboard inset, so the room above it shrinks by it.
      const room = this.currentMode === 'orb' ? h - this.keyboardPx - (this.keyboardPx > 0 ? 8 : 0) : h - (this.keyboardPx > 0 ? PILL_BOTTOM_KBD_PX : PILL_BOTTOM_PX) - this.keyboardPx - pill - 16;
      sheet.setMaxHeight(Math.min(h * 0.6, room)); // never above the room: no floor that could start the sheet off-screen
      sheet.fitTray();
    });
  }

  private renderSheet(): void {
    const sheet = this.sheet;
    if (!sheet || !sheet.isOpen) return;
    const id = this.deps.getOrchestratorThreadId();
    const thread = id ? this.deps.manager.getThread(id) : undefined;
    if (!id || !thread) return;
    const { manager } = this;
    const all = this.transcriptOf(thread);
    const live = new Set(all.map((e) => e.id));
    const { entries, older } = capTranscript(all);
    for (const pid of [...this.pickupIds]) if (!live.has(pid)) this.pickupIds.delete(pid); // rolled back
    // The tray already lists the orchestrator's own plan / question (hand-off button) and gives its own permission real
    // buttons, so a notice would only repeat them (dockSheetModel.sheetBlock).
    const blocked = sheetBlock({
      ownId: id,
      pendingPlan: manager.hasPendingPlan(id),
      pendingQuestion: manager.hasPendingQuestion(id),
      pendingPermission: manager.hasPendingPermission(id),
      tray: this.trayEntries,
    });
    const view: SheetView = {
      entries: entries.map((e) => ({ ...e, pickup: this.pickupIds.has(e.id) })),
      older,
      streaming: this.streamBuf,
      stopped: this.stoppedText,
      running: manager.isRunning(id),
      activity: manager.getThreadActivity(id) ?? '',
      waiting: manager.getQueuedMessages(id).map((q) => q.text),
      blocked,
      threads: this.threadRefs(),
      // Chips send text: offer them only while the body is an input (not an error / offline reason).
      chips: this.bodyKind === 'input' ? suggestionChips(this.attention) : [],
      mode: this.currentMode,
      summary: this.summaryText,
    };
    sheet.render(view);
  }

  /**
   * The Needs-you tray's entries: every awaiting thread (the set the dot and the board's Needs-you lane count), the
   * orchestrator's own included. Permissions are listed first (the only inline-actionable kind, so they stay visible
   * when the tray collapses); within a kind the attentionItems (board) order is kept.
   */
  private computeTrayEntries(): TrayEntry[] {
    const { manager } = this;
    return trayItems(this.attention).map((item) => ({
      item,
      // Buttons only for a live permission that the host can persist an "Always" for; otherwise the card hands off.
      permission: item.kind === 'permission' && this.deps.permissionCard ? manager.getPendingPermission(item.threadId) : undefined,
    }));
  }

  private renderTray(): void {
    const tray = this.tray;
    const sheet = this.sheet;
    if (!tray || !sheet?.isOpen) return;
    // The tray changes the transcript's height: stay on the latest message if we were on it.
    sheet.keepPinned(() => sheet.keepTrayFocus(() => { tray.render(this.trayEntries); sheet.fitTray(); }));
  }

  private get manager(): OrchestratorDockDeps['manager'] { return this.deps.manager; }

  private removeWaiting(index: number, text: string): void {
    const id = this.deps.getOrchestratorThreadId();
    if (!id) return;
    // The manager emits no event on removal and indexes shift as items dequeue: verify the row is still what the user saw.
    if (this.manager.getQueuedMessages(id)[index]?.text === text) this.manager.removeQueuedMessageAt(id, index);
    this.renderSheet();
  }

  private showPeek(line: string): void {
    if (!this.peekEl || !this.peekTextEl) return;
    this.peekTextEl.empty();
    this.peekTextEl.createEl('strong', { text: 'Orchestrator' });
    this.peekTextEl.createSpan({ text: ` · ${line}` });
    this.peekEl.hidden = false;
    if (this.peekTimer) clearTimeout(this.peekTimer);
    this.peekTimer = setTimeout(() => this.hidePeek(), PEEK_MS);
  }

  private hidePeek(): void {
    if (this.peekTimer) clearTimeout(this.peekTimer);
    this.peekTimer = null;
    if (this.peekEl) this.peekEl.hidden = true;
  }

  /** The "Try:" strip above the pill: field focused, nothing said yet, sheet closed (narrow shows chips inside the sheet instead). */
  private renderChips(): void {
    const el = this.chipsEl;
    if (!el) return;
    const show = this.currentMode === 'pill' && this.bodyKind === 'input' && !!this.inputEl
      && (this.host.ownerDocument.activeElement === this.inputEl || el.contains(this.host.ownerDocument.activeElement))
      && !this.sheet?.isOpen && !this.hasTranscript();
    if (!show) { el.hidden = true; return; }
    if (el.hidden || el.childElementCount === 0) {
      el.empty();
      el.createSpan({ cls: 'ct-orch-chips-label', text: 'Try:' });
      for (const chip of suggestionChips(this.attention)) this.buildChip(el, chip);
    }
    el.hidden = false;
  }

  private buildChip(el: HTMLElement, chip: SuggestionChip): void {
    el.createEl('button', { cls: 'ct-orch-chip', text: chip.label, attr: { type: 'button' } })
      .addEventListener('click', () => { void this.submitText(chip.prompt); });
  }


  /** Pill: the body lives in the field. Orb + none/error/offline: it moves to the full-width status row above the pill's row. */
  private placeBody(): void {
    const status = this.statusEl;
    if (!status) return;
    const inSheet = this.currentMode === 'orb' && !!this.sheet?.isOpen;
    const wantStatus = this.currentMode === 'orb' && !inSheet && this.bodyKind !== 'input';
    // Narrow + sheet open: the ONE body (input, or P2's reason + action) lives in the bottom sheet's composer.
    const target = inSheet && this.sheet ? this.sheet.composerSlot : wantStatus ? status : this.fieldEl;
    if (this.bodyEl.parentElement !== target) {
      const hadFocus = !!this.inputEl && this.host.ownerDocument.activeElement === this.inputEl;
      target.append(this.bodyEl);
      if (hadFocus) this.inputEl?.focus();
    }
    status.hidden = !wantStatus;
    status.dataset.body = wantStatus ? (this.bodyKind ?? '') : '';
    if (this.sheet) this.sheet.composerSlot.dataset.body = inSheet ? (this.bodyKind ?? '') : '';
  }

  // ── Body (field / setup affordance / reason) ──────────────────────────────

  private bodyKindFor(state: DockState): BodyKind {
    if (state === 'none') return 'none';
    if (state === 'offline') return 'offline';
    if (state === 'error') return 'error';
    return 'input';
  }

  private reasonFor(kind: BodyKind, thread: Thread | undefined): { text: string; action?: { label: string; run: () => void } } {
    const id = this.deps.getOrchestratorThreadId();
    if (kind === 'none') {
      return { text: 'No orchestrator yet', action: { label: 'Set up…', run: () => { void this.setUp(); } } };
    }
    if (kind === 'offline') {
      const daemonId = thread?.remote?.daemonId;
      const reconnect = this.deps.daemons?.reconnect.bind(this.deps.daemons);
      return {
        text: 'Orchestrator stopped — daemon disconnected',
        action: daemonId && reconnect ? { label: 'Reconnect', run: () => reconnect(daemonId) } : undefined,
      };
    }
    const err = (thread?.lastError ?? '').trim();
    const clipped = err.length > MAX_ERROR_CHARS ? `${err.slice(0, MAX_ERROR_CHARS)}…` : err;
    // Keep a parenthesised tail attached to its word ("exited unexpectedly (code 1)") so it never splits across lines.
    const short = clipped.replace(/\s*\(([^)]*)\)/g, (_m, inner: string) => `\u00a0(${inner.replace(/\s/g, '\u00a0')})`);
    return {
      text: `Orchestrator errored — ${short || (thread?.authRequired ? 'sign-in needed' : 'see the thread')}`,
      action: id ? { label: 'Open thread', run: () => { void this.openThreadFull(); } } : undefined,
    };
  }

  private renderBody(thread: Thread | undefined): void {
    const kind = this.bodyKindFor(this.state);
    this.fieldEl.dataset.body = kind;
    if (kind === 'input') {
      if (this.bodyKind !== 'input') this.buildInputBody();
      return;
    }
    const { text, action } = this.reasonFor(kind, thread);
    const sameShape = this.bodyKind === kind && this.reasonEl && !!this.actionEl === !!action;
    if (sameShape) { this.reasonEl!.setText(text); this.reasonEl!.setAttribute('title', text); return; }
    this.stashDraft();
    this.bodyEl.empty();
    this.inputEl = null;
    this.stopEl = this.sendEl = null;
    this.reasonEl = this.bodyEl.createSpan({ cls: 'ct-orch-reason', text, attr: { title: text } });
    this.actionEl = null;
    if (action) {
      const btn = this.bodyEl.createEl('button', { cls: 'ct-orch-action', text: action.label, attr: { type: 'button' } });
      btn.addEventListener('click', action.run);
      this.actionEl = btn;
    }
    this.bodyKind = kind;
  }

  /**
   * Keep what the field holds across a body rebuild, but only if no other dock changed the draft since this one last read or
   * wrote it: a second board still holding text that was meanwhile SENT (and cleared) must not write it back (a pasted token).
   */
  private stashDraft(): void {
    if (!this.inputEl || this.drafts.version !== this.syncedVersion) return;
    // Under the key the field was built for: the orchestrator may be gone right now (state none), which must not re-key the draft.
    if (this.inputEl.value !== this.drafts.get(this.inputKey)) {
      if (this.inputEl.value) this.drafts.set(this.inputEl.value, this.inputKey); else this.drafts.clear();
      this.syncedVersion = this.drafts.version;
    }
  }

  private buildInputBody(): void {
    this.bodyEl.empty();
    this.reasonEl = null;
    this.actionEl = null;
    const input = this.bodyEl.createEl('textarea', {
      cls: 'ct-orch-input',
      attr: { rows: '1', maxlength: String(MAX_DRAFT_CHARS), placeholder: 'Ask the orchestrator…', 'aria-label': 'Ask the portfolio orchestrator', 'data-testid': 'orchestrator-input' },
    });
    this.history.reset();
    this.inputKey = this.draftKey;
    input.value = this.draft;
    this.syncedVersion = this.drafts.version;
    this.autosize(input);
    input.addEventListener('input', () => {
      this.history.reset(); // typing in a recalled message makes it the draft
      this.draft = input.value;
      this.autosize(input);
    });
    input.addEventListener('keydown', (e) => this.onKeydown(e, input));
    input.addEventListener('click', () => { if (this.currentMode === 'pill' && !this.sheet?.isOpen && this.hasTranscript()) this.openSheet(); });
    input.addEventListener('focus', () => { if (Platform.isMobile) this.startKeyboardTracking(); this.renderChips(); });
    input.addEventListener('blur', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && this.chipsEl?.contains(to)) return; // moving into a chip
      if (!this.sheet?.isOpen) this.stopKeyboardTracking();
      this.renderChips();
    });
    this.inputEl = input;
    this.bodyEl.createEl('kbd', { cls: 'ct-orch-kbd', text: Platform.isMacOS ? '⌘J' : 'Ctrl J', attr: { 'aria-hidden': 'true' } });
    const send = this.bodyEl.createEl('button', { cls: 'ct-orch-send', text: 'Send', attr: { type: 'button' } });
    send.hidden = true;
    send.addEventListener('click', () => { void this.submitText(input.value); });
    const stop = this.bodyEl.createEl('button', { cls: 'ct-orch-stop', text: 'Stop', attr: { type: 'button', 'aria-label': 'Stop the orchestrator' } });
    stop.hidden = true;
    stop.addEventListener('click', () => { void this.stop(); });
    this.sendEl = send;
    this.stopEl = stop;
    this.bodyKind = 'input';
  }

  private autosize(input: HTMLTextAreaElement): void {
    input.style.height = 'auto';
    // scrollHeight is 0 until laid out (jsdom): leave the height to CSS rather than collapsing it.
    if (input.scrollHeight > 0) input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_PX)}px`;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private onKeydown(e: KeyboardEvent, input: HTMLTextAreaElement): void {
    // With the sheet open Escape is handled by the sheet / dock-root listeners (close + focus back to the field).
    if (e.key === 'Escape') { if (!this.sheet?.isOpen && !e.isComposing && e.keyCode !== 229) input.blur(); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { this.recall(e, input); return; }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    // Keyboard route to the transcript: Enter on an empty field opens the sheet (nothing is sent).
    if (!input.value.trim()) { if (!this.sheet?.isOpen && this.hasTranscript()) this.openSheet(); return; }
    void this.submitText(input.value);
  }

  /**
   * ArrowUp / ArrowDown walk the last sent messages. ArrowUp starts from an empty field, or a collapsed caret at the start
   * of a single-line draft; once a message is recalled it keeps going back (a multi-line one only from its first line)
   * and ArrowDown goes forward, ending on the draft that was being typed. Never during IME composition or with a modifier.
   */
  private recall(e: KeyboardEvent, input: HTMLTextAreaElement): void {
    if (this.sending || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || e.keyCode === 229) return;
    if (input.selectionStart !== input.selectionEnd) return;
    const caret = input.selectionStart ?? 0;
    const value = input.value;
    const h = this.history;
    let next: string | undefined;
    // A freshly recalled single line keeps walking (the caret is where the recall put it); once the caret has been moved,
    // only its very start (Up) / very end (Down) continue, so a long wrapped paragraph keeps normal caret movement.
    const fresh = h.browsing && value === h.shown && !value.includes('\n') && caret === this.recallCaret;
    if (e.key === 'ArrowUp') {
      const can = h.browsing ? value === h.shown && (caret === 0 || fresh) : value === '' || (caret === 0 && !value.includes('\n'));
      if (!can) return;
      next = h.previous(value);
    } else {
      if (!h.browsing || value !== h.shown || !(caret === value.length || fresh)) return;
      next = h.next();
    }
    if (next === undefined) return;
    e.preventDefault();
    input.value = next;
    input.setSelectionRange(next.length, next.length);
    this.recallCaret = next.length;
    this.draft = next;
    this.autosize(input);
  }

  /**
   * Sends to the orchestrator and shows the reply in the sheet (no hand-off to the full thread). Only ever
   * reached from the user's own action (Enter, Send, a chip): the dock never relays what it observes, and
   * the manager does not dedupe, so the field is cleared synchronously and a pending send blocks another.
   */
  private async submitText(raw: string): Promise<void> {
    const text = raw.trim();
    const id = this.deps.getOrchestratorThreadId();
    if (!text || !id || this.sending || this.bodyKind !== 'input') return;
    this.sending = true;
    this.sendEcho = false;
    this.sendingText = text;
    this.history.push(text);
    this.draft = '';
    if (this.inputEl) { this.inputEl.value = ''; this.autosize(this.inputEl); }
    this.openSheet();
    try {
      await this.deps.manager.sendMessage(id, text);
    } catch (err) {
      if (this.sendEcho) {
        // The message is already in the transcript (user_message_added was seen): restoring the draft would invite a duplicate send.
        new Notice(`The orchestrator could not start working on your message: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (this.deps.getOrchestratorThreadId() !== id) {
        // The orchestrator was swapped while the send was pending: this text belongs to the old one and must not land in the new one's
        // draft. It is never dropped: kept per orchestrator (it comes back if the user returns) and quoted in the notice.
        this.lostSends.set(id, this.lostSends.has(id) ? `${this.lostSends.get(id)}\n${text}` : text);
        new Notice(`Could not send to the previous orchestrator (${err instanceof Error ? err.message : String(err)}). Your message: "${text.length > 160 ? `${text.slice(0, 160)}…` : text}"`);
        return;
      }
      // Never silently drop a message: put it back and say why.
      // The textarea may have been rebuilt while the send was pending: write to the CURRENT one, draft first.
      this.draft = this.draft ? `${text}\n${this.draft}` : text;
      if (this.inputEl) { this.inputEl.value = this.draft; this.autosize(this.inputEl); }
      new Notice(`Could not send to the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sending = false;
    }
  }

  private async stop(): Promise<void> {
    const id = this.deps.getOrchestratorThreadId();
    if (!id || this.stopping) return;
    this.stopping = true;
    this.stopRequested = true;
    this.stopSnapshot = this.streamBuf; // before interrupt(): the end-of-turn events may arrive in any order
    this.updateInputControls();
    try {
      await this.deps.manager.interrupt(id);
    } catch (err) {
      // The turn carries on: no stale stop state may turn a later normal end into a "Stopped" row.
      this.stopRequested = false;
      this.stopSnapshot = '';
      new Notice(`Could not stop the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.stopping = false;
      this.refresh(); // the interrupt events already re-derived the transcript; this settles the controls
    }
  }

  /** Stop replaces Send while the orchestrator runs (visible with the sheet open); Send exists only in the narrow sheet. */
  private updateInputControls(): void {
    const id = this.deps.getOrchestratorThreadId();
    const running = !!id && this.deps.manager.isRunning(id);
    const open = !!this.sheet?.isOpen;
    if (this.stopEl) { this.stopEl.hidden = !(running && open); this.stopEl.disabled = this.stopping; }
    if (this.sendEl) this.sendEl.hidden = !(this.currentMode === 'orb' && open && !running);
    if (this.inputEl) this.inputEl.placeholder = open ? 'Reply…' : 'Ask the orchestrator…';
  }

  private async openThreadFull(): Promise<void> {
    const id = this.deps.getOrchestratorThreadId();
    if (id) await this.openQuietly(id);
  }

  private async openQuietly(id: string): Promise<void> {
    try { await this.deps.openThread(id); } catch (err) {
      new Notice(`Could not open the orchestrator thread: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onOrbClick(): void {
    if (this.currentMode === 'orb') {
      if (this.sheet?.isOpen) this.closeSheet(); else void this.openOrSetUp();
      return;
    }
    // Pill: the field is the control. When the field is a reason (error / offline) the orb is the way to the transcript.
    if (this.bodyKind !== 'input' && !this.sheet?.isOpen && this.hasTranscript()) { this.openSheet(); return; }
    this.focusField();
  }

  /** Narrow mode / Cmd+J: open the bottom sheet, setting the orchestrator up first if there is none. */
  private async openOrSetUp(): Promise<void> {
    if (!this.deps.getOrchestratorThreadId()) {
      try { await this.deps.ensureOrchestrator(); } catch (err) {
        new Notice(`Could not set up the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
        this.refresh();
        return;
      }
      this.refresh();
    }
    this.openSheet();
  }

  private async setUp(): Promise<void> {
    if (this.settingUp) return;
    this.settingUp = true;
    // aria-disabled (not `disabled`): a disabled button drops keyboard focus, so a failed setup would strand the user.
    const btn = this.actionEl;
    btn?.setAttribute('aria-disabled', 'true');
    try {
      await this.deps.ensureOrchestrator();
    } catch (err) {
      new Notice(`Could not set up the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      this.settingUp = false;
      btn?.removeAttribute('aria-disabled');
      // Even on failure: ensureOrchestrator may have persisted the id before throwing.
      this.refresh();
    }
    this.focusField();
  }
}
