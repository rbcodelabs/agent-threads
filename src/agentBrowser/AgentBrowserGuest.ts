/**
 * One agent browser guest: a single Electron `<webview>` plus the state machine,
 * budgets, and timeouts that keep it from outliving its usefulness.
 *
 * The guest owns no policy about *whether* it should exist — `AgentBrowserPool`
 * decides that. It owns everything about what happens once it does: serialising
 * operations, noticing when the page process dies, and making sure no call can
 * hang forever.
 *
 * Timeouts here are not defensive polish. `executeJavaScript` against a hung
 * guest never rejects on its own, so without racing a timer a single hostile
 * page hangs the agent's turn indefinitely.
 */

import {
  BOOTSTRAP_URL,
  CAPTURE_BUDGET,
  CAPTURE_TIMEOUT_MS,
  COMPOSITE_SETTLE_MS,
  DOM_READY_TIMEOUT_MS,
  GUEST_HEIGHT,
  GUEST_WIDTH,
  NAV_BUDGET,
  NAV_TIMEOUT_MS,
  OP_QUEUE_DEPTH,
  QUEUE_WAIT_MS,
  SCRIPT_BUDGET,
  SCRIPT_TIMEOUT_MS,
  UNRESPONSIVE_GRACE_MS,
  evaluateUrl,
  evaluateViewport,
  type UrlPolicyOptions,
} from './agentBrowserPolicy';
import { AgentBrowserError, REFS_INVALIDATED_HINT } from './agentBrowserErrors';

/**
 * The subset of Electron's `WebviewTag` this module uses.
 *
 * Declared locally, the way Geode's own `web-view.ts` does, so the plugin does
 * not take a dependency on Electron's DOM typings. Note that Geode's copy
 * deliberately omits `executeJavaScript`/`capturePage`; ours needs them, which is
 * why the Geode e2e test pinning those methods exists.
 */
export interface WebviewLike extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  stop(): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  capturePage(): Promise<NativeImageLike>;
  insertCSS(css: string): Promise<string>;
  getWebContentsId(): number;
}

export interface NativeImageLike {
  toPNG(): Uint8Array;
  resize(options: { width?: number; height?: number }): NativeImageLike;
  getSize(): { width: number; height: number };
}

export type GuestState = 'creating' | 'ready' | 'busy' | 'dead' | 'destroyed';

/** Why a guest stopped existing. Surfaced in logs so leak audits are greppable. */
export type GuestEndReason =
  | 'tool'
  | 'reap'
  | 'ttl'
  | 'budget'
  | 'fd'
  | 'thread-delete'
  | 'archive'
  | 'shutdown'
  | 'unload'
  | 'crash'
  | 'hang'
  | 'detach'
  | 'cap';

export interface GuestFacts {
  threadId: string;
  state: GuestState;
  url: string | null;
  ageMs: number;
  idleMs: number;
  navCount: number;
  scriptCount: number;
  captureCount: number;
  viewport: { width: number; height: number };
}

export interface AgentBrowserGuestOptions {
  threadId: string;
  container: HTMLElement;
  doc: Document;
  partition: string;
  urlPolicy: UrlPolicyOptions;
  /** Invoked when the guest dies on its own (crash, hang, policy abort). */
  onDied: (reason: GuestEndReason, error: AgentBrowserError) => void;
  now?: () => number;
  /**
   * Brings the guest somewhere the compositor will draw it, for the duration of
   * a screenshot. Optional so a guest can be built without a host in tests.
   */
  captureSurface?: { begin(): void; end(): void };
}

/**
 * Hardened webPreferences set directly on the tag.
 *
 * This is the *only* enforcement available from the renderer. Geode's
 * `will-attach-webview` forces safe preferences for `persist:webviewer` and the
 * artifact partitions, but any other partition — including ours — attaches with
 * whatever the element asks for. Gap G3 in the plan is to give this a host-side
 * floor rather than trusting the tag.
 *
 * `backgroundThrottling=no` is required, not optional: an off-screen guest is
 * occlusion-throttled and its timers stall, which looks exactly like a hung page.
 *
 * Deliberately absent, all defaulting to the safe value: `nodeintegration`,
 * `allowpopups`, `disablewebsecurity`, and above all `preload` — a plugin-owned
 * preload would be the one bridge between a hostile page and the host.
 */
const GUEST_WEBPREFERENCES = [
  'contextIsolation=yes',
  'sandbox=yes',
  'nodeIntegration=no',
  'nodeIntegrationInSubFrames=no',
  'webSecurity=yes',
  'allowRunningInsecureContent=no',
  'backgroundThrottling=no',
].join(',');

