/**
 * orchestratorDockSheet.ts
 *
 * Presentation of the OrchestratorDock reply sheet: the dialog, the keyed transcript
 * reconcile, the live streaming bubble, the activity line, the "Waiting to send" list,
 * suggestion chips and the throttled screen-reader region. It knows nothing about the
 * manager: OrchestratorDock builds a `SheetView` and calls `render`.
 *
 * Messages render IDENTICALLY to the main panel: the sheet's rows are the shared renderer's `.ct-message` rows (density
 * 'full', trusted link policy, the same tool-call renderer, the same merge of adjacent tool-only messages), inside a log
 * that carries the main panel's tool-call style class. Only the container and the chrome around it are the sheet's:
 * the streaming bubble's position, the activity line, suggestion chips, "Waiting to send", the "Open full thread" chip,
 * the pickup label, the unread peek, the scroll pin and the link-hover highlight. Model-controlled text that is not
 * markdown (queued text, activity, the stopped partial) is written with textContent.
 */
import { setIcon } from 'obsidian';
import { renderMarkdown, renderMessage } from './messageRenderer';
import { applyToolCallStyleClass } from './toolCallDom';
import { rewriteThreadLinks, threadIdOfHref } from './orchestratorDockModel';
import type { DockMessageEnv } from './dockMessageEnv';
import type { ChatMessage } from './types';
import { applyTrayMode } from './orchestratorDockTray';
import { SHEET_MAX_MESSAGES, needsFullThread, sheetFit, trayLayout, type SheetEntry } from './dockSheetModel';
import type { SuggestionChip, ThreadRef } from './orchestratorDockModel';
import { rowAriaLabel, type TargetRow } from './dockTargetModel';

export interface SheetRow extends SheetEntry {
  /** The message coalesced into a running turn: show "Sent, will be picked up". */
  pickup: boolean;
}

export type SheetBlock = 'plan' | 'question' | 'permission' | null;

export interface SheetView {
  entries: SheetRow[];
  /** How many older messages are not drawn (the sheet shows the last SHEET_MAX_MESSAGES). */
  older: number;
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
  /** tooltipText({running,total,needsYou}): the same string as the dot's tooltip. */
  summary: string;
  /** The heading text: "Portfolio orchestrator" or "<Project> orchestrator" (targetLabels). */
  title: string;
  /** aria-label of the scrolling transcript region. */
  regionLabel: string;
  /** The orchestrator menu behind the title; null = the title is a plain heading (no Project orchestrator exists). */
  menu: SheetMenu | null;
}

export interface SheetMenu {
  rows: TargetRow[];
  selectedId: string;
}

export interface SheetHandlers {
  close(): void;
  openFull(): void;
  /** The user picked an orchestrator in the title menu (the dock switches the whole sheet to it). */
  selectTarget(threadId: string): void;
  /** The title menu is about to show: the dock re-renders so its rows (draft marks, unread, status) are current. */
  menuOpened(): void;
  /** Source for an attached / tool-result image (a vault resource URL or a data URL). Absent: a data URL. */
  imageSrc?(ref: { path?: string; mediaType: string }, inlineData: string | undefined): string;
  /** The shared renderer's host, tool-call renderer, clock and tool-call style (dockMessageEnv). */
  messages: DockMessageEnv;
  removeWaiting(index: number, text: string): void;
  pickChip(chip: SuggestionChip): void;
  /** Pointer hover or keyboard focus entered a `[[thread:...]]` link: the host highlights that thread's card. */
  linkEnter(threadId: string): void;
  /** The pointer / focus left it, it was removed from the DOM, or the sheet closed. */
  linkLeave(): void;
}

/** Screen-reader announcements for streaming are rate limited so a token stream cannot flood the reader. */
export const ANNOUNCE_MIN_INTERVAL_MS = 4000;
const NEAR_BOTTOM_PX = 48;
/** Padding under the tray's first card (part of the room its floor needs). */
const TRAY_PAD_PX = 8;
/** The collapsed tray's one row: the heading (~26px) plus the tray's own 8px top and bottom padding. */
const COLLAPSED_ROW_PX = 42;
/** Below this sheet height the header's count line is dropped so the heading + a card still fit. */
const TIGHT_SHEET_PX = 160;
/** Re-pin tolerance when the user scrolls down: they have to actually get to the bottom. */
const BOTTOM_SLACK_PX = 4;
let sheetSeq = 0;
const TABBABLE = 'button, a[href], textarea, input, select, summary, [tabindex]:not([tabindex="-1"])';

interface RowState { row: HTMLElement; key: string; pickupEl: HTMLElement | null }

/** What a row's DOM depends on besides its text: the tool calls (names, state), the images and the notice / divider fields. */
function messageKey(entry: SheetRow): string {
  const msg = entry.message as Partial<ChatMessage>;
  const tools = (msg.toolCalls ?? []).map((t) => `${t.name}:${t.status ?? ''}:${t.summary ?? ''}`).join(',');
  const images = `${msg.images?.length ?? 0}/${msg.toolResultImages?.length ?? 0}`;
  return `${tools}|${images}|${msg.cost ?? ''}|${msg.noticeStatus ?? ''}|${msg.compactTrigger ?? ''}|${msg.preTokens ?? ''}|${needsFullThread(entry.rich) ? 1 : 0}`;
}

const defaultImageSrc = (ref: { mediaType: string }, inline: string | undefined): string => `data:${ref.mediaType};base64,${inline ?? ''}`;

const BLOCK_TEXT: Record<Exclude<SheetBlock, null>, string> = {
  plan: 'The orchestrator has a plan waiting for your review.',
  question: 'The orchestrator has a question waiting for your answer.',
  permission: 'The orchestrator is waiting for a permission decision.',
};

