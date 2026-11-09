/**
 * orchestratorDock.ts
 *
 * The OrchestratorDock: an "Ask the orchestrator" field, an orb whose ring spins
 * while work runs, and a needs-you dot. Host-agnostic (it mounts into whatever
 * element it is given and talks to the world only through `OrchestratorDockDeps`),
 * so the Agent Board's floating pill is host #1 and a list-view dock can reuse it.
 *
 * P2 scope: shell only (no reply sheet). State comes from orchestratorDockModel;
 * this class owns the DOM, the subscriptions and the interim send hand-off.
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
  tooltipText,
  type AttentionCandidate,
  type DockState,
} from './orchestratorDockModel';

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
    | 'hasActiveBackgroundTasks' | 'sendMessage' | 'subscribe'>;
  /** Board threads (the host applies its own filter, e.g. isKanbanThread): the source of total/running/attention. */
  listThreads(): Thread[];
  hasPendingWakeup(threadId: string): boolean;
  getOrchestratorThreadId(): string | undefined;
  /** plugin.ensureOrchestratorThread(false): creates the thread WITHOUT opening it. */
  ensureOrchestrator(): Promise<void>;
  /** plugin.openThreadInChatView */
  openThread(threadId: string): void | Promise<void>;
  mode(): DockMode;
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

