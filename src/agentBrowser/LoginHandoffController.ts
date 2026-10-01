/**
 * Plugin-owned state machine for the login "Take control" handoff (ADR-0014).
 *
 * This used to live privately inside AgentBrowserPreviewView, which meant the
 * handoff only ever existed in the Agent Browser pane and only while that pane
 * was open. It now belongs to the plugin so any surface can show it: the
 * preview pane and the chat's browser session card subscribe to the same
 * per-thread state, and take/return/input go through the same code.
 *
 *   idle -> requested(expiresAt) -> active -> returned (~4s, then idle)
 *                       \-> expired (until replaced)
 *
 * PRIVACY INVARIANT. A login page is the one thing the agent must never see. The
 * only place a frame of it exists is `latestFrame` below, in this object's
 * memory and, via `subscribeFrames`, the DOM of a view that is displaying it.
 * Frames, keystrokes and typed text are never written to a transcript, to
 * ChatMessage.toolResultImages, to persisted settings, to RawLogWriter or to any
 * MCP tool result — this class has no reference to any of those, and
 * test/unit/login-handoff-controller.test.ts pins that. Keep it that way: do not
 * add a logger call that includes an event, a frame or a URL query.
 *
 * Every dependency is injected, so with no pool or bridge (plain Obsidian,
 * mobile, feature off) the controller is inert: no throws, no state, `available`
 * is false and no card ever offers to take control.
 */

import type { AgentBrowserPool } from './AgentBrowserPool';
import type { AgentBrowserGuest, GuestEndReason } from './AgentBrowserGuest';
import { pngDataUrl } from './agentBrowserImage';
import {
  AgentBrowserLoginBridge,
  createGeodeLoginBridgeDeps,
  type GeodeLoginBridgeLike,
  type IpcRendererLike,
  type PendingLoginRequest,
} from './AgentBrowserLoginBridge';
import {
  buildMouseInputEvent,
  mapClientPointToViewport,
  mapKeyboardEvent,
  type ClientRect,
  type DomKeyboardEventLike,
} from './agentBrowserInput';

/** Frame width; the preview is for orientation, not detail. */
export const HANDOFF_PREVIEW_WIDTH = 1024;

/**
 * Frame cadence while a handoff is active (ADR-0014 §4): a deliberate trade of
 * guest capture budget for responsiveness during a short, human-driven window.
 */
export const HANDOFF_CAPTURE_MS = 250;

/**
 * Passive ("live view") cadence: how often a surface that is merely WATCHING the
 * agent's own page gets a frame. Same numbers the Agent Browser pane has always
 * used, because they share one per-guest capture budget: a frame every second
 * while the agent is driving the page, one every five while it sits idle.
 */
export const LIVE_BUSY_CAPTURE_MS = 1_000;
export const LIVE_IDLE_CAPTURE_MS = 5_000;
/** How often the passive loop wakes to decide whether a capture is due. */
export const LIVE_TICK_MS = 1_000;

/** How long the "Signed in · Claude resumed" confirmation stays before folding back. */
export const HANDOFF_RETURNED_MS = 4_000;

/** Cap on remembered finished handoffs per thread (steps shown on the card). */
const MAX_HISTORY = 5;

export type LoginHandoffPhase = 'requested' | 'active' | 'expired' | 'returned';

export interface LoginHandoffHistoryEntry {
  at: number;
  outcome: 'returned' | 'expired';
  host: string;
  durationMs?: number;
}

/** What a view needs to draw the handoff for one thread. Contains no page content. */
export interface LoginHandoffSnapshot {
  threadId: string;
  phase: LoginHandoffPhase;
  /** The page the sign-in was requested for / is happening on. */
  url: string;
  host: string;
  /** requested: epoch ms the request stops being actionable. */
  expiresAt?: number;
  /** active: epoch ms control was taken. */
  startedAt?: number;
  /** active: 'popup' = a separate sign-in page; 'takeover' = the agent's own page, driven by a person. */
  mode?: 'popup' | 'takeover';
  /** expired: epoch ms it expired. */
  expiredAt?: number;
  history: readonly LoginHandoffHistoryEntry[];
}

export interface TakeControlResult {
  ok: boolean;
  /** Set when ok is false and a person should be told. */
  message?: string;
}