/** Emitted for cancelled and redirected navigations; not a real failure. */
const ERR_ABORTED = -3;

interface DidFailLoadEventLike {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

interface DidNavigateEventLike {
  url: string;
  isMainFrame?: boolean;
}

export class AgentBrowserGuest {
  readonly threadId: string;
  private readonly doc: Document;
  private readonly container: HTMLElement;
  private readonly partition: string;
  private readonly urlPolicy: UrlPolicyOptions;
  private readonly onDied: (reason: GuestEndReason, error: AgentBrowserError) => void;
  private readonly now: () => number;
  private readonly captureSurface?: { begin(): void; end(): void };

  private el: WebviewLike | null = null;
  private state: GuestState = 'creating';
  private readonly createdAt: number;
  private lastUsedAt: number;

  private navCount = 0;
  private scriptCount = 0;
  private captureCount = 0;
  private width = GUEST_WIDTH;
  private height = GUEST_HEIGHT;

  /**
   * Some Electron/macOS builds emit both `render-process-gone` and the legacy
   * `crashed` alias for one death. Geode's `web-view.ts` de-dupes the same way.
   */
  private crashHandled = false;
  private unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;

  private chain: Promise<unknown> = Promise.resolve();
  private queueDepth = 0;
  private readonly pendingAborts = new Set<(error: AgentBrowserError) => void>();
  private readonly cleanups: Array<() => void> = [];