export class DockSheet {
  readonly el: HTMLElement;
  /** The dock moves its single input body here in narrow (bottom sheet) mode. */
  readonly composerSlot: HTMLElement;
  /** The Needs-you tray lives here: inside the dialog (so inside the narrow focus trap), between the transcript and the composer. */
  readonly trayHost: HTMLElement;
  /** Needs-you arrivals have their OWN polite region: the one below carries streaming / finished-reply text and identical repeats are silent. */
  private readonly trayLiveEl: HTMLElement;
  private trayLiveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scrollEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly activityHost: HTMLElement;
  private readonly noticeHost: HTMLElement;
  private readonly waitingHost: HTMLElement;
  private readonly emptyHost: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly orbEl: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private chromeObserver: ResizeObserver | null = null;
  private trayFocus: { threadId: string | null; role: string } | null = null;
  private focusGuard = 0;
  private onDocFocusIn: (e: Event) => void = () => {};
  private onDocPointerDown: (e: Event) => void = () => {};
  private readonly headEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly headingEl: HTMLElement;
  private readonly menuId: string;
  /** The title menu (button + listbox), present only while the view carries a menu. */
  private titleBtn: HTMLButtonElement | null = null;
  private menuEl: HTMLElement | null = null;
  private menuIsOpen = false;
  private menuSig = '';
  private onDocPointerDownMenu: (e: Event) => void = () => {};
  private readonly rows = new Map<string, RowState>();
  private olderEl: HTMLElement | null = null;
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
  /** Our last scrollTop assignment really moved the position, so exactly one scroll event is its echo. */
  private echoPending = false;
  /** scrollTop at the previous scroll event (or our last write): the reference for the direction of travel. */
  private lastTop = 0;
  private lastHeight = 0;
  /** Pin to the latest message on the next render (open, or the user's own send), however far up they had scrolled. */
  private pinNext = false;
  private closeBtn: HTMLButtonElement;
  private streamFrame = false;
  /** Bumped per streaming markdown render and on teardown: only the latest result may touch the bubble. */
  private streamRenderSeq = 0;
  private stoppedRow: HTMLElement | null = null;
  /** Exactly the nodes WE made inert (an `inert` someone else set is never ours to remove). */
  private readonly inerted = new Set<Element>();
  /** Content signatures: a section is rebuilt only when what it shows changed (focus + clicks survive refreshes). */
  private sig = { empty: '', notice: '', waiting: '' };
  /** The thread-link anchor (`a.internal-link[data-href^="thread:"]`) currently hovered / focused (its card is highlighted on the board). */
  private hoverEl: HTMLElement | null = null;

