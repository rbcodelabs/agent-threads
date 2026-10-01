/**
 * View-side glue for browser session cards, kept out of ThreadsView so that file
 * only has to say "render a browser entry here" and "rebuild rows on refresh".
 *
 * Responsibilities:
 *  - resolve, per render pass, everything a card needs that is not in its own
 *    tool calls: is this the live session, which screenshot is its, which handoff
 *    (if any) is layered on it (see browserSession.ts);
 *  - draw a card (BrowserSessionCard.ts) and remember the expand/collapse state
 *    the user chose, keyed by the session's stable key so it survives re-renders
 *    and the live -> finalized transition;
 *  - subscribe to the shared LoginHandoffController for the ACTIVE thread only,
 *    push frames into the control card without rebuilding it, tick the 30s
 *    countdown in place, drive the composer chip / placeholder / aria-live
 *    announcement, and forward pointer + keyboard back to the controller;
 *  - while a session is live (and no handoff is layered on it), attach a LIVE
 *    viewer so the active card mirrors the agent's page with the same frames and
 *    cadence as the Agent Browser pane. Frames are only captured while the card
 *    can be seen; when the session ends the card settles to its final screenshot.
 *
 * PRIVACY. The sign-in page is shown here and only here: the frame goes from the
 * controller straight onto an <img>. Live frames of the agent's own page follow
 * the same path: memory and DOM only. Nothing in this file writes a frame,
 * keystroke or typed text to a ChatMessage, to toolResultImages, to settings, to a
 * log or to an MCP result, and test/unit/browser-session-presenter.test.ts pins it.
 */

import type { App } from 'obsidian';
import {
  assignBrowserScreenshots,
  buildBrowserSessionViewModel,
  buildStandaloneHandoffViewModel,
  findLastBrowserSessionKey,
  findLiveBrowserSessionKey,
  HANDOFF_TTL_SECONDS,
  type BrowserHandoffInput,
  type BrowserRowInput,
  type BrowserScreenshotAssignment,
  type BrowserSessionViewModel,
} from './browserSession';
import {
  BrowserScreenshotModal,
  renderBrowserSessionCard,
  type BrowserCardHandle,
} from './BrowserSessionCard';
import { browserSessionKey, groupToolCalls, isBrowserTool, mergeAdjacentToolOnlyMessages, type ToolCallGroup } from './toolNameUtils';
import type { ChatMessage, ToolCallRecord } from './types';
import type { LoginHandoffController, LoginHandoffSnapshot } from './agentBrowser/LoginHandoffController';

export const PLACEHOLDER_WHILE_SIGNING_IN = 'Claude is waiting while you sign in…';

/** What the presenter needs from the view that hosts it. */
export interface BrowserPresenterHost {
  app: App;
  activeThreadId(): string | null;
  /** thread.messages, un-merged. */
  messages(threadId: string): readonly ChatMessage[] | null;
  /** Tool calls of the in-flight (not yet persisted) assistant message. */
  streamingTools(threadId: string): readonly ToolCallRecord[];
  /** Tool-result images not yet attached to a persisted message. */
  pendingImages(threadId: string): ReadonlyArray<{ mediaType: string; data?: string; path?: string }>;
  turnRunning(): boolean;
  imageSrc(ref: { path?: string; mediaType: string }, inlineData: string | undefined): string;
  controller(): LoginHandoffController | null;
  /** Ask the view to rebuild the rows/cards that carry a browser session. */
  refreshRows(): void;
  /** Composer-side effects of human control. */
  setControlChip(visible: boolean): void;
  setComposerHuman(human: boolean): void;
  announce(text: string): void;
  /** Whether the sign-in frame can currently be seen. */
  isVisible(): boolean;
}

interface RenderContext {
  messages: ChatMessage[];
  /** rows.length === messages.length (+1 when a streaming pseudo-row exists). */
  rows: BrowserRowInput[];
  rowIndexById: Map<string, number>;
  pending: ReadonlyArray<{ mediaType: string; data?: string; path?: string }>;
  hasPseudoRow: boolean;
  assignment: BrowserScreenshotAssignment;
  liveKey: string | null;
  lastKey: string | null;
  handoff: BrowserHandoffInput | null;
}

