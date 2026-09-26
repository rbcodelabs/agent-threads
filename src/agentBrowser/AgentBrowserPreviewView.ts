/**
 * A window onto whatever the agent browser is currently doing.
 *
 * The original problem with the external browser CLI was not only that it leaked
 * processes — it was that the leak was *invisible*. Sessions accumulated with no
 * indication anything was running until the machine was covered in stray browser
 * windows. So this pane exists as much for the running count and the stop button
 * as for the picture.
 *
 * It renders frames captured from the guest into an `<img>`. It deliberately does
 * NOT move the `<webview>` into this leaf: workspace tab groups swap panes by
 * clearing their host element, so a guest parented here would be destroyed the
 * moment the user switched tabs — the exact failure the hidden container was
 * built to avoid. Capture-and-display costs a frame copy and keeps the guest
 * safely out of the workspace.
 */

import { ItemView, WorkspaceLeaf, setIcon, setTooltip, Notice } from 'obsidian';

import type { AgentBrowserPool } from './AgentBrowserPool';
import type { AgentBrowserGuest, GuestEndReason } from './AgentBrowserGuest';
import { pngDataUrl } from './agentBrowserImage';
import {
  AgentBrowserLoginBridge,
  createGeodeLoginBridgeDeps,
  type PendingLoginRequest,
} from './AgentBrowserLoginBridge';
import { buildMouseInputEvent, mapClientPointToViewport, mapKeyboardEvent } from './agentBrowserInput';

export const AGENT_BROWSER_VIEW_TYPE = 'claude-threads:browser-preview';

/** Frame cadence while the agent is actively driving the page. */
const ACTIVE_TICKS = 1;
/**
 * Frame cadence while the session is idle.
 *
 * An idle guest's page rarely changes, and `capturePage()` is the most expensive
 * operation available — it is budgeted per guest for exactly that reason. One
 * frame every five seconds keeps the pane honest without spending that budget on
 * a static page.
 */
const IDLE_TICKS = 5;

/** Preview frames are scaled down; this pane is for orientation, not detail. */
const PREVIEW_WIDTH = 640;

/**
 * Frame cadence while a login handoff is active (ADR-0014 §4).
 *
 * A deliberate trade of guest capture budget for responsiveness during a
 * short, bounded, human-driven window — the normal 1s/5s active/idle cadence
 * would make typing into a login form feel broken.
 */
const HANDOFF_CAPTURE_MS = 250;

/** An accepted login handoff: which thread, and the login guest now being controlled. */
interface ActiveHandoff {
  threadId: string;
  guest: AgentBrowserGuest;
}

export class AgentBrowserPreviewView extends ItemView {
  private readonly getPool: () => AgentBrowserPool | null;
  private headerEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private imageEl!: HTMLImageElement;
  private emptyEl!: HTMLElement;
  private stopButtonEl!: HTMLButtonElement;
  private bannerEl!: HTMLElement;
  private bannerTextEl!: HTMLElement;
  private takeControlButtonEl!: HTMLButtonElement;
  private returnControlButtonEl!: HTMLButtonElement;
  private tick = 0;
  /** Guards against overlapping captures when one is slower than the interval. */
  private capturing = false;

  /** The Geode popup bridge (ADR-0014). Owned for this view's lifetime; a no-op off Geode desktop. */
  private loginBridge: AgentBrowserLoginBridge | null = null;
  /** A denied window.open() the user hasn't acted on yet, scoped to one thread. */
  private pendingRequest: PendingLoginRequest | null = null;
  /** Set once `pendingRequest`'s 30s TTL elapses, so the banner explains rather than vanishes. */
  private pendingExpired = false;
  /** The in-progress "take control" session, if any. */
  private handoff: ActiveHandoff | null = null;
  private handoffCaptureTimerId: number | null = null;
  private readonly now: () => number;

  constructor(leaf: WorkspaceLeaf, getPool: () => AgentBrowserPool | null, now: () => number = Date.now) {
    super(leaf);
    this.getPool = getPool;
    this.now = now;
  }

  getViewType(): string {
    return AGENT_BROWSER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Agent Browser';
  }

