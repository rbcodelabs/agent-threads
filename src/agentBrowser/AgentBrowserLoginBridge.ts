/**
 * Electron glue for the login-handoff UI (ADR-0014).
 *
 * Geode's ADR-0022 denies every `window.open()` on `persist:agent-browser` and
 * reports the denial two ways: `window.geode.onAgentBrowserWindowOpen` (a
 * preload-wrapped callback) for the open itself, and plain
 * `ipcRenderer.on('agent-browser-window-close'/'-focus', ...)` for what
 * happens to a guest that later got paired (the host renderer runs with
 * `nodeIntegration: true`/`contextIsolation: false`, so no preload wrapper
 * exists for those two channels).
 *
 * This class's only job is turning that wire format into thread-scoped
 * callbacks the preview view can render against, plus tracking the 30s
 * pairing TTL Geode's own registry uses so a stale "take control" click can be
 * reported as expired rather than silently doing nothing.
 *
 * Every dependency is injected (mirroring `AgentBrowserPool`'s `hostWindow`/
 * `doc`/`now` and `FdGate`'s injected probe) so this is unit-testable without
 * a real Electron/Geode host: a fake that omits `onAgentBrowserWindowOpen`
 * must behave exactly like plain Obsidian without Geode, not throw.
 */

export type WindowOpenDisposition = 'default' | 'foreground-tab' | 'background-tab' | 'new-window' | 'other';

/** Mirrors Geode's `GuestWindowOpenRequest`, as delivered over `onAgentBrowserWindowOpen`. */
export interface AgentBrowserWindowOpenRequest {
  url: string;
  guestId: number;
  disposition: WindowOpenDisposition;
}

/** The subset of `window.geode` this bridge needs. */
export interface GeodeLoginBridgeLike {
  onAgentBrowserWindowOpen?(cb: (request: AgentBrowserWindowOpenRequest) => void): () => void;
}

/** The subset of Electron's `ipcRenderer` this bridge needs. */
export interface IpcRendererLike {
  on(channel: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (...args: unknown[]) => void): unknown;
}

export interface PendingLoginRequest {
  threadId: string;
  url: string;
  requestedAt: number;
  expiresAt: number;
}

export interface AgentBrowserLoginBridgeOptions {
  /** `window.geode`, or a fake in tests. Null when the host does not expose it (plain Obsidian). */
  geode: GeodeLoginBridgeLike | null;
  /** Electron's `ipcRenderer`, or a fake in tests. Null on a non-Electron/mobile host. */
  ipcRenderer: IpcRendererLike | null;
  /** Resolve a denied popup's `guestId` to the thread whose primary guest requested it. */
  findPrimaryThreadByWebContentsId: (webContentsId: number) => string | null;
  /** Resolve a close/focus event's `guestId` to the thread owning that login guest. */
  findLoginThreadByWebContentsId: (webContentsId: number) => string | null;
  now?: () => number;
  /** Matches Geode's own pairing TTL (ADR-0022 §3): 30s. */
  ttlMs?: number;
  onPendingRequest?: (request: PendingLoginRequest) => void;
  onRequestExpired?: (request: PendingLoginRequest) => void;
  onLoginClosed?: (threadId: string) => void;
  onLoginFocused?: (threadId: string) => void;
}

const DEFAULT_TTL_MS = 30_000;
const CLOSE_CHANNEL = 'agent-browser-window-close';
const FOCUS_CHANNEL = 'agent-browser-window-focus';

export class AgentBrowserLoginBridge {
  private readonly geode: GeodeLoginBridgeLike | null;
  private readonly ipcRenderer: IpcRendererLike | null;
  private readonly findPrimaryThreadByWebContentsId: (webContentsId: number) => string | null;
  private readonly findLoginThreadByWebContentsId: (webContentsId: number) => string | null;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly onPendingRequest: (request: PendingLoginRequest) => void;
  private readonly onRequestExpired: (request: PendingLoginRequest) => void;
  private readonly onLoginClosed: (threadId: string) => void;
  private readonly onLoginFocused: (threadId: string) => void;

  private started = false;
  private unsubscribeOpen: (() => void) | null = null;
  private readonly pending = new Map<string, PendingLoginRequest>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Bound once so `removeListener` in stop() actually matches what `on()` registered.
  private readonly closeListener = (...args: unknown[]) => this.handleClose(args[1] as number);
  private readonly focusListener = (...args: unknown[]) => this.handleFocus(args[1] as number);

  constructor(options: AgentBrowserLoginBridgeOptions) {
    this.geode = options.geode;
    this.ipcRenderer = options.ipcRenderer;
    this.findPrimaryThreadByWebContentsId = options.findPrimaryThreadByWebContentsId;
    this.findLoginThreadByWebContentsId = options.findLoginThreadByWebContentsId;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.onPendingRequest = options.onPendingRequest ?? (() => {});
    this.onRequestExpired = options.onRequestExpired ?? (() => {});
    this.onLoginClosed = options.onLoginClosed ?? (() => {});
    this.onLoginFocused = options.onLoginFocused ?? (() => {});
  }