const LIVE_ROW_ID = '__live__';

export class BrowserSessionPresenter {
  private ctx: RenderContext | null = null;
  private readonly cards = new Map<string, BrowserCardHandle>();
  /** Sessions a user expanded although they default to collapsed. */
  private readonly expanded = new Set<string>();
  private readonly stepsOpen = new Set<string>();
  private standaloneEl: HTMLElement | null = null;

  private unsubscribers: Array<() => void> = [];
  private detachViewer: (() => void) | null = null;
  /** Live-view subscription for the active session's card (passive, agent's own page). */
  private detachLiveViewer: (() => void) | null = null;
  private liveViewerThread: string | null = null;
  /** Keys of cards that mirror a live frame (control or live session); others never get one. */
  private readonly frameCards = new Set<string>();
  private tickTimer: number | null = null;
  private lastPhase: string | null = null;
  private lastPhaseThread: string | null = null;

  constructor(private readonly host: BrowserPresenterHost) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Subscribe to the shared controller. Safe (a no-op) when there is none. */
  attach(): void {
    this.detach();
    const controller = this.host.controller();
    if (!controller) return;
    this.unsubscribers.push(
      controller.subscribe((threadId) => { if (threadId === this.host.activeThreadId()) this.onHandoffChanged(); }),
      controller.subscribeFrames((threadId, dataUrl) => {
        if (threadId !== this.host.activeThreadId()) return;
        // Only cards that show a live picture take frames; a finished session
        // keeps its final screenshot.
        for (const [key, handle] of this.cards) if (this.frameCards.has(key) && handle.el.isConnected) handle.setFrame(dataUrl);
      }),
    );
    this.syncChrome();
  }

  detach(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    this.detachViewer?.();
    this.detachViewer = null;
    this.detachLiveViewer?.();
    this.detachLiveViewer = null;
    this.liveViewerThread = null;
    this.stopTick();
    this.cards.clear();
    this.frameCards.clear();
    this.ctx = null;
    this.standaloneEl = null;
  }

  /** Drop per-thread UI state (thread switch, full rebuild). Expansion sets persist per view. */
  resetForRebuild(): void {
    this.ctx = null;
    this.cards.clear();
    this.frameCards.clear();
    this.standaloneEl = null;
  }

  /** Cleared alongside the view's other expand sets when the thread changes. */
  clearExpansion(): void {
    this.expanded.clear();
    this.stepsOpen.clear();
  }

  invalidate(): void {
    this.ctx = null;
  }

  // ── Context (recomputed lazily, once per render pass) ─────────────────────

  private context(): RenderContext | null {
    if (this.ctx) return this.ctx;
    const threadId = this.host.activeThreadId();
    if (!threadId) return null;
    const persisted = this.host.messages(threadId);
    if (!persisted) return null;

    const messages = mergeAdjacentToolOnlyMessages([...persisted]);
    const rows: BrowserRowInput[] = messages.map((m) => ({
      id: m.id,
      role: m.role,
      hasText: m.role === 'user' || (m.content ?? '').trim().length > 0,
      tools: m.toolCalls ?? [],
      imageCount: m.toolResultImages?.length ?? 0,
    }));
    const live = this.host.streamingTools(threadId);
    const pending = this.host.pendingImages(threadId);
    const hasPseudoRow = live.length > 0 || pending.length > 0;
    if (hasPseudoRow) {
      rows.push({ id: LIVE_ROW_ID, role: 'assistant', hasText: false, tools: [...live], imageCount: pending.length });
    }

    const lastKey = findLastBrowserSessionKey(rows);
    const ctx: RenderContext = {
      messages,
      rows,
      rowIndexById: new Map(rows.map((r, i) => [r.id, i])),
      pending,
      hasPseudoRow,
      assignment: assignBrowserScreenshots(rows),
      liveKey: findLiveBrowserSessionKey(rows, this.host.turnRunning()),
      lastKey,
      handoff: this.handoffInput(threadId, rows),
    };
    this.ctx = ctx;
    return ctx;
  }