  constructor(parent: HTMLElement, private readonly h: SheetHandlers) {
    const id = `ct-orch-sheet-title-${++sheetSeq}`;
    this.el = parent.createDiv({ cls: 'ct-orch-sheet', attr: { role: 'dialog', 'aria-labelledby': id, 'data-testid': 'orchestrator-sheet' } });
    this.el.hidden = true;
    this.el.createDiv({ cls: 'ct-orch-sheet-handle', attr: { 'aria-hidden': 'true' } });

    const head = this.el.createEl('header', { cls: 'ct-orch-sheet-head' });
    this.orbEl = head.createSpan({ cls: 'ct-orch-sheet-orb', attr: { 'aria-hidden': 'true' } });
    this.orbEl.createSpan('ct-orch-sheet-orb-ring');
    this.orbEl.createSpan('ct-orch-sheet-orb-core');
    const heading = head.createDiv('ct-orch-sheet-heading');
    this.headingEl = heading;
    this.menuId = `${id}-menu`;
    this.titleEl = heading.createEl('h2', { cls: 'ct-orch-sheet-title', text: 'Portfolio orchestrator', attr: { id } });
    // The old header count text, readable without hover (touch): the SAME text as the dot tooltip. Plain text, not a live region.
    this.summaryEl = heading.createDiv({ cls: 'ct-orch-sheet-summary', attr: { 'data-testid': 'orchestrator-summary' } });
    // Narrow mode hides the label (mock k2-9 shows just the arrow): the aria-label keeps the name.
    const full = head.createEl('button', { cls: 'ct-orch-sheet-btn ct-orch-sheet-full', attr: { type: 'button', 'aria-label': 'Open full thread' } });
    full.createSpan({ cls: 'ct-orch-sheet-full-label', text: 'Open full thread' });
    icon(full, 'external-link');
    full.addEventListener('click', () => this.h.openFull());
    const close = head.createEl('button', { cls: 'ct-orch-sheet-btn ct-orch-sheet-close', attr: { type: 'button', 'aria-label': 'Close' } });
    icon(close, 'x');
    close.addEventListener('click', () => this.h.close());
    this.closeBtn = close;

    // Keyboard reachable (it scrolls): a labelled region, not role=log (a log is implicitly aria-live and would read every token).
    this.scrollEl = this.el.createDiv({ cls: 'ct-orch-sheet-scroll', attr: { tabindex: '0', role: 'region', 'aria-label': 'Conversation with the portfolio orchestrator' } });
    this.logEl = this.scrollEl.createDiv('ct-orch-sheet-log');
    this.emptyHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.activityHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.noticeHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.waitingHost = this.scrollEl.createDiv('ct-orch-sheet-slot');
    this.trayHost = this.el.createDiv('ct-orch-tray-slot');
    this.composerSlot = this.el.createDiv('ct-orch-sheet-composer');
    this.liveEl = this.el.createDiv({ cls: 'ct-orch-live', attr: { 'aria-live': 'polite', 'aria-atomic': 'true' } });
    this.trayLiveEl = this.el.createDiv({ cls: 'ct-orch-tray-live', attr: { 'aria-live': 'polite', 'aria-atomic': 'true' } });

    this.headEl = head;
    // Which tray control holds focus (by card + role), so a re-form of the tray can put focus back; forgotten when the user moves on.
    const doc = this.el.ownerDocument;
    this.onDocFocusIn = (e) => { this.trayFocus = this.identify(e.target); };
    this.onDocPointerDown = (e) => { if (!this.trayHost.contains(e.target as Node | null)) this.trayFocus = null; };
    doc.addEventListener('focusin', this.onDocFocusIn, true);
    doc.addEventListener('pointerdown', this.onDocPointerDown, true);
    // A press outside the title button and the menu closes the menu (the sheet stays); focus is left where the press put it.
    this.onDocPointerDownMenu = (e) => { if (this.menuIsOpen && !this.headEl.contains(e.target as Node | null)) this.closeMenu(false); };
    doc.addEventListener('pointerdown', this.onDocPointerDownMenu, true);
    this.logEl.addEventListener('click', (e) => this.onLogClick(e));
    // Delegated, so rows rebuilt by the keyed reconcile / markdown swap need no re-binding.
    this.logEl.addEventListener('mouseover', (e) => this.onLinkOver(e));
    this.logEl.addEventListener('mouseout', (e) => this.onLinkOut(e));
    this.logEl.addEventListener('focusin', (e) => this.onLinkOver(e));
    this.logEl.addEventListener('focusout', (e) => this.onLinkOut(e));
    // Middle-click / auxclick must not navigate either (an anchor with an href would otherwise open in a new tab/window).
    this.logEl.addEventListener('auxclick', (e) => { if ((e.target as HTMLElement | null)?.closest?.('a')) { e.preventDefault(); e.stopPropagation(); } });
    // Pinned-ness is decided by WHO moved the scroll position, not by timing or input events: a scroll whose scrollTop equals the
    // value the sheet last wrote is ours (or layout growth after it) and never unpins; any other position is the user (wheel, touch
    // momentum, scrollbar, keys, selection autoscroll all end up here) and is judged against the content height they were looking
    // at, so reaching the bottom while content is still growing keeps the pin.
    this.scrollEl.addEventListener('scroll', () => {
      const sc = this.scrollEl;
      const top = sc.scrollTop;
      // The echo of OUR assignment (one event per assignment that moved the position) never changes the pin. Anything else is the
      // user, including arriving at a scrollTop that equals our last write: with no content added since, the bottom IS that value.
      const echo = this.echoPending && top === this.lastWrittenTop;
      this.echoPending = false;
      if (!echo) {
        const distance = sc.scrollHeight - top - sc.clientHeight;
        if (top < this.lastTop) {
          // Upward movement unpins at once, however small, but only if it LEAVES a real distance from the bottom: the browser
          // clamping scrollTop when content shrinks under a pinned user (bubble swapped for the final row, a Stopped row removed,
          // a resize, iOS rubber-banding) also lowers scrollTop, with the user still at the bottom.
          if (distance > BOTTOM_SLACK_PX) this.stick = false;
        } else {
          // Downward / unchanged: re-pin on reaching the bottom (a few px), judged against the content height the user was looking at.
          const seenHeight = this.lastHeight > 0 ? Math.min(sc.scrollHeight, this.lastHeight) : sc.scrollHeight;
          if (seenHeight - top - sc.clientHeight <= BOTTOM_SLACK_PX) this.stick = true;
        }
      }
      this.lastTop = top;
      this.lastHeight = sc.scrollHeight;
    });
    // End is an explicit re-pin: it cancels any in-flight smooth scroll (a programmatic assignment does) and snaps to the LIVE
    // bottom instead of the bottom at press time. Home is an explicit unpin. PageUp / PageDown stay native; the scroll events
    // they produce are judged like any other user scroll.
    this.scrollEl.addEventListener('keydown', (e) => {
      // From ANY focus inside the log (the scroller, a thread link, a button in a bubble): a focused link must not fall through to the
      // native End (which stops following). Editable controls keep their caret movement; modified keys stay native.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isEditable(e.target)) return;
      if (e.key === 'End') { e.preventDefault(); this.scrollToBottom(); }
      else if (e.key === 'Home') { e.preventDefault(); this.scrollEl.scrollTop = 0; this.lastTop = 0; this.stick = false; }
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
    this.observeChrome();
  }

  /**
   * While open, the composer (a taller textarea, a wrapped error reason) and the header change what is left for the tray:
   * re-fit it when they resize. Not observed while closed.
   */
  private observeChrome(): void {
    if (this.chromeObserver || typeof ResizeObserver === 'undefined') return;
    this.chromeObserver = new ResizeObserver(() => { if (this.opened && !this.destroyed) this.keepPinned(() => this.fitTray()); });
    this.chromeObserver.observe(this.headEl);
    this.chromeObserver.observe(this.composerSlot);
  }

  close(): void {
    this.closeMenu(false);
    this.opened = false;
    this.chromeObserver?.disconnect();
    this.chromeObserver = null;
    this.el.hidden = true;
    this.setModal(false);
    this.leaveLink();
  }

  /**
   * The narrow bottom sheet is modal: everything it covers (the board, the pill's other controls, the dock's own field) is
   * `inert` while it is open, so neither Tab nor assistive tech can reach behind it. Siblings of the sheet and of each
   * ancestor up to the view root; the ancestors themselves stay live.
   */
  private setModal(on: boolean): void {
    if (!on) { for (const n of this.inerted) n.removeAttribute('inert'); this.inerted.clear(); return; }
    // Re-evaluated on every render: nodes the board added while the sheet is open become inert too, and an `inert` a third
    // party removed from a node we own is put back; nodes that left the DOM are forgotten.
    for (const n of Array.from(this.inerted)) {
      if (!n.isConnected) this.inerted.delete(n);
      else if (!n.hasAttribute('inert')) n.setAttribute('inert', '');
    }
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
    if (!node || !node.isConnected || node.closest('[hidden], [inert]') || (node as HTMLButtonElement).disabled) return false;
    const view = node.ownerDocument.defaultView;
    for (let n: Element | null = node; n; n = n.parentElement) {
      const cs = view?.getComputedStyle(n);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    }
    return true;
  }

  /** Moves focus to the first control of the dialog (used when it opens and the composer has nothing to focus). */
  focusClose(): void { this.closeBtn.focus(); }

  /**
   * Runs a change that can hide, rebuild or re-form the tray (full / compact / collapsed / hidden) and keeps keyboard focus
   * from falling to <body>. The focused tray control is remembered by LOGICAL identity (its card + its role) from the
   * focusin that put it there; afterwards the same control is focused if it is still shown, else its card's "Review in
   * thread", else the collapsed row's hand-off, else the show-more toggle, else the composer / the close button. Focus the
   * user moved elsewhere (focus or a pointer press outside the tray) is forgotten, so it is never pulled back.
   */
  keepTrayFocus(fn: () => void): void {
    this.focusGuard++;
    try { fn(); } finally {
      this.focusGuard--;
      if (this.focusGuard === 0) this.restoreTrayFocus();
    }
  }

  private identify(target: EventTarget | null): { threadId: string | null; role: string } | null {
    const el = target as HTMLElement | null;
    if (!el || !this.trayHost.contains(el)) return null;
    const card = el.closest<HTMLElement>('.ct-orch-tray-card');
    const role = el.closest('.ct-permission-deny') ? 'deny' : el.closest('.ct-permission-allow') ? 'allow' : el.closest('.ct-permission-always') ? 'always'
      : el.closest('.ct-orch-tray-handoff') ? 'review' : el.closest('.ct-orch-tray-collapsed-review') ? 'collapsed' : el.closest('.ct-orch-tray-toggle') ? 'toggle' : 'other';
    return { threadId: card?.dataset.threadId ?? null, role };
  }

  /**
   * Can this element really take focus now? Not just "no [hidden]": the collapsed tray hides the show-more toggle with CSS
   * display:none, and focus() on such an element silently does nothing. Not hidden / inert / aria-hidden / display:none /
   * visibility:hidden anywhere up the tree (checkVisibility() when the engine has it, computed style otherwise).
   */
  private canFocus(el: HTMLElement | null): el is HTMLElement {
    if (!el || !el.isConnected || el.closest('[hidden], [data-nospace], [inert], [aria-hidden="true"]')) return false;
    if ((el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility) {
      return (el as HTMLElement & { checkVisibility: (o?: object) => boolean }).checkVisibility({ checkVisibilityCSS: true });
    }
    const view = el.ownerDocument.defaultView;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const cs = view?.getComputedStyle(n);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    }
    return true;
  }

  private restoreTrayFocus(): void {
    const want = this.trayFocus;
    if (!want || this.destroyed) return;
    const doc = this.el.ownerDocument;
    const active = doc.activeElement as HTMLElement | null;
    if (active && active !== doc.body && this.canFocus(active)) return; // focus is fine where it is
    const tray = this.trayHost.querySelector<HTMLElement>('.ct-orch-tray');
    const card = want.threadId && tray ? Array.from(tray.querySelectorAll<HTMLElement>('.ct-orch-tray-card')).find((c) => c.dataset.threadId === want.threadId) ?? null : null;
    const ROLE: Record<string, string> = { deny: '.ct-permission-deny', allow: '.ct-permission-allow', always: '.ct-permission-always', review: '.ct-orch-tray-handoff', collapsed: '.ct-orch-tray-collapsed-review', toggle: '.ct-orch-tray-toggle' };
    const sel = ROLE[want.role];
    const candidates: Array<HTMLElement | null | undefined> = [
      sel ? (card ?? tray)?.querySelector<HTMLElement>(sel) : null,
      card?.querySelector<HTMLElement>('.ct-orch-tray-handoff'),
      tray?.querySelector<HTMLElement>('.ct-orch-tray-collapsed-review'),
      tray?.querySelector<HTMLElement>('.ct-orch-tray-toggle'),
      this.el.querySelector<HTMLElement>('.ct-orch-input'),
      this.closeBtn,
    ];
    // Down the chain until a focus() really lands (checked, not assumed); never leave focus on <body>.
    for (const c of candidates) {
      if (!this.canFocus(c ?? null)) continue;
      c!.focus({ preventScroll: true });
      if (doc.activeElement === c) return;
    }
  }

  /** Header + composer (+ the handle when shown) in px: what a MICRO sheet needs, margins included. */
  private chromeHeight(includeTranscriptPadding: boolean): number {
    const view = this.el.ownerDocument.defaultView;
    const own = view?.getComputedStyle(this.el);
    // The sheet's own border sits inside its max-height (border-box): 1px top + 1px bottom are chrome too.
    let fixed = own ? (parseFloat(own.borderTopWidth) || 0) + (parseFloat(own.borderBottomWidth) || 0) : 0;
    for (const child of Array.from(this.el.children) as HTMLElement[]) {
      if (child === this.scrollEl || child === this.trayHost || child.hidden) continue;
      const cs = view?.getComputedStyle(child);
      if (cs?.position === 'absolute' || cs?.display === 'none') continue; // the live regions, a hidden handle
      fixed += child.offsetHeight + (cs ? (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0) : 0);
    }
    if (includeTranscriptPadding) {
      // The transcript cannot shrink below its own padding: that is chrome too.
      const sc = view?.getComputedStyle(this.scrollEl);
      if (sc) fixed += (parseFloat(sc.paddingTop) || 0) + (parseFloat(sc.paddingBottom) || 0);
    }
    return fixed;
  }

  /** The soft keyboard's height over the bottom of the view (narrow bottom sheet lifts by it); null removes the variable. */
  setKeyboardInset(px: number | null): void {
    if (px === null) this.el.style.removeProperty('--ct-orch-kbd-inset');
    else this.el.style.setProperty('--ct-orch-kbd-inset', `${px}px`);
    // The composer's safe-area padding would be dead space under a sheet that is lifted above the keyboard.
    this.el.toggleAttribute('data-kbd', px !== null && px > 0);
  }

  /**
   * Sizes the Needs-you tray (see trayLayout): the composer wins, the tray scrolls inside what is left and falls back to the
   * compact form when even its first card does not fit. Re-run when the tray changes, the sheet's height changes and
   * (ResizeObserver) when the header or the composer grows (a taller textarea, a wrapped error reason).
   */
  fitTray(): void { this.keepTrayFocus(() => this.fitTrayNow()); }

  private fitTrayNow(): void {
    const tray = this.trayHost.querySelector<HTMLElement>('.ct-orch-tray');
    if (!tray) { this.el.style.removeProperty('--ct-orch-tray-max'); return; }
    const max = parseFloat(this.el.style.getPropertyValue('--ct-orch-sheet-max'));
    if (!(max > 0) || this.el.hasAttribute('data-micro')) {
      // Unknown layout (no measured view) or a MICRO sheet (the tray slot is not shown): nothing to size.
      this.el.style.removeProperty('--ct-orch-tray-max');
      tray.hidden = false;
      applyTrayMode(tray, { compact: false, collapsed: false }, null);
      return;
    }
    const need = (): number => {
      const first = tray.querySelector<HTMLElement>('.ct-orch-tray-card');
      return first ? first.offsetTop + first.offsetHeight + TRAY_PAD_PX : 0;
    };
    tray.hidden = false;
    applyTrayMode(tray, { compact: false, collapsed: false }, null);
    const needFull = need();
    applyTrayMode(tray, { compact: true, collapsed: false }, null);
    const needCompact = need();
    const layout = trayLayout({ max, fixed: this.chromeHeight(true), needFull, needCompact });
    applyTrayMode(tray, layout, null);
    // Math.ceil: a half pixel short would clip an edge at DPR 2.
    this.el.style.setProperty('--ct-orch-tray-max', `${Math.ceil(layout.cap)}px`);
    // Collapsed with less than one row of room (the row is the heading plus the tray's own 8px top and bottom padding): hide the
    // tray entirely, the composer keeps what little there is. The dot and the header count still say who needs you.
    tray.hidden = layout.collapsed && layout.cap < COLLAPSED_ROW_PX;
    // The sticky heading covers the top of the scrollport: scrolled-to elements must land below it.
    const bar = tray.querySelector<HTMLElement>('.ct-orch-tray-bar');
    tray.style.scrollPaddingTop = bar && !layout.compact ? `${bar.offsetHeight}px` : '0px';
  }

  /**
   * The sheet's height cap: never taller than the room it has (it can be 0 or negative with a tall keyboard), so it never starts
   * above the top of the view. Floored to whole pixels (a rounded-up cap could end half a pixel past the keyboard). Below
   * MIN_SHEET_PX the sheet renders MICRO (header + composer only) and below what those need it waits, hidden. null: layout unknown.
   */
  setMaxHeight(px: number | null): void {
    if (px === null || !Number.isFinite(px)) {
      this.el.style.removeProperty('--ct-orch-sheet-max');
      this.el.removeAttribute('data-tight'); this.el.removeAttribute('data-micro'); this.el.removeAttribute('data-nospace');
      return;
    }
    const max = Math.max(0, Math.floor(px));
    this.el.style.setProperty('--ct-orch-sheet-max', `${max}px`);
    this.el.toggleAttribute('data-tight', max < TIGHT_SHEET_PX);
    const micro = sheetFit({ max, chromeNeed: 0 }).micro;
    this.el.toggleAttribute('data-micro', micro);
    this.el.toggleAttribute('data-nospace', micro && sheetFit({ max, chromeNeed: this.chromeHeight(false) }).hidden);
  }

  // ── Title menu (the orchestrator switcher) ───────────────────────────────

  /**
   * The title is the plain `h2` text while no Project orchestrator exists (DOM identical to before the menu), and a menu button
   * (`aria-haspopup="listbox"`) once one does. All names are written with textContent: project names are user data.
   */
  private renderTitle(view: SheetView): void {
    const menu = view.menu;
    if (!menu) {
      if (this.titleBtn) this.teardownMenu();
      if (this.titleEl.textContent !== view.title) this.titleEl.textContent = view.title;
      return;
    }
    if (!this.titleBtn) this.buildMenu();
    const label = this.titleBtn!.querySelector('.ct-orch-title-label');
    if (label && label.textContent !== view.title) label.textContent = view.title;
    this.renderMenuRows(menu);
  }

  private buildMenu(): void {
    this.titleEl.textContent = '';
    const btn = this.titleEl.createEl('button', {
      cls: 'ct-orch-title-btn',
      attr: { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': this.menuId, 'data-testid': 'orchestrator-title-menu' },
    });
    btn.createSpan('ct-orch-title-label');
    icon(btn, 'chevron-down');
    btn.addEventListener('click', () => { if (this.menuIsOpen) this.closeMenu(true); else this.openMenu(); });
    this.titleBtn = btn;
    const menu = this.headEl.createDiv({ cls: 'ct-orch-menu', attr: { role: 'listbox', id: this.menuId, 'aria-label': 'Orchestrators', 'data-testid': 'orchestrator-menu' } });
    menu.hidden = true;
    this.menuEl = menu;
    this.menuSig = '';
    this.headEl.addEventListener('keydown', this.onHeadKeydown);
  }

  private teardownMenu(): void {
    this.closeMenu(false);
    this.headEl.removeEventListener('keydown', this.onHeadKeydown);
    this.menuEl?.remove();
    this.menuEl = null;
    this.titleBtn = null;
    this.menuSig = '';
    this.titleEl.textContent = '';
  }

  private optionEls(): HTMLElement[] {
    return this.menuEl ? Array.from(this.menuEl.querySelectorAll<HTMLElement>('[role="option"]')) : [];
  }

  private renderMenuRows(menu: SheetMenu): void {
    const menuEl = this.menuEl;
    if (!menuEl) return;
    const sig = JSON.stringify([menu.selectedId, menu.rows]);
    if (sig === this.menuSig) return;
    this.menuSig = sig;
    const doc = menuEl.ownerDocument;
    const focusedId = menuEl.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.targetId : undefined;
    menuEl.replaceChildren();
    for (const row of menu.rows) {
      const opt = menuEl.createDiv({
        cls: 'ct-orch-menu-opt',
        attr: {
          role: 'option', 'data-target-id': row.id, 'data-kind': row.kind, 'aria-selected': String(row.selected),
          'aria-label': rowAriaLabel(row), tabindex: row.id === (focusedId ?? menu.selectedId) ? '0' : '-1',
        },
      });
      opt.createSpan({ cls: `ct-orch-sdot ct-orch-sdot-${row.status}`, attr: { 'aria-hidden': 'true' } });
      const nm = opt.createSpan('ct-orch-opt-name');
      nm.createSpan({ cls: 'ct-orch-opt-title', text: row.name });
      nm.createSpan({ cls: 'ct-orch-opt-sub', text: row.kind === 'portfolio' ? 'All projects' : 'Project orchestrator' });
      const badges = opt.createSpan({ cls: 'ct-orch-opt-badges', attr: { 'aria-hidden': 'true' } });
      if (row.unread > 0) badges.createSpan({ cls: 'ct-orch-opt-unread', text: String(row.unread) });
      if (row.needsYou > 0) badges.createSpan({ cls: 'ct-orch-opt-needs', text: `${row.needsYou} ${row.needsYou === 1 ? 'needs' : 'need'} you` });
      if (row.hasDraft) badges.createSpan({ cls: 'ct-orch-opt-draft', text: 'Draft' });
      opt.addEventListener('click', () => this.chooseTarget(row.id, menu.selectedId));
    }
    if (focusedId) this.optionEls().find((o) => o.dataset.targetId === focusedId)?.focus();
  }

  private openMenu(): void {
    if (!this.menuEl || !this.titleBtn || this.destroyed) return;
    this.h.menuOpened();
    this.menuIsOpen = true;
    this.menuEl.hidden = false;
    this.fitMenu();
    this.titleBtn.setAttribute('aria-expanded', 'true');
    const opts = this.optionEls();
    const target = opts.find((o) => o.getAttribute('aria-selected') === 'true') ?? opts[0];
    this.focusOption(target, opts);
  }

  private closeMenu(returnFocus: boolean): void {
    if (!this.menuIsOpen) return;
    this.menuIsOpen = false;
    if (this.menuEl) this.menuEl.hidden = true;
    this.titleBtn?.setAttribute('aria-expanded', 'false');
    this.el.style.minHeight = '';
    if (returnFocus) this.titleBtn?.focus();
  }

  /**
   * The menu lives inside the sheet, which clips: cap it to the room the sheet can ever have (its max-height minus what sits above
   * the menu) so it scrolls inside itself, and lift the sheet's min-height while it is open so a short transcript does not clip it.
   */
  private fitMenu(): void {
    const menu = this.menuEl;
    if (!menu) return;
    const view = this.el.ownerDocument.defaultView;
    let max = parseFloat(view?.getComputedStyle(this.el).maxHeight ?? '');
    if (!Number.isFinite(max)) max = (view?.innerHeight ?? 0) * 0.6;
    const top = this.headEl.offsetTop + this.headEl.offsetHeight;
    const room = Math.max(96, max - top - 8);
    menu.style.maxHeight = `${room}px`;
    this.el.style.minHeight = `${Math.min(max, top + Math.min(menu.scrollHeight, room) + 8)}px`;
  }

  /** Roving focus: only the focused option is in the tab order. */
  private focusOption(target: HTMLElement | undefined, opts = this.optionEls()): void {
    if (!target) return;
    for (const o of opts) o.tabIndex = o === target ? 0 : -1;
    target.focus();
    // A long menu scrolls inside itself: keep the focused option in view (instant, never smooth).
    const menu = this.menuEl;
    if (menu) {
      const top = target.offsetTop;
      const bottom = top + target.offsetHeight;
      if (top < menu.scrollTop) menu.scrollTop = top;
      else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
    }
  }

  private chooseTarget(id: string, currentId: string): void {
    this.closeMenu(true);
    if (id !== currentId) this.h.selectTarget(id);
  }

  /**
   * Escape closes the MENU first (and stops there: the sheet's own Escape handler is an ancestor and never sees it), a second
   * Escape closes the sheet. Arrows / Home / End move between options (wrapping), Enter / Space choose, Tab leaves and closes.
   */
  private readonly onHeadKeydown = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return;
    const target = e.target as HTMLElement | null;
    if (e.key === 'Escape' && this.menuIsOpen) { e.preventDefault(); e.stopPropagation(); this.closeMenu(true); return; }
    if (target === this.titleBtn) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!this.menuIsOpen) this.openMenu(); }
      return;
    }
    const opt = target?.closest<HTMLElement>('[role="option"]');
    if (!opt || !this.menuIsOpen) return;
    const opts = this.optionEls();
    const at = opts.indexOf(opt);
    const go = (i: number): void => { e.preventDefault(); this.focusOption(opts[(i + opts.length) % opts.length], opts); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(opts.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const current = opts.find((o) => o.getAttribute('aria-selected') === 'true')?.dataset.targetId ?? '';
      this.chooseTarget(opt.dataset.targetId ?? '', current);
    } else if (e.key === 'Tab') this.closeMenu(true);
  };

