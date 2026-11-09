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
import { setIcon } from 'obsidian';
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
  /** Partial reply of an interrupted turn (the manager does not persist it): shown dimmed, labelled "Stopped". */
  stopped: string;
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
  /** False: a `[[note]]` renders as inert text (unresolved, or the host cannot open links). */
  resolveLink?(href: string): boolean;
  removeWaiting(index: number, text: string): void;
  pickChip(chip: SuggestionChip): void;
}

/** Screen-reader announcements for streaming are rate limited so a token stream cannot flood the reader. */
export const ANNOUNCE_MIN_INTERVAL_MS = 4000;
const NEAR_BOTTOM_PX = 48;
/** Re-pin tolerance when the user scrolls down: they have to actually get to the bottom. */
const BOTTOM_SLACK_PX = 4;
let sheetSeq = 0;
const TABBABLE = 'button, a[href], textarea, input, select, summary, [tabindex]:not([tabindex="-1"])';

interface RowState { row: HTMLElement; key: string; bubble: HTMLElement; pickupEl: HTMLElement | null }

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
  /** The user is at the bottom (updated by scroll events and programmatic pins): the pin survives content growing under it. */
  private stick = true;
  /** The scrollTop value the sheet itself last wrote, and the scrollHeight at that moment / at the last scroll event. */
  private lastWrittenTop = -1;
  /** scrollTop at the previous scroll event (or our last write): the reference for the direction of travel. */
  private lastTop = 0;
  private lastHeight = 0;
  /** Pin to the latest message on the next render (open, or the user's own send), however far up they had scrolled. */
  private pinNext = false;
  private closeBtn: HTMLButtonElement;
  private streamFrame = false;
  private stoppedRow: HTMLElement | null = null;
  /** Exactly the nodes WE made inert (an `inert` someone else set is never ours to remove). */
  private readonly inerted = new Set<Element>();
  /** Content signatures: a section is rebuilt only when what it shows changed (focus + clicks survive refreshes). */
  private sig = { empty: '', notice: '', waiting: '' };

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
    // Narrow mode hides the label (mock k2-9 shows just the arrow): the aria-label keeps the name.
    const full = head.createEl('button', { cls: 'ct-orch-sheet-btn ct-orch-sheet-full', attr: { type: 'button', 'aria-label': 'Open full thread' } });
    full.createSpan({ cls: 'ct-orch-sheet-full-label', text: 'Open full thread' });
    icon(full, 'external-link');
    full.addEventListener('click', () => this.h.openFull());
    const close = head.createEl('button', { cls: 'ct-orch-sheet-btn ct-orch-sheet-close', attr: { type: 'button', 'aria-label': 'Close' } });
    icon(close, 'x');
    close.addEventListener('click', () => this.h.close());
    this.closeBtn = close;

    this.scrollEl = this.el.createDiv('ct-orch-sheet-scroll');
    this.logEl = this.scrollEl.createDiv('ct-orch-sheet-log');
    this.emptyHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.activityHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.noticeHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.waitingHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.composerSlot = this.el.createDiv('ct-orch-sheet-composer');
    this.liveEl = this.el.createDiv({ cls: 'ct-orch-live', attr: { 'aria-live': 'polite', 'aria-atomic': 'true' } });

    this.logEl.addEventListener('click', (e) => this.onLogClick(e));
    // Middle-click / auxclick must not navigate either (an anchor with an href would otherwise open in a new tab/window).
    this.logEl.addEventListener('auxclick', (e) => { if ((e.target as HTMLElement | null)?.closest?.('a')) { e.preventDefault(); e.stopPropagation(); } });
    // Pinned-ness is decided by WHO moved the scroll position, not by timing or input events: a scroll whose scrollTop equals the
    // value the sheet last wrote is ours (or layout growth after it) and never unpins; any other position is the user (wheel, touch
    // momentum, scrollbar, keys, selection autoscroll all end up here) and is judged against the content height they were looking
    // at, so reaching the bottom while content is still growing keeps the pin.
    this.scrollEl.addEventListener('scroll', () => {
      const sc = this.scrollEl;
      const top = sc.scrollTop;
      if (top !== this.lastWrittenTop) {
        if (top < this.lastTop) this.stick = false; // ANY upward movement unpins at once, however slow or small
        else {
          // Downward: re-pin only on reaching the bottom (a few px), judged against the content height the user was looking at.
          const seenHeight = this.lastHeight > 0 ? Math.min(sc.scrollHeight, this.lastHeight) : sc.scrollHeight;
          if (seenHeight - top - sc.clientHeight <= BOTTOM_SLACK_PX) this.stick = true;
        }
      }
      this.lastTop = top;
      this.lastHeight = sc.scrollHeight;
    });
    // The sheet is a non-modal dialog: Escape inside it closes it (the dock returns focus to the field).
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && this.view?.mode === 'orb') { this.trapTab(e); return; }
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return; // Escape cancels an IME composition, not the sheet
      e.stopPropagation();
      this.h.close();
    });
  }

  get isOpen(): boolean { return this.opened && !this.destroyed; }

  open(): void {
    if (this.destroyed) return;
    if (!this.opened) { this.stick = true; this.pinNext = true; } // opening lands on the latest message
    this.opened = true;
    this.el.hidden = false;
  }

  close(): void {
    this.opened = false;
    this.el.hidden = true;
    this.setModal(false);
  }

  /**
   * The narrow bottom sheet is modal: everything it covers (the board, the pill's other controls, the dock's own field) is
   * `inert` while it is open, so neither Tab nor assistive tech can reach behind it. Siblings of the sheet and of each
   * ancestor up to the view root; the ancestors themselves stay live.
   */
  private setModal(on: boolean): void {
    if (!on) { for (const n of this.inerted) n.removeAttribute('inert'); this.inerted.clear(); return; }
    // Re-evaluated on every render: nodes the board added while the sheet is open become inert too.
    const doc = this.el.ownerDocument;
    const boundary = this.el.closest('.ct-agents-root') ?? doc.body;
    for (let node: Element = this.el; node !== boundary && node.parentElement; node = node.parentElement) {
      for (const sib of Array.from(node.parentElement.children)) {
        if (sib === node || this.inerted.has(sib) || sib.hasAttribute('inert')) continue;
        sib.setAttribute('inert', '');
        this.inerted.add(sib);
      }
    }
  }


  /** Narrow bottom sheet is modal: Tab wraps inside it instead of walking into the covered board and pill. */
  private trapTab(e: KeyboardEvent): void {
    const list = Array.from(this.el.querySelectorAll<HTMLElement>(TABBABLE))
      .filter((n) => !n.hidden && !(n as HTMLButtonElement).disabled && !n.closest('[hidden]'));
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = this.el.ownerDocument.activeElement;
    if (e.shiftKey && (active === first || !this.el.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !this.el.contains(active))) { e.preventDefault(); first.focus(); }
  }

  /** Pin to the latest message on the next render. */
  pinOnNextRender(): void { this.pinNext = true; }

  /** Whether focus can sit on this element now (connected, not hidden, not inert). */
  isFocusable(node: Element | null): boolean {
    return !!node && node.isConnected && !node.closest('[hidden], [inert]') && !(node as HTMLButtonElement).disabled;
  }

  /** Moves focus to the first control of the dialog (used when it opens and the composer has nothing to focus). */
  focusClose(): void { this.closeBtn.focus(); }

  setMaxHeight(px: number | null): void {
    if (px && px > 0) this.el.style.setProperty('--ct-orch-sheet-max', `${Math.round(px)}px`);
    else this.el.style.removeProperty('--ct-orch-sheet-max');
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render(view: SheetView): void {
    if (this.destroyed) return;
    this.view = view;
    const wasPinned = !this.opened || this.stick || this.pinNext;
    this.el.dataset.mode = view.mode;
    if (view.mode === 'orb') this.el.setAttribute('aria-modal', 'true'); else this.el.removeAttribute('aria-modal');
    this.setModal(this.opened && view.mode === 'orb');
    this.composerSlot.hidden = view.mode !== 'orb';
    this.orbEl.classList.toggle('ct-orch-orb-spinning', view.running);
    this.reconcileRows(view);
    this.renderStreaming(view.streaming);
    this.renderStopped(view.stopped);
    this.renderEmpty(view);
    this.renderActivity(view);
    this.renderNotice(view);
    this.renderWaiting(view);
    if (wasPinned) this.scrollToBottom();
    // Layout (fonts, the markdown swap) settles after this frame: pin again once it has.
    if (this.pinNext) { this.pinNext = false; this.queueScroll(); }
  }

  setStreaming(text: string): void {
    if (this.destroyed || !this.view) return;
    this.view = { ...this.view, streaming: text };
    // Coalesce: one DOM write per frame however many tokens arrived (assigning the whole buffer per token is O(n^2)).
    if (!text || !this.streamingRow) { this.renderStreaming(text); if (text && this.stick) this.queueScroll(); return; }
    if (this.streamFrame) return;
    this.streamFrame = true;
    schedule(() => {
      this.streamFrame = false;
      // Always the CURRENT buffer: a render() between the token and the frame (message / interrupted / done) clears it, and a
      // stale frame must never re-create the bubble it removed.
      const current = this.view?.streaming ?? '';
      if (this.destroyed || !current || !this.streamingRow) return;
      const pinned = this.stick;
      this.renderStreaming(current);
      if (pinned) this.scrollToBottom();
    });
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
    this.setModal(false);
    this.el.remove();
    this.rows.clear();
  }

  // ── Transcript ────────────────────────────────────────────────────────────

  private reconcileRows(view: SheetView): void {
    const seen = new Set<string>();
    const resolvedLinks = new Map<string, boolean>();
    view.entries.forEach((entry, i) => {
      seen.add(entry.id);
      const key = `${entry.role}|${entry.text}|${richKey(entry.rich)}|${entry.role === 'assistant' ? this.linkSignature(entry.text, view.threads, resolvedLinks) : ''}`;
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

  /**
   * What link rendering depends on besides the text: whether each `[[note]]` currently resolves and the titles of
   * threads referenced by title-only `[[thread:...]]` links. A note created later or a renamed thread then re-renders the row.
   */
  private linkSignature(text: string, threads: ThreadRef[], resolved: Map<string, boolean>): string {
    if (!text.includes('[[')) return '';
    const parts: string[] = [];
    for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
      const target = m[1].trim();
      if (target.startsWith('thread:')) {
        const ref = target.slice('thread:'.length).trim();
        parts.push(`${ref}=${threads.find((t) => t.id === ref)?.title ?? threads.filter((t) => t.title === ref).length}`);
      } else {
        // One resolver call per distinct target per render, however many rows mention it.
        if (!resolved.has(target) && this.h.resolveLink) resolved.set(target, this.h.resolveLink(target));
        parts.push(`${target}=${this.h.resolveLink ? (resolved.get(target) ? 1 : 0) : 'x'}`);
      }
    }
    return parts.join(';');
  }

  private buildRow(entry: SheetRow, key: string, threads: ThreadRef[]): RowState {
    const row = createRow(this.logEl, entry.role, entry.id);
    const bubble = row.createDiv('ct-orch-bubble');
    const st: RowState = { row, key, bubble, pickupEl: null };
    const rich = describeRich(entry.rich);
    if (entry.text.trim() === '') {
      // Never a blank bubble: say what the message holds.
      bubble.textContent = rich ? `This message has ${rich}.` : '';
    } else if (entry.role === 'assistant') {
      // Seeded with the plain text so the row is never empty while markdown renders (the streamed text it replaces
      // is removed in the same render); swapped for markdown when it resolves. An empty result keeps the text.
      bubble.textContent = entry.text;
      const target = bubble.ownerDocument.createElement('div');
      void renderDockMarkdown(entry.text, target, { threads, resolveLink: this.h.resolveLink }).then(() => {
        if (this.destroyed || this.rows.get(entry.id) !== st || target.childNodes.length === 0) return;
        const pinned = this.stick;
        bubble.replaceChildren(...Array.from(target.childNodes));
        if (pinned) this.scrollToBottom();
      }).catch(() => { /* keep the plain-text seed */ });
    } else {
      bubble.textContent = entry.text;
    }
    if (rich) {
      const chip = fullChip(row);
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

  private renderStopped(text: string): void {
    if (!text) { this.stoppedRow?.remove(); this.stoppedRow = null; return; }
    if (!this.stoppedRow) {
      this.stoppedRow = createRow(this.logEl, 'assistant', 'stopped');
      this.stoppedRow.dataset.stopped = 'true';
      this.stoppedRow.createDiv('ct-orch-bubble ct-orch-bubble-stopped');
      this.stoppedRow.createDiv({ cls: 'ct-orch-stopped-label', text: 'Stopped' });
    }
    this.logEl.append(this.stoppedRow);
    (this.stoppedRow.firstElementChild as HTMLElement).textContent = text;
  }

  private renderEmpty(view: SheetView): void {
    const showing = view.entries.length === 0 && !view.streaming && !view.stopped;
    const sig = showing ? `${view.mode}|${view.chips.map((c) => c.id).join(',')}` : '';
    if (sig === this.sig.empty) return;
    this.sig.empty = sig;
    this.emptyHost.empty();
    if (!showing) return;
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
    const sig = view.blocked ?? '';
    if (sig === this.sig.notice) return;
    this.sig.notice = sig;
    this.noticeHost.empty();
    if (!view.blocked) return;
    const box = this.noticeHost.createDiv('ct-orch-notice');
    box.createSpan({ text: BLOCK_TEXT[view.blocked] });
    const chip = fullChip(box);
    chip.addEventListener('click', () => this.h.openFull());
  }

  private renderWaiting(view: SheetView): void {
    const sig = JSON.stringify(view.waiting);
    if (sig === this.sig.waiting) return;
    this.sig.waiting = sig;
    this.waitingHost.empty();
    if (view.waiting.length === 0) return;
    const box = this.waitingHost.createEl('section', { cls: 'ct-orch-waiting' });
    box.createEl('h3', { cls: 'ct-orch-waiting-title', text: 'Waiting to send' });
    const list = box.createEl('ul');
    view.waiting.forEach((text, index) => {
      const li = list.createEl('li');
      li.createSpan({ cls: 'ct-orch-waiting-text', text });
      const rm = li.createEl('button', {
        cls: 'ct-orch-sheet-btn ct-orch-waiting-remove',
        attr: { type: 'button', 'aria-label': `Remove "${text.length > 40 ? `${text.slice(0, 40)}…` : text}" from waiting to send` },
      });
      icon(rm, 'x');
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

  private scrollToBottom(): void {
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    this.lastWrittenTop = this.scrollEl.scrollTop; // read back: the browser clamps to the real maximum
    this.lastTop = this.lastWrittenTop;
    this.lastHeight = this.scrollEl.scrollHeight;
    this.stick = true;
  }

  private queueScroll(): void {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    const run = (): void => { this.scrollQueued = false; if (!this.destroyed && this.stick) this.scrollToBottom(); }; // not if the user scrolled up meanwhile
    schedule(run);
  }
}

function schedule(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn); else setTimeout(fn, 16);
}

function createRow(log: HTMLElement, role: 'user' | 'assistant', id: string): HTMLElement {
  return log.createDiv({ cls: 'ct-orch-msg', attr: { 'data-role': role, 'data-id': id } });
}

function icon(parent: HTMLElement, name: string): void {
  const span = parent.createSpan({ cls: 'ct-orch-icon', attr: { 'aria-hidden': 'true' } });
  setIcon(span, name);
}

/** The quiet "Open full thread" chip: lucide icon, not a font-dependent arrow glyph. */
function fullChip(parent: HTMLElement): HTMLButtonElement {
  const chip = parent.createEl('button', { cls: 'ct-orch-chip-full', attr: { type: 'button', 'aria-label': 'Open full thread' } });
  chip.createSpan({ text: 'Open full thread' });
  icon(chip, 'external-link');
  return chip;
}