  private handoffInput(threadId: string, rows: readonly BrowserRowInput[]): BrowserHandoffInput | null {
    const controller = this.host.controller();
    if (!controller) return null;
    const snapshot = controller.getSnapshot(threadId);
    const history = controller.getHistory(threadId);
    if (!snapshot && history.length === 0) return null;

    let phase: BrowserHandoffInput['phase'] = null;
    if (snapshot) {
      phase = snapshot.phase === 'active' ? 'control' : snapshot.phase;
      // An expired request stops being news once the agent has moved on.
      if (snapshot.phase === 'expired') {
        const lastTool = lastToolTimestamp(rows);
        if (lastTool > (snapshot.expiredAt ?? 0)) phase = null;
      }
    }
    const remainingSeconds = phase === 'requested' && snapshot?.expiresAt !== undefined
      ? Math.max(0, Math.ceil((snapshot.expiresAt - Date.now()) / 1000))
      : undefined;
    return {
      phase,
      host: snapshot?.host ?? '',
      url: snapshot?.url ?? '',
      remainingSeconds,
      history,
    };
  }

  /** Screenshot src for a session, or null (=> skeleton). */
  private screenshotSrc(ctx: RenderContext, key: string): string | null {
    const at = ctx.assignment.bySession.get(key);
    if (!at) return null;
    const pseudo = ctx.hasPseudoRow && at.rowIndex === ctx.rows.length - 1;
    const img = pseudo ? ctx.pending[at.imageIndex] : ctx.messages[at.rowIndex]?.toolResultImages?.[at.imageIndex];
    if (!img || (!img.path && !img.data)) return null;
    return this.host.imageSrc(img, img.data);
  }

  /** Image indexes of a row that are drawn inside a card and must not also render loose. */
  claimedImageIndexes(rowId: string): ReadonlySet<number> {
    const ctx = this.context();
    if (!ctx) return new Set();
    const idx = ctx.rowIndexById.get(rowId);
    return (idx !== undefined ? ctx.assignment.claimed.get(idx) : undefined) ?? new Set();
  }

  /** Same, for images that arrived but are not yet on a persisted message. */
  claimedPendingIndexes(): ReadonlySet<number> {
    const ctx = this.context();
    if (!ctx || !ctx.hasPseudoRow) return new Set();
    return ctx.assignment.claimed.get(ctx.rows.length - 1) ?? new Set();
  }

  /**
   * True when a card in `tools` is waiting on the human (sign-in requested, in
   * control, just returned). Such a card must never sit behind a collapsed
   * outer wrap: the user has an action to take.
   */
  needsAttention(tools: readonly ToolCallRecord[]): boolean {
    const ctx = this.context();
    const phase = ctx?.handoff?.phase;
    if (!ctx || !ctx.lastKey || !phase || phase === 'expired') return false;
    return groupToolCalls([...tools]).some((e) => e.kind === 'browser' && browserSessionKey(e.tools) === ctx.lastKey);
  }

  /** Does this row carry a browser session (so refreshes know to rebuild it)? */
  rowHasBrowserSession(rowId: string): boolean {
    const ctx = this.context();
    const idx = ctx?.rowIndexById.get(rowId);
    return !!ctx && idx !== undefined && ctx.rows[idx].tools.some((t) => isBrowserTool(t.name));
  }

  // ── Card ──────────────────────────────────────────────────────────────────

  private viewModelFor(entry: Extract<ToolCallGroup, { kind: 'browser' }>): { vm: BrowserSessionViewModel; screenshot: string | null } {
    const ctx = this.context();
    const key = browserSessionKey(entry.tools);
    const screenshot = ctx ? this.screenshotSrc(ctx, key) : null;
    const isLast = !!ctx && ctx.lastKey === key;
    const vm = buildBrowserSessionViewModel(entry.tools, {
      live: !!ctx && ctx.liveKey === key,
      hasScreenshot: !!screenshot,
      handoff: isLast ? ctx!.handoff : null,
    });
    return { vm, screenshot };
  }

  /** Draw one session card into `container`. Live and finalized rendering share this. */
  renderEntry(container: HTMLElement, entry: Extract<ToolCallGroup, { kind: 'browser' }>): void {
    const { vm, screenshot } = this.viewModelFor(entry);
    this.drawCard(container, vm, screenshot);
  }