export interface LoginHandoffControllerOptions {
  getPool: () => AgentBrowserPool | null;
  /** Override for tests; defaults to the live `window.geode` / `ipcRenderer`. */
  bridgeDeps?: { geode: GeodeLoginBridgeLike | null; ipcRenderer: IpcRendererLike | null };
  now?: () => number;
  /** Surface a message to a person (a Notice on the real host). */
  notify?: (message: string) => void;
  /** Injected so tests need no real timers beyond fake ones. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface ThreadState {
  pending: PendingLoginRequest | null;
  pendingExpired: boolean;
  expiredAt?: number;
  active: { guest: AgentBrowserGuest; url: string; startedAt: number; takeover?: boolean } | null;
  returned: { at: number; host: string; url: string } | null;
  returnedTimer: unknown;
  history: LoginHandoffHistoryEntry[];
}

interface Viewer {
  threadId: string | null;
  isVisible: () => boolean;
}

function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

export class LoginHandoffController {
  private readonly getPool: () => AgentBrowserPool | null;
  private readonly now: () => number;
  private readonly notify: (message: string) => void;
  private readonly bridgeDeps: { geode: GeodeLoginBridgeLike | null; ipcRenderer: IpcRendererLike | null } | null;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  private bridge: AgentBrowserLoginBridge | null = null;
  private started = false;
  private readonly threads = new Map<string, ThreadState>();
  private readonly listeners = new Set<(threadId: string) => void>();
  private readonly frameListeners = new Set<(threadId: string, dataUrl: string | null) => void>();
  private readonly focusListeners = new Set<(threadId: string) => void>();
  private readonly viewers = new Set<Viewer>();
  /** Latest frame per thread. Memory only. */
  private readonly latestFrame = new Map<string, string>();
  private captureTimer: unknown = null;
  private capturing = false;

  /** Surfaces watching the agent's own page (not a handoff). */
  private readonly liveViewers = new Set<Viewer>();
  private liveTimer: unknown = null;
  private liveCapturing = false;
  /** Epoch ms of the last passive frame per thread, whoever captured it. */
  private readonly lastLiveAt = new Map<string, number>();