  /** The dock switched the sheet to another orchestrator: land on its latest message, drop the hover highlight of the old thread's link. */
  resetForTarget(): void {
    this.stick = true;
    this.pinNext = true;
    this.leaveLink();
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
    if (this.summaryEl.textContent !== view.summary) this.summaryEl.textContent = view.summary;
    this.renderTitle(view);
    if (this.scrollEl.getAttribute('aria-label') !== view.regionLabel) this.scrollEl.setAttribute('aria-label', view.regionLabel);
    // The main panel carries `ct-tools-<style>` on its root; the tool-call CSS is scoped to it, so the log carries it too.
    applyToolCallStyleClass(this.logEl, this.h.messages.toolCallStyle());
    this.reconcileRows(view);
    this.renderStreaming(view.streaming);
    this.renderStopped(view.stopped);
    this.renderEmpty(view);
    this.renderActivity(view);
    this.renderNotice(view);
    this.renderWaiting(view);
    this.checkHoveredLink();
    if (wasPinned) this.scrollToBottom();
    else this.lastHeight = this.scrollEl.scrollHeight; // unpinned: keep the reference height current as content grows
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

  /** Tray announcement: cleared first, then set on the next tick, so the same text twice is still read. */
  announceTray(text: string): void {
    if (this.destroyed) return;
    if (this.trayLiveTimer) clearTimeout(this.trayLiveTimer);
    this.trayLiveEl.textContent = '';
    this.trayLiveTimer = setTimeout(() => {
      this.trayLiveTimer = null;
      if (!this.destroyed) this.trayLiveEl.textContent = text;
    }, 0);
  }

  /**
   * Runs `fn` (which can change the transcript's height: the tray appearing / disappearing) and keeps the transcript on
   * the latest message if it was there before. Someone who scrolled up is left where they are.
   */
  keepPinned(fn: () => void): void {
    const wasPinned = this.stick;
    fn();
    if (wasPinned && this.opened && !this.destroyed) { this.scrollToBottom(); this.queueScroll(); }
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
    this.el.ownerDocument.removeEventListener('focusin', this.onDocFocusIn, true);
    this.el.ownerDocument.removeEventListener('pointerdown', this.onDocPointerDown, true);
    this.el.ownerDocument.removeEventListener('pointerdown', this.onDocPointerDownMenu, true);
    this.chromeObserver?.disconnect();
    this.chromeObserver = null;
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = null;
    this.setModal(false);
    this.leaveLink();
    this.h.messages.dispose();
    this.el.remove();
    this.rows.clear();
  }

  // ── Transcript ────────────────────────────────────────────────────────────

  private reconcileRows(view: SheetView): void {
    const seen = new Set<string>();
    const offset = this.syncOlder(view.older);
    view.entries.forEach((entry, i) => {
      seen.add(entry.id);
      const key = `${entry.role}|${entry.text}|${messageKey(entry)}|${entry.role === 'assistant' ? this.linkSignature(entry.text, view.threads) : ''}`;
      let st = this.rows.get(entry.id);
      if (!st || st.key !== key) {
        st?.row.remove();
        st = this.buildRow(entry, key, view.threads);
        this.rows.set(entry.id, st);
      }
      this.setPickup(st, entry.pickup);
      const at = this.logEl.children[i + offset] ?? null;
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
   * What link rendering depends on besides the text: the titles of threads referenced by title-only `[[thread:...]]`
   * links (a renamed thread re-renders the row). Notes are resolved when clicked (dockLinkOpener), never at render.
   */
  private linkSignature(text: string, threads: ThreadRef[]): string {
    if (!text.includes('[[thread:')) return '';
    const parts: string[] = [];
    for (const m of text.matchAll(/\[\[thread:([^\]|\n]+)(?:\\?\|[^\]\n]*)?\]\]/g)) {
      const ref = m[1].trim();
      parts.push(`${ref}=${threads.find((t) => t.id === ref)?.title ?? threads.filter((t) => t.title === ref).length}`);
    }
    return parts.join(';');
  }

  /** The older-messages row: first child of the log, present only while the cap hides messages. Returns the index offset it causes. */
  private syncOlder(older: number): number {
    if (older <= 0) { this.olderEl?.remove(); this.olderEl = null; return 0; }
    if (!this.olderEl) {
      this.olderEl = this.logEl.ownerDocument.createElement('div');
      this.olderEl.className = 'ct-orch-older';
      this.olderEl.createSpan({ cls: 'ct-orch-older-text', text: `Showing last ${SHEET_MAX_MESSAGES} messages` });
      fullChip(this.olderEl).addEventListener('click', () => this.h.openFull());
    }
    if (this.logEl.firstElementChild !== this.olderEl) this.logEl.prepend(this.olderEl);
    return 1;
  }

  private buildRow(entry: SheetRow, key: string, threads: ThreadRef[]): RowState {
    // The shared item renderer draws the main panel's row. Inline-visual lines were stripped from the text; assistant text
    // gets its `[[thread:...]]` markers resolved against the board's threads first (see dockMessageEnv).
    const env = this.h.messages;
    const source = entry.message as ChatMessage;
    const msg = entry.role === 'user' ? { ...source, content: entry.text }
      : entry.role === 'assistant' ? { ...source, content: rewriteThreadLinks(entry.text, threads) }
      : source;
    const pending: { st: RowState | null } = { st: null };
    const rendered = renderMessage(msg, this.logEl, env.host(), {
      imageSrc: this.h.imageSrc ?? defaultImageSrc,
      formatTime: env.formatTime,
      openExternal: env.openExternal,
      hooks: {
        toolCalls: (el, tools) => { env.toolCalls.renderToolCalls(el, tools); },
      },
    });
    const row = rendered.el!;
    row.dataset.role = entry.role;
    row.dataset.id = entry.id;
    const st: RowState = { row, key, pickupEl: null };
    pending.st = st;
    // Markdown lands in a microtask and grows the row: re-pin if the user is following the bottom NOW (they may have scrolled
    // up since the row was built), unless the row was replaced meanwhile.
    void rendered.done.then(() => {
      if (this.destroyed || this.rows.get(entry.id) !== pending.st) return;
      this.checkHoveredLink();
      if (this.stick) this.scrollToBottom();
    }, () => { /* the row keeps whatever rendered */ });
    if (needsFullThread(entry.rich)) {
      // Never a blank row: a message that is only an inline visual says so, and keeps the way to the full thread.
      const content = row.querySelector<HTMLElement>('.ct-message-content');
      if (entry.text.trim() === '' && content && content.childNodes.length === 0) content.textContent = 'This message has a visualization.';
      fullChip(row).addEventListener('click', () => this.h.openFull());
    }
    return st;
  }

  private setPickup(st: RowState, on: boolean): void {
    if (on && !st.pickupEl) st.pickupEl = st.row.createDiv({ cls: 'ct-orch-pickup', text: 'Sent, will be picked up' });
    else if (!on && st.pickupEl) { st.pickupEl.remove(); st.pickupEl = null; }
  }

  private renderStreaming(text: string): void {
    if (!text) { this.streamRenderSeq++; this.streamingRow?.remove(); this.streamingRow = null; return; }
    if (!this.streamingRow) {
      // The main panel's streaming row (`.ct-message-assistant.ct-streaming > .ct-message-content`, cursor at the end).
      // aria-live off: the throttled region below is what screen readers hear while tokens arrive.
      this.streamingRow = createRow(this.logEl, 'assistant', 'streaming');
      this.streamingRow.addClass('ct-streaming');
      this.streamingRow.dataset.streaming = 'true';
      this.streamingRow.setAttribute('aria-live', 'off');
      this.streamingRow.createDiv('ct-message-content');
    }
    this.logEl.append(this.streamingRow);
    const content = this.streamingRow.firstElementChild as HTMLElement;
    // The current buffer is written as plain text at once (the row is never stale or empty, and nothing here awaits), then
    // swapped for markdown in the same task's microtasks, before the next paint: the main panel's streaming render with the
    // trusted pipeline (the sanitizer still runs; raw HTML that survives it is what the main panel shows).
    content.textContent = text;
    content.createSpan({ cls: 'ct-cursor' });
    const seq = ++this.streamRenderSeq;
    const target = content.ownerDocument.createElement('div');
    void renderMarkdown(rewriteThreadLinks(text, this.view?.threads ?? []), target, this.h.messages.host(), { streaming: true }).then(() => {
      if (this.destroyed || seq !== this.streamRenderSeq || this.streamingRow?.firstElementChild !== content || target.childNodes.length === 0) return;
      const pinned = this.stick;
      content.replaceChildren(...Array.from(target.childNodes));
      content.createSpan({ cls: 'ct-cursor' });
      this.checkHoveredLink();
      if (pinned) this.scrollToBottom();
    }).catch(() => { /* keep the plain text */ });
  }

  private renderStopped(text: string): void {
    if (!text) { this.stoppedRow?.remove(); this.stoppedRow = null; return; }
    if (!this.stoppedRow) {
      this.stoppedRow = createRow(this.logEl, 'assistant', 'stopped');
      this.stoppedRow.addClass('ct-orch-stopped');
      this.stoppedRow.dataset.stopped = 'true';
      this.stoppedRow.createDiv('ct-message-content');
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
    // Links the shared renderer wired (notes, thread links, http(s)) stop propagation themselves and never get here; this
    // catches the rest (mailto:, a bare anchor, an http link when the host gave no opener): never navigate the board's window.
    const plain = a.getAttribute('href') ?? '';
    if (!this.h.messages.openExternal && /^https?:\/\//i.test(plain)) window.open(plain, '_blank', 'noopener,noreferrer');
  }

  private linkAnchor(target: EventTarget | null): HTMLElement | null {
    return (target as HTMLElement | null)?.closest?.('a.internal-link[data-href^="thread:"]') as HTMLElement | null;
  }

  private onLinkOver(e: Event): void {
    const a = this.linkAnchor(e.target);
    if (!a || a === this.hoverEl || !this.logEl.contains(a)) return;
    const id = threadIdOfHref(a.getAttribute('data-href'));
    if (!id) return;
    this.hoverEl = a;
    this.h.linkEnter(id);
  }

  private onLinkOut(e: Event): void {
    const a = this.linkAnchor(e.target);
    if (!a || a !== this.hoverEl) return;
    const to = (e as MouseEvent | FocusEvent).relatedTarget as Node | null;
    if (to && a.contains(to)) return; // moving inside the same link
    if (to && this.linkAnchor(to)) return; // straight onto another link: its own enter switches the highlight
    this.leaveLink();
  }

  private leaveLink(): void {
    if (!this.hoverEl) return;
    this.hoverEl = null;
    this.h.linkLeave();
  }

  /** The hovered anchor can be re-rendered away under a still pointer: no mouseout fires for a removed node. */
  private checkHoveredLink(): void {
    if (this.hoverEl && !this.hoverEl.isConnected) this.leaveLink();
  }

  private nearBottom(): boolean {
    const s = this.scrollEl;
    return s.scrollHeight - s.scrollTop - s.clientHeight <= NEAR_BOTTOM_PX;
  }

  private scrollToBottom(): void {
    const before = this.scrollEl.scrollTop;
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    this.lastWrittenTop = this.scrollEl.scrollTop; // read back: the browser clamps to the real maximum
    if (this.lastWrittenTop !== before) this.echoPending = true; // a scroll event will follow; assigning the same value fires none
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
  return log.createDiv({ cls: `ct-message ct-message-${role}`, attr: { 'data-role': role, 'data-id': id } });
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

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return false;
  return !!el.closest('textarea, input, select, [contenteditable]:not([contenteditable="false"])');
}