  constructor(options: AgentBrowserGuestOptions) {
    this.threadId = options.threadId;
    this.doc = options.doc;
    this.container = options.container;
    this.partition = options.partition;
    this.urlPolicy = options.urlPolicy;
    this.onDied = options.onDied;
    this.now = options.now ?? Date.now;
    this.captureSurface = options.captureSurface;
    this.createdAt = this.now();
    this.lastUsedAt = this.createdAt;
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  get currentState(): GuestState {
    return this.state;
  }

  get element(): WebviewLike | null {
    return this.el;
  }

  get ageMs(): number {
    return this.now() - this.createdAt;
  }

  get idleMs(): number {
    return this.now() - this.lastUsedAt;
  }

  facts(): GuestFacts {
    let url: string | null = null;
    try {
      url = this.el && this.state !== 'destroyed' ? this.el.getURL() : null;
    } catch {
      url = null;
    }
    return {
      threadId: this.threadId,
      state: this.state,
      url,
      ageMs: this.ageMs,
      idleMs: this.idleMs,
      navCount: this.navCount,
      scriptCount: this.scriptCount,
      captureCount: this.captureCount,
      viewport: { width: this.width, height: this.height },
    };
  }

  /** True when a budget or nothing-left-to-give condition means recycle. */
  budgetExhausted(): boolean {
    return (
      this.navCount >= NAV_BUDGET ||
      this.scriptCount >= SCRIPT_BUDGET ||
      this.captureCount >= CAPTURE_BUDGET
    );
  }

  /**
   * Whether the element still backs a live WebContents.
   *
   * A `<webview>` that was detached and re-attached is a *different* WebContents,
   * and `getWebContentsId()` throws once the guest is gone — so a throw here is
   * the most direct liveness signal available from the renderer.
   */
  isAlive(): boolean {
    if (this.state === 'dead' || this.state === 'destroyed') return false;
    const el = this.el;
    if (!el || !el.isConnected) return false;
    if (!this.container.isConnected) return false;
    try {
      el.getWebContentsId();
      return true;
    } catch {
      return false;
    }
  }

  // ── Creation ───────────────────────────────────────────────────────────────

  /**
   * Build the element, attach it, and wait for the guest to come up.
   *
   * A guest that never reaches `dom-ready` is usually a file-descriptor casualty
   * (the "exit code 6" death), so failing here is reported as a start timeout
   * rather than retried blindly.
   */
  async start(): Promise<void> {
    const el = this.doc.createElement('webview') as unknown as WebviewLike;
    el.setAttribute('partition', this.partition);
    el.setAttribute('webpreferences', GUEST_WEBPREFERENCES);
    el.setAttribute('src', BOOTSTRAP_URL);
    el.style.cssText = `width:${GUEST_WIDTH}px;height:${GUEST_HEIGHT}px;border:0;display:flex;`;
    this.el = el;

    // Install every listener before attaching: `did-attach` and `dom-ready` can
    // fire as the element is inserted, and a missed death is a leaked process.
    this.attachListeners(el);
    this.container.appendChild(el);

    try {
      await this.waitForEvent(el, 'dom-ready', DOM_READY_TIMEOUT_MS);
    } catch {
      const error = new AgentBrowserError({
        code: 'guest_start_timeout',
        message: `The browser page process did not start within ${DOM_READY_TIMEOUT_MS}ms.`,
        retryable: true,
      });
      this.die('crash', error);
      throw error;
    }

    if (this.state === 'creating') this.state = 'ready';
  }

  private attachListeners(el: WebviewLike): void {
    const on = (event: string, handler: (e: Event) => void) => {
      el.addEventListener(event, handler as EventListener);
      this.cleanups.push(() => el.removeEventListener(event, handler as EventListener));
    };

    on('render-process-gone', (event) => {
      const details = (event as unknown as { details?: { reason?: string; exitCode?: number } }).details;
      this.handleCrash(details?.reason, details?.exitCode);
    });
    // Legacy alias on some builds; de-duped by `crashHandled`.
    on('crashed', () => this.handleCrash());

    on('did-fail-load', (event) => {
      const detail = event as unknown as DidFailLoadEventLike;
      // Sub-frame failures and aborted/redirected navigations are normal.
      if (!detail.isMainFrame || detail.errorCode === ERR_ABORTED) return;
      // A main-frame failure is not fatal to the guest; the caller's navigate()
      // promise reports it. Nothing to do here beyond leaving the guest usable.
    });

    on('unresponsive', () => this.handleUnresponsive());
    on('responsive', () => this.handleResponsive());

    // Best-effort enforcement of URL policy against navigations the page starts
    // itself. `will-navigate` on the tag is not cancelable from the renderer, so
    // this is detect-and-abort and is inherently racy — the real fix is a
    // main-process guard (gap G2).
    on('did-start-navigation', (event) => {
      const detail = event as unknown as DidNavigateEventLike;
      if (detail.isMainFrame === false) return;
      if (!detail.url || detail.url === BOOTSTRAP_URL) return;
      const decision = evaluateUrl(detail.url, this.urlPolicy);
      if (decision.allowed) return;
      try {
        el.stop();
        void el.loadURL(BOOTSTRAP_URL).catch(() => {});
      } catch {
        /* the guest may already be gone */
      }
      this.die(
        'detach',
        new AgentBrowserError({
          code: 'navigation_blocked',
          message: `The page tried to navigate to a blocked URL (${detail.url}) and was stopped. ${decision.reason}`,
          retryable: false,
          hint: REFS_INVALIDATED_HINT,
        }),
      );
    });
  }

  private waitForEvent(el: WebviewLike, event: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        el.removeEventListener(event, handler as EventListener);
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeoutMs);
      const handler = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        el.removeEventListener(event, handler as EventListener);
        resolve();
      };
      el.addEventListener(event, handler as EventListener);
    });
  }

  // ── Death ──────────────────────────────────────────────────────────────────

  private handleCrash(reason?: string, exitCode?: number): void {
    if (this.crashHandled) return;
    this.crashHandled = true;
    const detail = [reason, exitCode !== undefined ? `exit code ${exitCode}` : null]
      .filter(Boolean)
      .join(', ');
    this.die(
      'crash',
      new AgentBrowserError({
        code: 'guest_crashed',
        message: `The browser page process died${detail ? ` (${detail})` : ''}.`,
        retryable: true,
        hint: REFS_INVALIDATED_HINT,
      }),
    );
  }

  /**
   * A guest that stops responding gets a grace period, then is destroyed.
   *
   * Waiting indefinitely for `responsive` is not an option: a hung guest pins a
   * renderer process and its descriptors, which is a leak regardless of what the
   * bookkeeping says.
   */
  private handleUnresponsive(): void {
    if (this.unresponsiveTimer || this.state === 'dead' || this.state === 'destroyed') return;
    this.unresponsiveTimer = setTimeout(() => {
      this.unresponsiveTimer = null;
      this.die(
        'hang',
        new AgentBrowserError({
          code: 'guest_hung',
          message: `The page stopped responding for ${UNRESPONSIVE_GRACE_MS}ms and was closed.`,
          retryable: true,
          hint: REFS_INVALIDATED_HINT,
        }),
      );
    }, UNRESPONSIVE_GRACE_MS);
  }

  private handleResponsive(): void {
    if (this.unresponsiveTimer) {
      clearTimeout(this.unresponsiveTimer);
      this.unresponsiveTimer = null;
    }
  }

  /**
   * Transition to dead, fail every outstanding call, and tell the pool.
   *
   * Queued operations are rejected immediately rather than left to hit their own
   * timeouts: letting eight queued calls each wait out a 10-30s deadline turns
   * one crash into minutes of apparent hang.
   */
  private die(reason: GuestEndReason, error: AgentBrowserError): void {
    if (this.state === 'destroyed') return;
    const wasAlive = this.state !== 'dead';
    this.state = 'dead';
    this.failPending(error);
    this.teardownElement();
    if (wasAlive) this.onDied(reason, error);
  }

  private failPending(error: AgentBrowserError): void {
    const aborts = [...this.pendingAborts];
    this.pendingAborts.clear();
    for (const abort of aborts) abort(error);
  }

  private teardownElement(): void {
    if (this.unresponsiveTimer) {
      clearTimeout(this.unresponsiveTimer);
      this.unresponsiveTimer = null;
    }
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* removing a listener from a dead element can throw; nothing to do */
      }
    }
    if (this.el) {
      try {
        this.el.remove();
      } catch {
        /* already detached */
      }
      this.el = null;
    }
  }

  /**
   * Reclaim the guest.
   *
   * Synchronous and idempotent by contract: this runs from plugin teardown paths
   * that are not awaited, and `el.remove()` destroys the WebContents immediately.
   * The destructive behaviour that bites the Web Viewer is the feature here.
   */
  destroy(reason: GuestEndReason): void {
    if (this.state === 'destroyed') return;
    const error = new AgentBrowserError({
      code: reason === 'crash' || reason === 'hang' ? 'guest_crashed' : 'destroyed_during_call',
      message: `The browser session was closed (${reason}).`,
      retryable: true,
      hint: REFS_INVALIDATED_HINT,
    });
    this.failPending(error);
    this.teardownElement();
    this.state = 'destroyed';
  }

  // ── Operations ─────────────────────────────────────────────────────────────

  /**
   * Run `fn` with exclusive access to the guest.
   *
   * Serialising matters because two tool calls in one turn could otherwise
   * interleave a navigation with a snapshot and produce refs describing a page
   * that is no longer loaded.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'destroyed' || this.state === 'dead') {
      return Promise.reject(
        new AgentBrowserError({
          code: 'destroyed_during_call',
          message: 'The browser session is no longer available.',
          retryable: true,
          hint: REFS_INVALIDATED_HINT,
        }),
      );
    }
    if (this.queueDepth >= OP_QUEUE_DEPTH) {
      return Promise.reject(
        new AgentBrowserError({
          code: 'queue_depth_exceeded',
          message: `Too many browser operations are already queued (limit ${OP_QUEUE_DEPTH}).`,
          retryable: true,
        }),
      );
    }

    this.queueDepth += 1;
    const enqueuedAt = this.now();

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const abort = (error: AgentBrowserError) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      this.pendingAborts.add(abort);

      const run = async (): Promise<void> => {
        try {
          if (settled) return;
          if (this.now() - enqueuedAt > QUEUE_WAIT_MS) {
            throw new AgentBrowserError({
              code: 'queue_timeout',
              message: `The browser operation waited more than ${QUEUE_WAIT_MS}ms behind other work.`,
              retryable: true,
            });
          }
          if (!this.isAlive()) {
            throw new AgentBrowserError({
              code: 'destroyed_during_call',
              message: 'The browser session ended before this operation ran.',
              retryable: true,
              hint: REFS_INVALIDATED_HINT,
            });
          }
          this.state = 'busy';
          const value = await fn();
          if (settled) return;
          settled = true;
          this.lastUsedAt = this.now();
          resolve(value);
        } catch (error) {
          if (settled) return;
          settled = true;
          reject(this.classifyError(error));
        } finally {
          this.pendingAborts.delete(abort);
          this.queueDepth -= 1;
          if (this.state === 'busy') this.state = 'ready';
        }
      };

      // `.then(run, run)` so one failed operation does not stall the queue.
      this.chain = this.chain.then(run, run);
    });
  }

  /** Navigate, enforcing URL policy before the request leaves. */
  navigate(url: string): Promise<{ url: string; title: string }> {
    const decision = evaluateUrl(url, this.urlPolicy);
    if (!decision.allowed) {
      return Promise.reject(
        new AgentBrowserError({
          code: 'navigation_blocked',
          message: decision.reason,
          retryable: false,
        }),
      );
    }
    return this.enqueue(async () => {
      const el = this.requireElement();
      this.navCount += 1;
      await withTimeout(
        el.loadURL(decision.url),
        NAV_TIMEOUT_MS,
        () =>
          new AgentBrowserError({
            code: 'navigation_timeout',
            message: `The page did not finish loading within ${NAV_TIMEOUT_MS}ms.`,
            retryable: true,
          }),
        () => {
          try {
            el.stop();
          } catch {
            /* guest may be gone */
          }
        },
      );
      return { url: safeUrl(el), title: safeTitle(el) };
    });
  }

  /**
   * Resize the guest's viewport, enforcing policy before anything is enqueued.
   *
   * Sets `style.width`/`style.height` individually rather than overwriting
   * `style.cssText`, so the `border`/`display` set once in `start()` survive.
   * Awaits the same settle delay `capture()` uses so a subsequent
   * snapshot/screenshot reflects the new layout rather than racing it.
   */
  resize(width: number, height: number): Promise<{ width: number; height: number }> {
    const decision = evaluateViewport(width, height);
    if (!decision.ok) {
      return Promise.reject(
        new AgentBrowserError({
          code: 'invalid_viewport',
          message: decision.reason,
          retryable: false,
        }),
      );
    }
    return this.enqueue(async () => {
      const el = this.requireElement();
      el.style.width = `${decision.width}px`;
      el.style.height = `${decision.height}px`;
      this.width = decision.width;
      this.height = decision.height;
      await new Promise((resolve) => setTimeout(resolve, COMPOSITE_SETTLE_MS));
      return { width: decision.width, height: decision.height };
    });
  }

  /** Run a script string in the page and return its value. */
  runScript(code: string): Promise<unknown> {
    return this.enqueue(async () => {
      const el = this.requireElement();
      this.scriptCount += 1;
      return withTimeout(
        el.executeJavaScript(code, false),
        SCRIPT_TIMEOUT_MS,
        () =>
          new AgentBrowserError({
            code: 'script_timeout',
            message: `The page did not respond to an injected script within ${SCRIPT_TIMEOUT_MS}ms.`,
            retryable: true,
          }),
      );
    });
  }

  /**
   * Capture the guest viewport as PNG bytes.
   *
   * The guest must be composited for this to work at all — a parked, culled
   * layer has no frame, and `capturePage()` then rejects with `UnknownVizError`
   * or, in a hidden window, never settles. So the container is moved on-screen
   * (behind the app, inert) for the duration, given a moment to actually draw,
   * and parked again in a `finally` so a failure cannot strand it in view.
   */
  capture(maxWidth = GUEST_WIDTH): Promise<Uint8Array> {
    return this.enqueue(async () => {
      const el = this.requireElement();
      this.captureCount += 1;
      this.captureSurface?.begin();
      try {
        // A fixed delay rather than requestAnimationFrame: rAF does not fire in
        // a window that is not being drawn, which is one of the states this
        // needs to survive.
        await new Promise((resolve) => setTimeout(resolve, COMPOSITE_SETTLE_MS));
        const image = await withTimeout(
          el.capturePage(),
          CAPTURE_TIMEOUT_MS,
          () =>
            new AgentBrowserError({
              code: 'capture_timeout',
              message: `The page screenshot did not complete within ${CAPTURE_TIMEOUT_MS}ms.`,
              retryable: true,
            }),
        );
        const sized = maxWidth < GUEST_WIDTH ? image.resize({ width: maxWidth }) : image;
        return sized.toPNG();
      } finally {
        this.captureSurface?.end();
      }
    });
  }

  /**
   * Turn an unexpected rejection into an honest error.
   *
   * The distinction is worth the extra check: an operation can fail while the
   * page is perfectly healthy. `capturePage()` on an uncomposited guest rejects
   * with `UnknownVizError` even though the guest is sitting there `ready` —
   * calling that a crash tells the agent every element ref it holds is dead and
   * throws away a working session for nothing.
   */
  private classifyError(error: unknown): AgentBrowserError {
    if (error instanceof AgentBrowserError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (this.isAlive()) {
      return new AgentBrowserError({ code: 'operation_failed', message, retryable: true });
    }
    return new AgentBrowserError({
      code: 'guest_crashed',
      message,
      retryable: true,
      hint: REFS_INVALIDATED_HINT,
    });
  }

  private requireElement(): WebviewLike {
    const el = this.el;
    if (!el) {
      throw new AgentBrowserError({
        code: 'destroyed_during_call',
        message: 'The browser session is no longer available.',
        retryable: true,
        hint: REFS_INVALIDATED_HINT,
      });
    }
    return el;
  }
}

function safeUrl(el: WebviewLike): string {
  try {
    return el.getURL();
  } catch {
    return '';
  }
}

function safeTitle(el: WebviewLike): string {
  try {
    return el.getTitle();
  } catch {
    return '';
  }
}

/**
 * Race `promise` against a deadline.
 *
 * `onTimeout` runs only on the timeout path, so a navigation can be stopped
 * without also firing when the call succeeds normally.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  makeError: () => AgentBrowserError,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(makeError());
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