  private drawCard(container: HTMLElement, vm: BrowserSessionViewModel, screenshot: string | null): BrowserCardHandle {
    const threadId = this.host.activeThreadId();
    const controller = this.host.controller();
    const hostEl = container.createDiv('ct-bc-host');
    // A running session with no handoff layered on it mirrors the agent's page.
    const live = !!controller && !!threadId && !vm.mode && (vm.state === 'live' || vm.state === 'navigating');
    const showsFrames = live || vm.mode === 'control';
    const handle = renderBrowserSessionCard(
      hostEl,
      {
        vm,
        screenshotSrc: screenshot,
        frameSrc: showsFrames && threadId ? controller?.getFrame(threadId) ?? null : null,
        live,
        expanded: this.expanded.has(vm.key),
        stepsOpen: this.stepsOpen.has(vm.key),
      },
      {
        onExpandedChange: (key, expanded) => { if (expanded) this.expanded.add(key); else this.expanded.delete(key); },
        onStepsOpenChange: (key, open) => { if (open) this.stepsOpen.add(key); else this.stepsOpen.delete(key); },
        openScreenshot: (src, model) => new BrowserScreenshotModal(this.host.app, src, model).open(),
        takeControl: () => { if (threadId) void controller?.takeControl(threadId); },
        notNow: () => { if (threadId) controller?.dismissRequest(threadId); },
        returnControl: () => { if (threadId) controller?.returnControl(threadId, 'login-complete'); },
        pointer: (type, event, rect) => {
          if (threadId) controller?.forwardPointer(threadId, type, event.clientX, event.clientY, rect);
        },
        key: (event) => {
          if (!threadId) return;
          const forwarded = controller?.forwardKey(threadId, {
            key: event.key,
            type: event.type as 'keydown' | 'keyup',
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
          });
          if (forwarded) event.preventDefault();
        },
      },
    );
    this.cards.set(vm.key, handle);
    if (showsFrames) this.frameCards.add(vm.key); else this.frameCards.delete(vm.key);
    return handle;
  }

  // ── Standalone handoff card (no browser session to hang it on) ────────────

  /** Create/refresh/remove the standalone card at the end of `messagesEl`. */
  syncStandalone(messagesEl: HTMLElement | null): void {
    const ctx = this.context();
    const need = !!ctx && !!messagesEl && ctx.lastKey === null && !!ctx.handoff?.phase;
    if (!need) {
      this.standaloneEl?.remove();
      this.standaloneEl = null;
      return;
    }
    this.standaloneEl?.remove();
    const wrapper = messagesEl!.createDiv('ct-message ct-message-assistant ct-bc-standalone');
    this.standaloneEl = wrapper;
    this.drawCard(wrapper, buildStandaloneHandoffViewModel(ctx!.handoff!), null);
  }

  // ── Handoff reactions (active thread only) ────────────────────────────────

  private currentSnapshot(): LoginHandoffSnapshot | null {
    const threadId = this.host.activeThreadId();
    return threadId ? this.host.controller()?.getSnapshot(threadId) ?? null : null;
  }

  private onHandoffChanged(): void {
    this.invalidate();
    const before = this.captureFocus();
    this.host.refreshRows();
    this.syncChrome();
    this.restoreFocus(before);
  }

  /** Called by the view after any rebuild so chrome, ticker and viewer track the phase. */
  syncChrome(): void {
    const snapshot = this.currentSnapshot();
    const phase = snapshot?.phase ?? null;
    const inControl = phase === 'active';
    this.host.setControlChip(inControl);
    this.host.setComposerHuman(inControl);

    // Only a change of mode is announced (never a countdown tick), and never
    // just because the user switched to a thread that already had one.
    const threadId = this.host.activeThreadId();
    if (threadId !== this.lastPhaseThread) {
      this.lastPhaseThread = threadId;
      this.lastPhase = phase;
    } else if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      if (snapshot) this.host.announce(announcementFor(snapshot));
    }

    if (phase === 'requested') this.startTick(); else this.stopTick();

    const controller = this.host.controller();
    if (inControl && threadId && controller && !this.detachViewer) {
      this.detachViewer = controller.attachViewer(() => this.frameVisible(), threadId);
    } else if (!inControl && this.detachViewer) {
      this.detachViewer();
      this.detachViewer = null;
    }