const MAX_ERROR_CHARS = 60;
/** 4 lines at 20px + 12px vertical padding: a whole number of lines, so a long draft never half-clips one. */
const MAX_INPUT_PX = 92;

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

  private bodyKind: BodyKind | null = null;
  private state: DockState = 'none';
  private currentMode: DockMode = 'pill';
  private draft = '';
  private sending = false;
  private settingUp = false;
  private destroyed = false;
  private unsubscribeManager: (() => void) | null = null;
  private unsubscribeDaemons: (() => void) | null = null;

  constructor(private readonly host: HTMLElement, private readonly deps: OrchestratorDockDeps) {}

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

    this.unsubscribeManager = this.deps.manager.subscribe((_threadId, event) => {
      if (!REFRESH_EVENTS.has(event.type)) return;
      this.refresh();
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
    this.rootEl?.remove();
    this.statusEl?.remove();
    this.rootEl = null;
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
    if (this.currentMode === 'orb') { void this.handOff(); return; }
    const input = this.inputEl;
    if (input && input.ownerDocument.activeElement === input) { input.select(); return; }
    (input ?? this.actionEl)?.focus();
  }

  /** Re-derive state from live manager values and patch the DOM in place. */
  refresh(): void {
    if (this.destroyed || !this.rootEl) return;
    const { manager } = this.deps;
    const threads = this.deps.listThreads();
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
    const needsYou = needsYouCount(attentionItems(candidates));
    const running = threads.filter((t) => manager.isRunning(t.id)).length;

    const orchestratorId = this.deps.getOrchestratorThreadId();
    const thread = orchestratorId ? manager.getThread(orchestratorId) : undefined;
    const daemon = thread?.remote ? this.deps.daemons?.stateOf(thread.remote.daemonId) : undefined;
    this.state = deriveDockState({
      orchestratorId,
      thread,
      isRunning: !!orchestratorId && manager.isRunning(orchestratorId),
      daemon,
      needsYouCount: needsYou,
      // No sheet in P2 to "read" a reply in (the hand-off opens the full thread); P3 wires unreadState().
      hasUnreadReply: false,
    });
    const previousMode = this.currentMode;
    this.currentMode = this.deps.mode();

    const root = this.rootEl;
    root.dataset.state = this.state;
    root.dataset.mode = this.currentMode;
    // Pill mode: the field is the keyboard stop (the orb only calls focusField). Orb mode: the orb is the control.
    if (this.currentMode === 'pill') this.orbEl.setAttribute('tabindex', '-1'); else this.orbEl.removeAttribute('tabindex');
    // Narrow mode hides the field, so none/error/offline must show on the orb: a static tint, no spinning ring.
    const alertTint = this.currentMode === 'orb' && (this.state === 'none' || this.state === 'error' || this.state === 'offline');
    this.orbEl.toggleClass('ct-orch-orb-alert', alertTint);
    this.orbEl.toggleClass('ct-orch-orb-alert-warn', alertTint && this.state === 'none');
    this.orbEl.toggleClass('ct-orch-orb-spinning', !alertTint && (running > 0 || (!!orchestratorId && manager.isRunning(orchestratorId))));

    const tip = tooltipText({ running, total: threads.length, needsYou });
    this.dotEl.toggleClass('ct-orch-dot-attention', needsYou > 0);
    this.dotEl.setAttribute('title', tip);
    this.dotEl.setAttribute('aria-label', tip);

    this.renderBody(thread);
    this.placeBody();
    // A draft edited while the field was hidden (orb mode) was measured at scrollHeight 0: re-measure now it is visible.
    if (previousMode === 'orb' && this.currentMode === 'pill' && this.inputEl) this.autosize(this.inputEl);
  }

  /** Pill: the body lives in the field. Orb + none/error/offline: it moves to the full-width status row above the pill's row. */
  private placeBody(): void {
    const status = this.statusEl;
    if (!status) return;
    const wantStatus = this.currentMode === 'orb' && this.bodyKind !== 'input';
    const target = wantStatus ? status : this.fieldEl;
    if (this.bodyEl.parentElement !== target) target.append(this.bodyEl);
    status.hidden = !wantStatus;
    status.dataset.body = wantStatus ? (this.bodyKind ?? '') : '';
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
      return { text: 'No portfolio orchestrator yet', action: { label: 'Set up…', run: () => { void this.setUp(); } } };
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
    const short = err.length > MAX_ERROR_CHARS ? `${err.slice(0, MAX_ERROR_CHARS)}…` : err;
    return {
      text: `Orchestrator errored — ${short || (thread?.authRequired ? 'sign-in needed' : 'see the thread')}`,
      action: id ? { label: 'Open thread', run: () => { void this.handOff(); } } : undefined,
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
    this.reasonEl = this.bodyEl.createSpan({ cls: 'ct-orch-reason', text, attr: { title: text } });
    this.actionEl = null;
    if (action) {
      const btn = this.bodyEl.createEl('button', { cls: 'ct-orch-action', text: action.label, attr: { type: 'button' } });
      btn.addEventListener('click', action.run);
      this.actionEl = btn;
    }
    this.bodyKind = kind;
  }

  private stashDraft(): void {
    if (this.inputEl) this.draft = this.inputEl.value;
  }

  private buildInputBody(): void {
    this.bodyEl.empty();
    this.reasonEl = null;
    this.actionEl = null;
    const input = this.bodyEl.createEl('textarea', {
      cls: 'ct-orch-input',
      attr: { rows: '1', placeholder: 'Ask the orchestrator…', 'aria-label': 'Ask the portfolio orchestrator', 'data-testid': 'orchestrator-input' },
    });
    input.value = this.draft;
    this.autosize(input);
    input.addEventListener('input', () => {
      this.draft = input.value;
      this.autosize(input);
    });
    input.addEventListener('keydown', (e) => this.onKeydown(e, input));
    this.inputEl = input;
    this.bodyEl.createEl('kbd', { cls: 'ct-orch-kbd', text: Platform.isMacOS ? '⌘J' : 'Ctrl J', attr: { 'aria-hidden': 'true' } });
    this.bodyKind = 'input';
  }

  private autosize(input: HTMLTextAreaElement): void {
    input.style.height = 'auto';
    // scrollHeight is 0 until laid out (jsdom): leave the height to CSS rather than collapsing it.
    if (input.scrollHeight > 0) input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_PX)}px`;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private onKeydown(e: KeyboardEvent, input: HTMLTextAreaElement): void {
    if (e.key === 'Escape') { input.blur(); return; }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void this.submit(input);
  }

  /**
   * INTERIM (P2): send then hand off to the full thread view. P3 replaces the
   * hand-off with the reply sheet (the message is then shown in the sheet and
   * the thread is not opened). Only ever called from the user's own keydown.
   */
  private async submit(input: HTMLTextAreaElement): Promise<void> {
    const text = input.value.trim();
    const id = this.deps.getOrchestratorThreadId();
    if (!text || !id || this.sending) return;
    this.sending = true;
    input.value = '';
    this.draft = '';
    this.autosize(input);
    try {
      await this.deps.manager.sendMessage(id, text);
    } catch (err) {
      // Never silently drop a message: put it back and say why.
      // The textarea may have been rebuilt while the send was pending: write to the CURRENT one, draft first.
      this.draft = this.draft ? `${text}\n${this.draft}` : text;
      if (this.inputEl) { this.inputEl.value = this.draft; this.autosize(this.inputEl); }
      new Notice(`Could not send to the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      this.sending = false;
    }
    await this.openQuietly(id);
  }

  private async openQuietly(id: string): Promise<void> {
    try { await this.deps.openThread(id); } catch (err) {
      new Notice(`Could not open the orchestrator thread: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onOrbClick(): void {
    if (this.currentMode === 'orb') void this.handOff();
    else this.focusField();
  }

  /** Interim narrow/orb behaviour: open the orchestrator's full thread, setting it up first if needed. */
  private async handOff(): Promise<void> {
    let id = this.deps.getOrchestratorThreadId();
    if (!id) {
      try { await this.deps.ensureOrchestrator(); } catch (err) {
        new Notice(`Could not set up the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      id = this.deps.getOrchestratorThreadId();
      this.refresh();
    }
    if (id) await this.openQuietly(id);
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
