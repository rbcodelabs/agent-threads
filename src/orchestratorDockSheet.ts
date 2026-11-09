/**
 * orchestratorDockSheet.ts
 *
 * Presentation of the OrchestratorDock reply sheet: the dialog, the keyed transcript
 * reconcile, the live streaming bubble, the activity line, the "Waiting to send" list,
 * suggestion chips and the throttled screen-reader region. It knows nothing about the
 * manager: OrchestratorDock builds a `SheetView` and calls `render`.
 *
 * Every model-controlled string (message text while streaming, queued text, activity,
 * link labels) is written with textContent; assistant markdown goes through dockMarkdown.
 */
import { renderDockMarkdown } from './dockMarkdown';
import type { Richness, SheetEntry } from './dockSheetModel';
import type { SuggestionChip, ThreadRef } from './orchestratorDockModel';

export interface SheetRow extends SheetEntry {
  /** The message coalesced into a running turn: show "Sent, will be picked up". */
  pickup: boolean;
}

export type SheetBlock = 'plan' | 'question' | 'permission' | null;

export interface SheetView {
  entries: SheetRow[];
  streaming: string;
  running: boolean;
  activity: string;
  waiting: string[];
  blocked: SheetBlock;
  threads: ThreadRef[];
  chips: SuggestionChip[];
  mode: 'pill' | 'orb';
}

export interface SheetHandlers {
  close(): void;
  openFull(): void;
  openThread(threadId: string): void;
  openLink?(href: string): void;
  removeWaiting(index: number, text: string): void;
  pickChip(chip: SuggestionChip): void;
}

/** Screen-reader announcements for streaming are rate limited so a token stream cannot flood the reader. */
export const ANNOUNCE_MIN_INTERVAL_MS = 4000;
const NEAR_BOTTOM_PX = 48;
let sheetSeq = 0;

interface RowState { row: HTMLElement; key: string; bubble: HTMLElement; pickupEl: HTMLElement | null; renders: number }

function richKey(r: Richness): string { return `${r.images ? 1 : 0}${r.visualize ? 1 : 0}${r.tools}`; }

function describeRich(r: Richness): string {
  const parts: string[] = [];
  if (r.images) parts.push('images');
  if (r.visualize) parts.push('a visualization');
  if (r.tools > 0) parts.push(`${r.tools} tool call${r.tools === 1 ? '' : 's'}`);
  return parts.join(', ');
}

const BLOCK_TEXT: Record<Exclude<SheetBlock, null>, string> = {
  plan: 'The orchestrator has a plan waiting for your review.',
  question: 'The orchestrator has a question waiting for your answer.',
  permission: 'The orchestrator is waiting for a permission decision.',
};

export class DockSheet {
  readonly el: HTMLElement;
  /** The dock moves its single input body here in narrow (bottom sheet) mode. */
  readonly composerSlot: HTMLElement;
  private readonly scrollEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly activityHost: HTMLElement;
  private readonly noticeHost: HTMLElement;
  private readonly waitingHost: HTMLElement;
  private readonly emptyHost: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly orbEl: HTMLElement;
  private readonly rows = new Map<string, RowState>();
  private streamingRow: HTMLElement | null = null;
  private activityText: HTMLElement | null = null;
  private view: SheetView | null = null;
  private opened = false;
  private destroyed = false;
  private lastAnnounceAt = -Infinity;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAnnounce: string | null = null;
  private scrollQueued = false;