    // Live view of the agent's own page: wanted while a live (non-handoff)
    // card is on screen for this thread; released the moment none is, which is
    // also how a finished session settles to its final screenshot.
    const wantLive = !inControl && !!threadId && !!controller && this.hasLiveCard();
    if (this.detachLiveViewer && (!wantLive || this.liveViewerThread !== threadId)) {
      this.detachLiveViewer();
      this.detachLiveViewer = null;
      this.liveViewerThread = null;
    }
    if (wantLive && threadId && controller && !this.detachLiveViewer) {
      this.detachLiveViewer = controller.attachLiveViewer(() => this.liveFrameVisible(), threadId);
      this.liveViewerThread = threadId;
    }
  }

  private frameVisible(): boolean {
    if (!this.host.isVisible()) return false;
    for (const handle of this.cards.values()) if (handle.el.isConnected) return true;
    return false;
  }

  /** A card that mirrors the agent's page (not a handoff) is part of the current render. */
  private hasLiveCard(): boolean {
    const ctx = this.context();
    if (!ctx || ctx.liveKey === null || ctx.handoff?.phase) return false;
    return this.frameCards.has(ctx.liveKey);
  }

  /**
   * Capturing costs the guest's per-session budget, so only while a person can
   * actually see the card: pane visible, card attached, not collapsed, and not
   * hidden by a collapsed ancestor.
   */
  private liveFrameVisible(): boolean {
    if (!this.host.isVisible()) return false;
    const key = this.context()?.liveKey;
    const handle = key ? this.cards.get(key) : undefined;
    if (!handle || !handle.el.isConnected || handle.el.classList.contains('is-collapsed')) return false;
    const el = handle.el as HTMLElement & { checkVisibility?: () => boolean };
    return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;
  }

  private startTick(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = window.setInterval(() => this.tick(), 1000);
  }

  private stopTick(): void {
    if (this.tickTimer === null) return;
    window.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** Update the countdown ring in place; no rebuild, no announcement. */
  private tick(): void {
    const snapshot = this.currentSnapshot();
    if (snapshot?.phase !== 'requested' || snapshot.expiresAt === undefined) return;
    const remaining = Math.max(0, Math.min(HANDOFF_TTL_SECONDS, Math.ceil((snapshot.expiresAt - Date.now()) / 1000)));
    for (const handle of this.cards.values()) if (handle.el.isConnected) handle.setCountdown(remaining);
  }

  // ── Focus ─────────────────────────────────────────────────────────────────

  private captureFocus(): { frame: boolean; inside: boolean } {
    let frame = false;
    let inside = false;
    const active = document.activeElement;
    for (const handle of this.cards.values()) {
      if (handle.frameHasFocus()) frame = true;
      if (active && handle.el.contains(active)) inside = true;
    }
    return { frame, inside };
  }

  /**
   * A rebuild replaces the card, which would drop focus. If the user was typing
   * into the sign-in frame keep them there; if they had just activated a button
   * on the card (Take control), move to the new mode's primary action.
   */
  private restoreFocus(before: { frame: boolean; inside: boolean }): void {
    if (!before.inside && !before.frame) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && this.cardsContain(active)) return;
      for (const handle of this.cards.values()) {
        if (!handle.el.isConnected) continue;
        if (before.frame) { handle.focusFrame(); return; }
        handle.focusPrimaryAction();
      }
    });
  }

  private cardsContain(el: Element): boolean {
    for (const handle of this.cards.values()) if (handle.el.contains(el)) return true;
    return false;
  }

  /** For callers that rebuild rows themselves and want focus kept. */
  withFocusPreserved(fn: () => void): void {
    const before = this.captureFocus();
    fn();
    this.restoreFocus(before);
  }
}

function lastToolTimestamp(rows: readonly BrowserRowInput[]): number {
  let latest = 0;
  for (const row of rows) for (const t of row.tools) if ((t.timestamp ?? 0) > latest) latest = t.timestamp ?? 0;
  return latest;
}

function announcementFor(snapshot: LoginHandoffSnapshot): string {
  const phase = snapshot.phase === 'active' ? 'control' : snapshot.phase;
  return buildStandaloneHandoffViewModel({ phase, host: snapshot.host, url: snapshot.url, history: [] }).announce;
}