  constructor(options: LoginHandoffControllerOptions) {
    this.getPool = options.getPool;
    this.now = options.now ?? Date.now;
    this.notify = options.notify ?? (() => {});
    this.bridgeDeps = options.bridgeDeps ?? null;
    this.setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** True when the host exposes the popup bridge and a pool exists: cards may offer to take control. */
  get available(): boolean {
    return !!this.getPool() && (this.bridge?.available ?? false);
  }

  /** Subscribe to Geode's events. Safe to call repeatedly; a no-op when the host has no bridge. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { geode, ipcRenderer } = this.bridgeDeps ?? createGeodeLoginBridgeDeps();
    const bridge = new AgentBrowserLoginBridge({
      geode,
      ipcRenderer,
      now: this.now,
      findPrimaryThreadByWebContentsId: (id) => this.getPool()?.findPrimaryByWebContentsId(id) ?? null,
      findLoginThreadByWebContentsId: (id) => this.getPool()?.findLoginByWebContentsId(id) ?? null,
      onPendingRequest: (request) => this.handlePending(request),
      onRequestExpired: (request) => this.handleExpired(request),
      // The login guest's own window.close() was relayed: same as "Return control".
      onLoginClosed: (threadId) => { if (this.threads.get(threadId)?.active) this.returnControl(threadId, 'login-complete'); },
      onLoginFocused: (threadId) => { if (this.threads.get(threadId)?.active) for (const l of this.focusListeners) l(threadId); },
    });
    bridge.start();
    this.bridge = bridge;
  }

  /** Unsubscribe and drop everything, including any frame in memory. */
  stop(): void {
    this.started = false;
    this.stopCaptureLoop();
    this.stopLiveLoop();
    this.bridge?.stop();
    this.bridge = null;
    for (const state of this.threads.values()) if (state.returnedTimer) this.clearTimeoutFn(state.returnedTimer);
    this.threads.clear();
    this.latestFrame.clear();
    this.lastLiveAt.clear();
    this.viewers.clear();
    this.liveViewers.clear();
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  /** Notified with the affected thread id whenever its snapshot may have changed. */
  subscribe(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Notified with each new frame (or null when a thread's frame is cleared). Frames are never part of a snapshot. */
  subscribeFrames(listener: (threadId: string, dataUrl: string | null) => void): () => void {
    this.frameListeners.add(listener);
    return () => { this.frameListeners.delete(listener); };
  }

  /** Notified when the login popup regains OS focus, so a pane can reveal itself. */
  subscribeFocus(listener: (threadId: string) => void): () => void {
    this.focusListeners.add(listener);
    return () => { this.focusListeners.delete(listener); };
  }

  /**
   * Declare that a surface displays login frames. The capture loop only spends
   * guest capture budget while at least one attached viewer reports visible.
   * `threadId` null means "whichever thread is active".
   */
  attachViewer(isVisible: () => boolean, threadId: string | null = null): () => void {
    const viewer: Viewer = { threadId, isVisible };
    this.viewers.add(viewer);
    return () => { this.viewers.delete(viewer); };
  }

  /**
   * Declare that a surface shows LIVE frames of the agent's own page for
   * `threadId` (the chat card of the active session). Frames are captured only
   * while at least one live viewer for the thread reports visible, at the
   * pane's cadence, and flow through `subscribeFrames` like handoff frames.
   * The returned function detaches; the loop stops with the last viewer.
   */
  attachLiveViewer(isVisible: () => boolean, threadId: string): () => void {
    const viewer: Viewer = { threadId, isVisible };
    this.liveViewers.add(viewer);
    this.ensureLiveLoop();
    return () => {
      this.liveViewers.delete(viewer);
      if (this.liveViewers.size === 0) this.stopLiveLoop();
    };
  }

  /**
   * Hand the controller a frame some other surface already paid to capture (the
   * Agent Browser pane), so the card shows the same picture without a second
   * `capturePage()` against the same per-guest budget.
   */
  publishLiveFrame(threadId: string, dataUrl: string): void {
    if (this.threads.get(threadId)?.active) return;
    this.lastLiveAt.set(threadId, this.now());
    this.latestFrame.set(threadId, dataUrl);
    for (const l of this.frameListeners) l(threadId, dataUrl);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  getSnapshot(threadId: string): LoginHandoffSnapshot | null {
    const state = this.threads.get(threadId);
    return state ? this.toSnapshot(threadId, state) : null;
  }

  /** The thread with an active (human-driven) handoff, if any. */
  getActiveSnapshot(): LoginHandoffSnapshot | null {
    for (const [threadId, state] of this.threads) {
      if (state.active) return this.toSnapshot(threadId, state);
    }
    return null;
  }

  /** The most recent frame for a thread, so a freshly mounted view can paint immediately. */
  getFrame(threadId: string): string | null {
    return this.latestFrame.get(threadId) ?? null;
  }

  /** The active login guest's viewport, for mapping pointer coordinates. */
  private activeGuest(threadId: string): AgentBrowserGuest | null {
    return this.threads.get(threadId)?.active?.guest ?? null;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async takeControl(threadId: string): Promise<TakeControlResult> {
    const pool = this.getPool();
    const state = this.threads.get(threadId);
    const request = state?.pending;
    if (!pool || !state || !request || state.pendingExpired) return { ok: false };

    try {
      const guest = await pool.acquireLoginGuest(threadId, request.url);
      // A newer request (or an expiry) may have landed while the guest was starting.
      if (this.threads.get(threadId) !== state) { pool.releaseLoginGuest(threadId, 'login-complete'); return { ok: false }; }
      this.bridge?.clearPending(threadId);
      state.pending = null;
      state.pendingExpired = false;
      state.returned = null;
      if (state.returnedTimer) { this.clearTimeoutFn(state.returnedTimer); state.returnedTimer = null; }
      state.active = { guest, url: request.url, startedAt: this.now() };
      guest.handoffActive = true;
      guest.focus();
      this.ensureCaptureLoop();
      this.emit(threadId);
      return { ok: true };
    } catch (error) {
      const message = `Could not start the sign-in session: ${error instanceof Error ? error.message : String(error)}`;
      this.notify(message);
      return { ok: false, message };
    }
  }

  /**
   * Take over the agent's OWN page (no popup involved): a person can sign in to
   * any page, e.g. a login form that is not a popup. The guest is locked against
   * agent operations until control is returned, and is never retired on return.
   */
  takeOver(threadId: string): TakeControlResult {
    const pool = this.getPool();
    const guest = pool?.peek(threadId) ?? null;
    if (!pool || !guest || !guest.isAlive()) return { ok: false, message: 'There is no browser page to take over.' };
    if (this.hasActive()) return { ok: false, message: 'You already have control of a browser page.' };
    const state = this.stateFor(threadId);
    const url = guest.facts().url ?? '';
    state.pending = null;
    state.pendingExpired = false;
    state.returned = null;
    if (state.returnedTimer) { this.clearTimeoutFn(state.returnedTimer); state.returnedTimer = null; }
    state.active = { guest, url, startedAt: this.now(), takeover: true };
    guest.userDriving = true;
    guest.handoffActive = true;
    guest.focus();
    this.ensureCaptureLoop();
    this.emit(threadId);
    return { ok: true };
  }

  /** Give control back to the agent. Safe when no handoff is active. */
  returnControl(threadId: string, reason: GuestEndReason = 'login-complete'): void {
    const state = this.threads.get(threadId);
    const active = state?.active;
    if (!state || !active) return;
    state.active = null;
    active.guest.handoffActive = false;
    active.guest.userDriving = false;
    this.latestFrame.delete(threadId);
    for (const l of this.frameListeners) l(threadId, null);
    if (!this.hasActive()) this.stopCaptureLoop();
    // A popup sign-in page is a temporary guest and is reclaimed; a taken-over
    // agent page is the agent's own session and must survive being handed back.
    if (!active.takeover) this.getPool()?.releaseLoginGuest(threadId, reason);

    const at = this.now();
    const host = hostOf(active.url);
    state.returned = { at, host, url: active.url };
    state.history.push({ at, outcome: 'returned', host, durationMs: at - active.startedAt });
    if (state.history.length > MAX_HISTORY) state.history.shift();
    if (state.returnedTimer) this.clearTimeoutFn(state.returnedTimer);
    state.returnedTimer = this.setTimeoutFn(() => {
      state.returnedTimer = null;
      state.returned = null;
      this.emit(threadId);
    }, HANDOFF_RETURNED_MS);
    this.emit(threadId);
  }

  /** "Not now": dismiss a pending request without acting on it. */
  dismissRequest(threadId: string): void {
    const state = this.threads.get(threadId);
    if (!state?.pending) return;
    this.bridge?.clearPending(threadId);
    state.pending = null;
    state.pendingExpired = false;
    this.emit(threadId);
  }

  // ── Input forwarding (only ever to the ACTIVE login guest) ───────────────

  forwardPointer(threadId: string, type: 'mouseDown' | 'mouseUp' | 'mouseMove', clientX: number, clientY: number, rect: ClientRect): void {
    const guest = this.activeGuest(threadId);
    if (!guest) return;
    const point = mapClientPointToViewport(clientX, clientY, rect, guest.facts().viewport);
    guest.sendInputEvent(buildMouseInputEvent(type, point));
    // Typing goes straight to the guest (no key forwarding while it holds native
    // focus), so every press must leave the guest, not the pane, owning the keyboard.
    if (type === 'mouseDown') guest.focus();
  }

  /** Give the active login guest keyboard focus (e.g. right after its pane opens). */
  focusActiveGuest(threadId: string): void {
    this.activeGuest(threadId)?.focus();
  }

  /** Returns true when the key was forwarded (so the caller should preventDefault). */
  forwardKey(threadId: string, event: DomKeyboardEventLike): boolean {
    const guest = this.activeGuest(threadId);
    if (!guest) return false;
    const mapped = mapKeyboardEvent(event);
    if (!mapped) return false;
    guest.sendInputEvent(mapped);
    // Text entry needs a `char` event between keyDown and keyUp; without it the
    // page sees key presses but no characters land in the field.
    if (mapped.type === 'keyDown' && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      guest.sendInputEvent({ type: 'char', keyCode: event.key, modifiers: mapped.modifiers });
    }
    return true;
  }

  // ── Bridge handlers ───────────────────────────────────────────────────────

  private stateFor(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = { pending: null, pendingExpired: false, active: null, returned: null, returnedTimer: null, history: [] };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private handlePending(request: PendingLoginRequest): void {
    const state = this.stateFor(request.threadId);
    state.pending = request;
    state.pendingExpired = false;
    state.expiredAt = undefined;
    this.emit(request.threadId);
  }

  private handleExpired(request: PendingLoginRequest): void {
    const state = this.threads.get(request.threadId);
    // Only expire the exact request still pending: a newer one for the same
    // thread must not be expired by an older timer.
    if (!state?.pending || state.pending.requestedAt !== request.requestedAt) return;
    state.pendingExpired = true;
    state.expiredAt = this.now();
    state.history.push({ at: state.expiredAt, outcome: 'expired', host: hostOf(request.url) });
    if (state.history.length > MAX_HISTORY) state.history.shift();
    this.emit(request.threadId);
  }

  // ── Frame capture ─────────────────────────────────────────────────────────

  private hasActive(): boolean {
    for (const s of this.threads.values()) if (s.active) return true;
    return false;
  }

  private ensureCaptureLoop(): void {
    if (this.captureTimer !== null) return;
    this.captureTimer = this.setIntervalFn(() => { void this.captureTick(); }, HANDOFF_CAPTURE_MS);
  }

  private stopCaptureLoop(): void {
    if (this.captureTimer === null) return;
    this.clearIntervalFn(this.captureTimer);
    this.captureTimer = null;
  }

  private isWatched(threadId: string): boolean {
    for (const viewer of this.viewers) {
      if ((viewer.threadId === null || viewer.threadId === threadId) && viewer.isVisible()) return true;
    }
    return false;
  }

  /** One frame per active handoff that someone is looking at. Exposed for tests. */
  async captureTick(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    try {
      for (const [threadId, state] of [...this.threads]) {
        const active = state.active;
        if (!active || !this.isWatched(threadId)) continue;
        try {
          const png = await active.guest.capture(HANDOFF_PREVIEW_WIDTH, { human: true });
          // Control may have been returned while the capture was in flight.
          if (this.threads.get(threadId)?.active !== active) continue;
          const dataUrl = pngDataUrl(png);
          this.latestFrame.set(threadId, dataUrl);
          for (const l of this.frameListeners) l(threadId, dataUrl);
        } catch {
          // The login guest died (crash, or the pool's reaper reclaimed an
          // abandoned handoff): return control so views go back to a coherent
          // state instead of freezing on a stale frame.
          this.returnControl(threadId, 'crash');
        }
      }
    } finally {
      this.capturing = false;
    }
  }

  // ── Passive live view ─────────────────────────────────────────────────────

  private ensureLiveLoop(): void {
    if (this.liveTimer !== null) return;
    this.liveTimer = this.setIntervalFn(() => { void this.liveTick(); }, LIVE_TICK_MS);
  }

  private stopLiveLoop(): void {
    if (this.liveTimer === null) return;
    this.clearIntervalFn(this.liveTimer);
    this.liveTimer = null;
  }

  /**
   * One pass of the passive loop: for each thread a visible live viewer is
   * watching, capture the agent's page if a frame is due. Never touches a
   * handoff (the dedicated loop owns those) and never captures for a thread
   * nobody can see. Exposed for tests.
   */
  async liveTick(): Promise<void> {
    if (this.liveCapturing) return;
    this.liveCapturing = true;
    try {
      const watched = new Set<string>();
      for (const viewer of this.liveViewers) if (viewer.threadId && viewer.isVisible()) watched.add(viewer.threadId);
      for (const threadId of watched) {
        if (this.threads.get(threadId)?.active) continue;
        const guest = this.getPool()?.peek(threadId) ?? null;
        if (!guest || !guest.isAlive()) {
          // The session is gone: drop the stale frame so a card falls back to its screenshot.
          this.lastLiveAt.delete(threadId);
          if (this.latestFrame.delete(threadId)) for (const l of this.frameListeners) l(threadId, null);
          continue;
        }
        const every = guest.currentState === 'busy' ? LIVE_BUSY_CAPTURE_MS : LIVE_IDLE_CAPTURE_MS;
        const last = this.lastLiveAt.get(threadId);
        if (last !== undefined && this.now() - last < every) continue;
        // Claimed before the await so an overlapping publish/tick cannot double-capture.
        this.lastLiveAt.set(threadId, this.now());
        try {
          const png = await guest.capture(HANDOFF_PREVIEW_WIDTH);
          if (this.threads.get(threadId)?.active) continue;
          const dataUrl = pngDataUrl(png);
          this.latestFrame.set(threadId, dataUrl);
          for (const l of this.frameListeners) l(threadId, dataUrl);
        } catch {
          // A capture can fail because the guest died or is busy; the next
          // pass notices a dead guest. Nothing to report from a passive frame.
        }
      }
    } finally {
      this.liveCapturing = false;
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  private toSnapshot(threadId: string, state: ThreadState): LoginHandoffSnapshot | null {
    const history = [...state.history];
    if (state.active) {
      return { threadId, phase: 'active', url: state.active.url, host: hostOf(state.active.url), startedAt: state.active.startedAt, mode: state.active.takeover ? 'takeover' : 'popup', history };
    }
    if (state.pending) {
      const { url } = state.pending;
      return state.pendingExpired
        ? { threadId, phase: 'expired', url, host: hostOf(url), expiredAt: state.expiredAt, history }
        : { threadId, phase: 'requested', url, host: hostOf(url), expiresAt: state.pending.expiresAt, history };
    }
    if (state.returned) {
      return { threadId, phase: 'returned', url: state.returned.url, host: state.returned.host, history };
    }
    return null;
  }

  /** Completed handoffs for a thread (steps only; no page data). */
  getHistory(threadId: string): readonly LoginHandoffHistoryEntry[] {
    return this.threads.get(threadId)?.history ?? [];
  }

  private emit(threadId: string): void {
    for (const listener of [...this.listeners]) listener(threadId);
  }
}
