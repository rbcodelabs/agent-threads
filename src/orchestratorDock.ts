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

/** High-frequency events that cannot change the dock's state; everything else re-derives. */
const IGNORED_EVENTS: ReadonlySet<string> = new Set([
  'token', 'tool_use', 'tool_progress', 'tool_result_status', 'tool_result_images', 'status', 'usage',
  'active_model', 'task_progress', 'task_progress_summary', 'tasks_updated', 'files_edited', 'git_diff',
  'git_operation', 'memory_recall', 'commands_changed', 'agent_runs_changed', 'message', 'compact', 'recap',
  'summary_updated', 'status_tags', 'file_user_modified', 'stream_reset', 'rate_limit', 'rate_limit_retry',
  'api_retry', 'user_message_added',
]);

const MAX_ERROR_CHARS = 60;
const MAX_INPUT_PX = 96;

export class OrchestratorDock {
  private rootEl: HTMLElement | null = null;
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

    this.dotEl = root.createSpan({ cls: 'ct-orch-dot', attr: { role: 'img', 'data-testid': 'orchestrator-dot' } });

    this.unsubscribeManager = this.deps.manager.subscribe((_threadId, event) => {
      if (IGNORED_EVENTS.has(event.type)) return;
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
    this.rootEl = null;
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
    (this.inputEl ?? this.actionEl)?.focus();
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
    this.currentMode = this.deps.mode();

    const root = this.rootEl;
    root.dataset.state = this.state;
    root.dataset.mode = this.currentMode;
    this.orbEl.toggleClass('ct-orch-orb-spinning', running > 0 || (!!orchestratorId && manager.isRunning(orchestratorId)));

    const tip = tooltipText({ running, total: threads.length, needsYou });
    this.dotEl.toggleClass('ct-orch-dot-attention', needsYou > 0);
    this.dotEl.setAttribute('title', tip);
    this.dotEl.setAttribute('aria-label', tip);

    this.renderBody(thread);
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
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
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
      input.value = text;
      this.draft = text;
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
    const btn = this.actionEl;
    if (btn) btn.disabled = true;
    try {
      await this.deps.ensureOrchestrator();
    } catch (err) {
      new Notice(`Could not set up the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      this.settingUp = false;
      if (btn) btn.disabled = false;
    }
    this.refresh();
    this.focusField();
  }
}