  getIcon(): string {
    return 'globe';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-browser-preview');

    this.headerEl = root.createDiv({ cls: 'ct-browser-preview-header' });
    const textEl = this.headerEl.createDiv({ cls: 'ct-browser-preview-text' });
    this.summaryEl = textEl.createDiv({ cls: 'ct-browser-preview-summary' });
    this.detailEl = textEl.createDiv({ cls: 'ct-browser-preview-detail' });

    this.stopButtonEl = this.headerEl.createEl('button', { cls: 'ct-browser-preview-stop' });
    setIcon(this.stopButtonEl, 'circle-x');
    setTooltip(this.stopButtonEl, 'Close this browser session');
    this.stopButtonEl.addEventListener('click', () => this.stopActiveSession());

    this.bannerEl = root.createDiv({ cls: 'ct-browser-login-banner' });
    this.bannerTextEl = this.bannerEl.createDiv({ cls: 'ct-browser-login-banner-text' });
    const bannerActions = this.bannerEl.createDiv({ cls: 'ct-browser-login-banner-actions' });
    this.takeControlButtonEl = bannerActions.createEl('button', {
      cls: 'ct-browser-login-banner-action',
      text: 'Take control',
    });
    this.takeControlButtonEl.addEventListener('click', () => void this.takeControl());
    this.returnControlButtonEl = bannerActions.createEl('button', {
      cls: 'ct-browser-login-banner-action',
      text: 'Return control',
    });
    this.returnControlButtonEl.addEventListener('click', () => this.returnControl('login-complete'));
    this.bannerEl.style.display = 'none';

    const body = root.createDiv({ cls: 'ct-browser-preview-body' });
    this.imageEl = body.createEl('img', { cls: 'ct-browser-preview-frame' });
    this.imageEl.alt = 'Current agent browser page';
    // Focusable so keydown/keyup can be forwarded during a login handoff.
    this.imageEl.tabIndex = 0;
    this.emptyEl = body.createDiv({ cls: 'ct-browser-preview-empty' });

    this.registerDomEvent(this.imageEl, 'pointerdown', (event) => this.forwardMouseEvent('mouseDown', event));
    this.registerDomEvent(this.imageEl, 'pointerup', (event) => this.forwardMouseEvent('mouseUp', event));
    this.registerDomEvent(this.imageEl, 'keydown', (event) => this.forwardKeyboardEvent(event));
    this.registerDomEvent(this.imageEl, 'keyup', (event) => this.forwardKeyboardEvent(event));

    // registerInterval ties the timer to the view's lifetime, so closing the
    // leaf stops the capture loop without any explicit teardown here.
    this.registerInterval(window.setInterval(() => void this.refresh(), 1000));
    this.startLoginBridge();
    this.render();
  }

  async onClose(): Promise<void> {
    // Nothing to reclaim about the guests: they are owned by the pool, not by
    // this view. Closing the pane must never close the agent's browser — and
    // that includes a login guest mid-handoff, which is left for the pool's
    // own idle/TTL reaper rather than torn down here (ADR-0014's Risks: an
    // abandoned handoff is reclaimed on the same schedule as anything else).
    this.stopHandoffCaptureLoop();
    this.loginBridge?.stop();
    this.loginBridge = null;
  }

  private stopActiveSession(): void {
    const pool = this.getPool();
    const guest = pool?.mostRecentlyUsed();
    if (!pool || !guest) return;
    pool.destroyForThread(guest.threadId, 'tool');
    this.render();
  }

  // ── Login handoff (ADR-0014) ────────────────────────────────────────────────

  private startLoginBridge(): void {
    const { geode, ipcRenderer } = createGeodeLoginBridgeDeps();
    const bridge = new AgentBrowserLoginBridge({
      geode,
      ipcRenderer,
      findPrimaryThreadByWebContentsId: (id) => this.getPool()?.findPrimaryByWebContentsId(id) ?? null,
      findLoginThreadByWebContentsId: (id) => this.getPool()?.findLoginByWebContentsId(id) ?? null,
      onPendingRequest: (request) => {
        this.pendingRequest = request;
        this.pendingExpired = false;
        this.render();
      },
      onRequestExpired: (request) => {
        if (this.pendingRequest?.threadId === request.threadId && this.pendingRequest.requestedAt === request.requestedAt) {
          this.pendingExpired = true;
          this.render();
        }
      },
      onLoginClosed: (threadId) => {
        // The login guest's own window.close() was relayed. If that is the
        // handoff currently in progress, treat it exactly like the user
        // clicking "Return control".
        if (this.handoff?.threadId === threadId) this.returnControl('login-complete');
      },
      onLoginFocused: (threadId) => {
        if (this.handoff?.threadId === threadId) this.app.workspace.revealLeaf(this.leaf);
      },
    });
    bridge.start();
    this.loginBridge = bridge;
  }