  /**
   * True when the host actually exposes the popup bridge.
   *
   * Feature detection, not a guess: plain Obsidian (no Geode), or a Geode build
   * that predates ADR-0022, both leave `onAgentBrowserWindowOpen` undefined,
   * and the whole feature is simply unavailable — matching how `fdGate`/
   * `WakeLockService` already treat `window.geode` as optional.
   */
  get available(): boolean {
    return typeof this.geode?.onAgentBrowserWindowOpen === 'function';
  }

  /** Subscribe to Geode's events. A no-op, safely repeatable, when `available` is false. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof this.geode?.onAgentBrowserWindowOpen === 'function') {
      this.unsubscribeOpen = this.geode.onAgentBrowserWindowOpen((request) => this.handleOpen(request));
    }
    this.ipcRenderer?.on(CLOSE_CHANNEL, this.closeListener);
    this.ipcRenderer?.on(FOCUS_CHANNEL, this.focusListener);
  }

  /** Unsubscribe everything and drop pending state. Safe to call repeatedly. */
  stop(): void {
    this.started = false;
    this.unsubscribeOpen?.();
    this.unsubscribeOpen = null;
    this.ipcRenderer?.removeListener(CLOSE_CHANNEL, this.closeListener);
    this.ipcRenderer?.removeListener(FOCUS_CHANNEL, this.focusListener);
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.pending.clear();
  }

  /** The pending window-open request for a thread, if one hasn't expired or been cleared. */
  pendingFor(threadId: string): PendingLoginRequest | null {
    return this.pending.get(threadId) ?? null;
  }

  /** Stop tracking a thread's pending request — called once the user acts on it either way. */
  clearPending(threadId: string): void {
    this.pending.delete(threadId);
    const timer = this.expiryTimers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(threadId);
    }
  }

  private handleOpen(request: AgentBrowserWindowOpenRequest): void {
    const threadId = this.findPrimaryThreadByWebContentsId(request.guestId);
    if (!threadId) return; // Not a guest we recognise (already gone, or not ours).

    const requestedAt = this.now();
    const pending: PendingLoginRequest = { threadId, url: request.url, requestedAt, expiresAt: requestedAt + this.ttlMs };

    const previousTimer = this.expiryTimers.get(threadId);
    if (previousTimer) clearTimeout(previousTimer);

    this.pending.set(threadId, pending);
    this.expiryTimers.set(
      threadId,
      setTimeout(() => {
        this.expiryTimers.delete(threadId);
        // Only fire if this exact request is still the one pending — a newer
        // request for the same thread must not be expired by an older timer.
        if (this.pending.get(threadId) !== pending) return;
        this.pending.delete(threadId);
        this.onRequestExpired(pending);
      }, this.ttlMs),
    );

    this.onPendingRequest(pending);
  }

  private handleClose(webContentsId: number): void {
    if (typeof webContentsId !== 'number') return;
    const threadId = this.findLoginThreadByWebContentsId(webContentsId);
    if (!threadId) return;
    this.onLoginClosed(threadId);
  }

  private handleFocus(webContentsId: number): void {
    if (typeof webContentsId !== 'number') return;
    const threadId = this.findLoginThreadByWebContentsId(webContentsId);
    if (!threadId) return;
    this.onLoginFocused(threadId);
  }
}

/**
 * Build real dependencies from the live host, or nulls where the host does not
 * expose them.
 *
 * `ipcRenderer` is only requested when `window.geode` is present, i.e. only on
 * a Geode desktop host — the same guard that makes this safe on plain
 * Obsidian and on mobile, where `require` either doesn't exist or has nothing
 * to return. The `try`/`catch` around it is defense in depth for the same
 * reason the existing `require('electron')` call sites in this repo (e.g.
 * `SkillsManagerView.ts`, `ThreadsView.ts`) call it lazily inside a handler
 * rather than at module load: it must never be able to break plugin load on a
 * host where it doesn't apply.
 */
export function createGeodeLoginBridgeDeps(hostWindow: unknown = typeof window !== 'undefined' ? window : undefined): {
  geode: GeodeLoginBridgeLike | null;
  ipcRenderer: IpcRendererLike | null;
} {
  const geode =
    hostWindow && typeof hostWindow === 'object'
      ? ((hostWindow as { geode?: GeodeLoginBridgeLike }).geode ?? null)
      : null;
  if (!geode) return { geode: null, ipcRenderer: null };

  let ipcRenderer: IpcRendererLike | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ipcRenderer = (require('electron') as { ipcRenderer?: IpcRendererLike }).ipcRenderer ?? null;
  } catch {
    ipcRenderer = null;
  }
  return { geode, ipcRenderer };
}