  constructor(parent: HTMLElement, private readonly h: SheetHandlers) {
    const id = `ct-orch-sheet-title-${++sheetSeq}`;
    this.el = parent.createDiv({ cls: 'ct-orch-sheet', attr: { role: 'dialog', 'aria-labelledby': id, 'data-testid': 'orchestrator-sheet' } });
    this.el.hidden = true;
    this.el.createDiv({ cls: 'ct-orch-sheet-handle', attr: { 'aria-hidden': 'true' } });

    const head = this.el.createEl('header', { cls: 'ct-orch-sheet-head' });
    this.orbEl = head.createSpan({ cls: 'ct-orch-sheet-orb', attr: { 'aria-hidden': 'true' } });
    this.orbEl.createSpan('ct-orch-sheet-orb-ring');
    this.orbEl.createSpan('ct-orch-sheet-orb-core');
    head.createEl('h2', { cls: 'ct-orch-sheet-title', text: 'Portfolio orchestrator', attr: { id } });
    const full = head.createEl('button', { cls: 'ct-orch-sheet-btn ct-orch-sheet-full', text: 'Open full thread ↗', attr: { type: 'button' } });
    full.addEventListener('click', () => this.h.openFull());
    const close = head.createEl('button', { cls: 'ct-orch-sheet-btn ct-orch-sheet-close', text: '✕', attr: { type: 'button', 'aria-label': 'Close' } });
    close.addEventListener('click', () => this.h.close());

    this.scrollEl = this.el.createDiv('ct-orch-sheet-scroll');
    this.logEl = this.scrollEl.createDiv('ct-orch-sheet-log');
    this.emptyHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.activityHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.noticeHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.waitingHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.composerSlot = this.el.createDiv('ct-orch-sheet-composer');
    this.liveEl = this.el.createDiv({ cls: 'ct-orch-live', attr: { 'aria-live': 'polite', 'aria-atomic': 'true' } });

    this.logEl.addEventListener('click', (e) => this.onLogClick(e));
    // The sheet is a non-modal dialog: Escape inside it closes it (the dock returns focus to the field).
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.h.close(); } });
  }

  get isOpen(): boolean { return this.opened && !this.destroyed; }

  open(): void {
    if (this.destroyed) return;
    this.opened = true;
    this.el.hidden = false;
  }

  close(): void {
    this.opened = false;
    this.el.hidden = true;
  }

  setMaxHeight(px: number | null): void {
    if (px && px > 0) this.el.style.setProperty('--ct-orch-sheet-max', `${Math.round(px)}px`);
    else this.el.style.removeProperty('--ct-orch-sheet-max');
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render(view: SheetView): void {
    if (this.destroyed) return;
    this.view = view;
    const wasPinned = !this.opened || this.nearBottom();
    this.el.dataset.mode = view.mode;
    this.composerSlot.hidden = view.mode !== 'orb';
    this.orbEl.classList.toggle('ct-orch-orb-spinning', view.running);
    this.reconcileRows(view);
    this.renderStreaming(view.streaming);
    this.renderEmpty(view);
    this.renderActivity(view);
    this.renderNotice(view);
    this.renderWaiting(view);
    if (wasPinned) this.scrollToBottom();
  }

  setStreaming(text: string): void {
    if (this.destroyed || !this.view) return;
    this.view = { ...this.view, streaming: text };
    const pinned = this.nearBottom();
    this.renderStreaming(text);
    if (pinned) this.queueScroll();
  }

  setActivity(text: string): void {
    if (this.destroyed || !this.view) return;
    this.view = { ...this.view, activity: text };
    if (this.activityText) this.activityText.textContent = text || 'Working…';
  }

  /**
   * Screen-reader announcement. Throttled (leading edge, latest text wins on the trailing edge)
   * unless `force`, which the finished reply uses so it is never swallowed.
   */
  announce(text: string, force = false): void {
    if (this.destroyed) return;
    const now = Date.now();
    if (force || now - this.lastAnnounceAt >= ANNOUNCE_MIN_INTERVAL_MS) { this.writeLive(text); return; }
    this.pendingAnnounce = text;
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      if (this.pendingAnnounce !== null) this.writeLive(this.pendingAnnounce);
    }, ANNOUNCE_MIN_INTERVAL_MS - (now - this.lastAnnounceAt));
  }

  private writeLive(text: string): void {
    this.lastAnnounceAt = Date.now();
    this.pendingAnnounce = null;
    if (this.announceTimer) { clearTimeout(this.announceTimer); this.announceTimer = null; }
    this.liveEl.textContent = text;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = null;
    this.el.remove();
    this.rows.clear();
  }

  // ── Transcript ────────────────────────────────────────────────────────────

  private reconcileRows(view: SheetView): void {
    const seen = new Set<string>();
    view.entries.forEach((entry, i) => {
      seen.add(entry.id);
      const key = `${entry.role}|${entry.text}|${richKey(entry.rich)}`;
      let st = this.rows.get(entry.id);
      if (!st || st.key !== key) {
        st?.row.remove();
        st = this.buildRow(entry, key, view.threads);
        this.rows.set(entry.id, st);
      }
      this.setPickup(st, entry.pickup);
      const at = this.logEl.children[i] ?? null;
      if (at !== st.row) this.logEl.insertBefore(st.row, at);
    });
    for (const [id, st] of this.rows) {
      if (seen.has(id)) continue;
      st.row.remove();
      this.rows.delete(id);
    }
    // The live bubble always trails the settled rows.
    if (this.streamingRow) this.logEl.append(this.streamingRow);
  }

  private buildRow(entry: SheetRow, key: string, threads: ThreadRef[]): RowState {
    const row = createRow(this.logEl, entry.role, entry.id);
    const bubble = row.createDiv('ct-orch-bubble');
    const st: RowState = { row, key, bubble, pickupEl: null, renders: 0 };
    const rich = describeRich(entry.rich);
    if (entry.text.trim() === '') {
      // Never a blank bubble: say what the message holds.
      bubble.textContent = rich ? `This message has ${rich}.` : '';
    } else if (entry.role === 'assistant') {
      const token = ++st.renders;
      const target = bubble.ownerDocument.createElement('div');
      void renderDockMarkdown(entry.text, target, { threads }).then(() => {
        if (this.destroyed || token !== st.renders) return;
        bubble.replaceChildren(...Array.from(target.childNodes));
      }).catch(() => { if (token === st.renders && !this.destroyed) bubble.textContent = entry.text; });
    } else {
      bubble.textContent = entry.text;
    }
    if (rich) {
      const chip = row.createEl('button', { cls: 'ct-orch-chip-full', text: 'Open full thread ↗', attr: { type: 'button' } });
      chip.addEventListener('click', () => this.h.openFull());
    }
    return st;
  }

  private setPickup(st: RowState, on: boolean): void {
    if (on && !st.pickupEl) st.pickupEl = st.row.createDiv({ cls: 'ct-orch-pickup', text: 'Sent, will be picked up' });
    else if (!on && st.pickupEl) { st.pickupEl.remove(); st.pickupEl = null; }
  }

  private renderStreaming(text: string): void {
    if (!text) { this.streamingRow?.remove(); this.streamingRow = null; return; }
    if (!this.streamingRow) {
      // aria-live off: the throttled region below is what screen readers hear while tokens arrive.
      this.streamingRow = createRow(this.logEl, 'assistant', 'streaming');
      this.streamingRow.dataset.streaming = 'true';
      this.streamingRow.setAttribute('aria-live', 'off');
      this.streamingRow.createDiv('ct-orch-bubble ct-orch-bubble-streaming');
    }
    this.logEl.append(this.streamingRow);
    (this.streamingRow.firstElementChild as HTMLElement).textContent = text;
  }

  private renderEmpty(view: SheetView): void {
    this.emptyHost.empty();
    if (view.entries.length > 0 || view.streaming) return;
    if (view.mode === 'orb' && view.chips.length > 0) {
      const box = this.emptyHost.createDiv('ct-orch-empty');
      box.createSpan({ cls: 'ct-orch-empty-label', text: 'Try:' });
      for (const chip of view.chips) {
        const b = box.createEl('button', { cls: 'ct-orch-chip', text: chip.label, attr: { type: 'button' } });
        b.addEventListener('click', () => this.h.pickChip(chip));
      }
    } else {
      this.emptyHost.createDiv({ cls: 'ct-orch-empty-note', text: 'No messages yet.' });
    }
  }

  private renderActivity(view: SheetView): void {
    if (!view.running) { this.activityHost.empty(); this.activityText = null; return; }
    if (!this.activityText) {
      this.activityHost.empty();
      const line = this.activityHost.createDiv('ct-orch-activity');
      line.createSpan({ cls: 'ct-orch-activity-spin', attr: { 'aria-hidden': 'true' } });
      this.activityText = line.createSpan('ct-orch-activity-text');
    }
    this.activityText.textContent = view.activity || 'Working…';
  }

  private renderNotice(view: SheetView): void {
    this.noticeHost.empty();
    if (!view.blocked) return;
    const box = this.noticeHost.createDiv('ct-orch-notice');
    box.createSpan({ text: BLOCK_TEXT[view.blocked] });
    const chip = box.createEl('button', { cls: 'ct-orch-chip-full', text: 'Open full thread ↗', attr: { type: 'button' } });
    chip.addEventListener('click', () => this.h.openFull());
  }

  private renderWaiting(view: SheetView): void {
    this.waitingHost.empty();
    if (view.waiting.length === 0) return;
    const box = this.waitingHost.createEl('section', { cls: 'ct-orch-waiting' });
    box.createEl('h3', { cls: 'ct-orch-waiting-title', text: 'Waiting to send' });
    const list = box.createEl('ul');
    view.waiting.forEach((text, index) => {
      const li = list.createEl('li');
      li.createSpan({ cls: 'ct-orch-waiting-text', text });
      const rm = li.createEl('button', {
        cls: 'ct-orch-sheet-btn ct-orch-waiting-remove', text: '✕',
        attr: { type: 'button', 'aria-label': `Remove "${text.length > 40 ? `${text.slice(0, 40)}…` : text}" from waiting to send` },
      });
      rm.addEventListener('click', () => this.h.removeWaiting(index, text));
    });
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  private onLogClick(e: MouseEvent): void {
    const a = (e.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const threadId = a.getAttribute('data-thread-id');
    if (threadId) { this.h.openThread(threadId); return; }
    const href = a.getAttribute('data-href');
    if (href) { this.h.openLink?.(href); return; }
    const plain = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(plain)) window.open(plain, '_blank', 'noopener,noreferrer');
  }

  private nearBottom(): boolean {
    const s = this.scrollEl;
    return s.scrollHeight - s.scrollTop - s.clientHeight <= NEAR_BOTTOM_PX;
  }

  private scrollToBottom(): void { this.scrollEl.scrollTop = this.scrollEl.scrollHeight; }

  private queueScroll(): void {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    const run = (): void => { this.scrollQueued = false; if (!this.destroyed) this.scrollToBottom(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
  }
}

function createRow(log: HTMLElement, role: 'user' | 'assistant', id: string): HTMLElement {
  return log.createDiv({ cls: 'ct-orch-msg', attr: { 'data-role': role, 'data-id': id } });
}