  private async takeControl(): Promise<void> {
    const pool = this.getPool();
    const request = this.pendingRequest;
    if (!pool || !request || this.pendingExpired) return;

    const { threadId, url } = request;
    try {
      const guest = await pool.acquireLoginGuest(threadId, url);
      this.loginBridge?.clearPending(threadId);
      this.pendingRequest = null;
      this.pendingExpired = false;
      this.handoff = { threadId, guest };
      guest.focus();
      this.startHandoffCaptureLoop();
      this.render();
    } catch (error) {
      new Notice(`Could not start the sign-in session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private returnControl(reason: GuestEndReason): void {
    const handoff = this.handoff;
    if (!handoff) return;
    this.handoff = null;
    this.stopHandoffCaptureLoop();
    this.getPool()?.releaseLoginGuest(handoff.threadId, reason);
    this.render();
  }

  private startHandoffCaptureLoop(): void {
    this.stopHandoffCaptureLoop();
    const id = window.setInterval(() => void this.captureHandoffFrame(), HANDOFF_CAPTURE_MS);
    this.handoffCaptureTimerId = id;
    this.registerInterval(id);
  }

  private stopHandoffCaptureLoop(): void {
    if (this.handoffCaptureTimerId === null) return;
    window.clearInterval(this.handoffCaptureTimerId);
    this.handoffCaptureTimerId = null;
  }

  private async captureHandoffFrame(): Promise<void> {
    const handoff = this.handoff;
    if (!handoff || !this.isVisible() || this.capturing) return;

    this.capturing = true;
    try {
      const png = await handoff.guest.capture(PREVIEW_WIDTH);
      this.imageEl.src = pngDataUrl(png);
      this.imageEl.style.display = '';
    } catch {
      // The login guest died (crash, or the pool's own idle/TTL reaper
      // reclaimed an abandoned handoff) — return control so the pane goes
      // back to a coherent state instead of freezing on a stale frame.
      this.returnControl('crash');
    } finally {
      this.capturing = false;
    }
  }

  private forwardMouseEvent(type: 'mouseDown' | 'mouseUp', event: PointerEvent): void {
    const handoff = this.handoff;
    if (!handoff) return;
    const rect = this.imageEl.getBoundingClientRect();
    const point = mapClientPointToViewport(event.clientX, event.clientY, rect, handoff.guest.facts().viewport);
    handoff.guest.sendInputEvent(buildMouseInputEvent(type, point));
  }

  private forwardKeyboardEvent(event: KeyboardEvent): void {
    const handoff = this.handoff;
    if (!handoff) return;
    const mapped = mapKeyboardEvent({
      key: event.key,
      type: event.type as 'keydown' | 'keyup',
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    });
    if (!mapped) return;
    event.preventDefault();
    handoff.guest.sendInputEvent(mapped);
  }

  /**
   * Capture a frame if it is worth capturing.
   *
   * Skipped entirely when the leaf is not visible. A background pane that keeps
   * screenshotting would burn the guest's capture budget and CPU on frames
   * nobody can see — and budget exhaustion recycles the guest, so an unwatched
   * pane could actually shorten a working session.
   */
  private async refresh(): Promise<void> {
    this.tick += 1;

    if (this.handoff) {
      // Frame capture during a handoff is owned by the faster dedicated loop
      // (`startHandoffCaptureLoop`); this tick still drives the countdown text
      // and keeps the header/detail rows current.
      this.render();
      return;
    }

    const pool = this.getPool();
    const guest = pool?.mostRecentlyUsed() ?? null;

    this.render(guest);

    if (!guest || !this.isVisible()) return;
    const cadence = guest.currentState === 'busy' ? ACTIVE_TICKS : IDLE_TICKS;
    if (this.tick % cadence !== 0) return;
    if (this.capturing) return;

    this.capturing = true;
    try {
      const png = await guest.capture(PREVIEW_WIDTH);
      this.imageEl.src = pngDataUrl(png);
      this.imageEl.style.display = '';
    } catch {
      // A capture can fail because the guest died between render and capture.
      // The next render reflects that; there is nothing to report here.
    } finally {
      this.capturing = false;
    }
  }

  /** Obsidian's `isShown` is not present in every environment (tests, harness). */
  private isVisible(): boolean {
    const el = this.containerEl as HTMLElement & { isShown?: () => boolean };
    return typeof el.isShown === 'function' ? el.isShown() : true;
  }

  private render(guest: AgentBrowserGuest | null = this.getPool()?.mostRecentlyUsed() ?? null): void {
    const pool = this.getPool();
    if (!pool) {
      this.summaryEl.setText('Agent browser is off');
      this.detailEl.setText('Enable it under Settings → Tools.');
      this.showEmpty('The agent browser is not enabled.');
      this.renderBanner(null);
      return;
    }

    const status = pool.status();
    this.summaryEl.setText(`Browser ${status.inUse}/${status.max}`);

    if (this.handoff) {
      // The opener guest is never touched during a handoff, so the stop
      // control (which only ever targets the primary guest) stays hidden —
      // "Return control" in the banner is the only exit while one is active.
      this.stopButtonEl.toggleClass('is-hidden', true);
      this.detailEl.setText('Signing in — you have control of this page.');
      this.emptyEl.style.display = 'none';
      this.renderBanner(guest);
      return;
    }

    this.stopButtonEl.toggleClass('is-hidden', guest === null);

    if (!guest) {
      this.detailEl.setText(status.fdBlocked ? 'Paused — low on file handles' : 'No session running');
      this.showEmpty('Nothing is being browsed right now.');
      this.renderBanner(null);
      return;
    }

    const facts = guest.facts();
    const host = hostOf(facts.url);
    this.detailEl.setText(
      [host, facts.state, `${formatDuration(facts.ageMs)} old`, `${facts.navCount} page${facts.navCount === 1 ? '' : 's'}`]
        .filter(Boolean)
        .join(' · '),
    );
    this.emptyEl.style.display = 'none';
    this.renderBanner(guest);
  }

  /**
   * Render the login-handoff banner: a pending request for the currently
   * displayed thread, the active handoff itself, or nothing.
   */
  private renderBanner(guest: AgentBrowserGuest | null): void {
    if (this.handoff) {
      this.bannerEl.style.display = '';
      this.bannerEl.toggleClass('is-handoff-active', true);
      this.bannerTextEl.setText('You are signing in on a temporary browser page.');
      this.takeControlButtonEl.style.display = 'none';
      this.returnControlButtonEl.style.display = '';
      return;
    }

    this.bannerEl.toggleClass('is-handoff-active', false);
    this.returnControlButtonEl.style.display = 'none';

    const pending = this.pendingRequest;
    // Scoped to the thread currently shown, per ADR-0014 §4 — a pending
    // request for a different thread does not surface here.
    if (!pending || !guest || pending.threadId !== guest.threadId) {
      this.bannerEl.style.display = 'none';
      return;
    }

    this.bannerEl.style.display = '';
    this.takeControlButtonEl.style.display = this.pendingExpired ? 'none' : '';

    if (this.pendingExpired) {
      this.bannerTextEl.setText(
        `The sign-in request for ${hostOf(pending.url)} expired. Click sign-in on the page again to retry.`,
      );
      return;
    }

    const remainingSeconds = Math.max(0, Math.ceil((pending.expiresAt - this.now()) / 1000));
    this.bannerTextEl.setText(
      `This page wants you to sign in (${hostOf(pending.url)}) — ${remainingSeconds}s to take control.`,
    );
  }

  private showEmpty(message: string): void {
    this.emptyEl.setText(message);
    this.emptyEl.style.display = '';
    this.imageEl.style.display = 'none';
    this.imageEl.removeAttribute('src');
  }
}

function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
