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
import type { AgentBrowserGuest } from './AgentBrowserGuest';
import { pngDataUrl } from './agentBrowserImage';
import { HANDOFF_PREVIEW_WIDTH, LoginHandoffController, type LoginHandoffSnapshot } from './LoginHandoffController';

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
const PREVIEW_WIDTH = HANDOFF_PREVIEW_WIDTH;

export class AgentBrowserPreviewView extends ItemView {
  private readonly getPool: () => AgentBrowserPool | null;
  private headerEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private imageEl!: HTMLImageElement;
  private emptyEl!: HTMLElement;
  private takeOverButtonEl!: HTMLButtonElement;
  private stopButtonEl!: HTMLButtonElement;
  private bannerEl!: HTMLElement;
  private bannerTextEl!: HTMLElement;
  private takeControlButtonEl!: HTMLButtonElement;
  private returnControlButtonEl!: HTMLButtonElement;
  private tick = 0;
  /** Guards against overlapping captures when one is slower than the interval. */
  private capturing = false;
  private lastMoveAt = 0;

  /**
   * The login-handoff controller (ADR-0014). Normally the plugin-wide shared
   * one, so the chat's session card and this pane show the same state; when
   * none is supplied (tests, a bare view) the view owns a private one.
   */
  private controller: LoginHandoffController | null = null;
  private ownsController = false;
  private readonly getSharedController: () => LoginHandoffController | null;
  private readonly cleanups: Array<() => void> = [];
  private readonly now: () => number;

  constructor(
    leaf: WorkspaceLeaf,
    getPool: () => AgentBrowserPool | null,
    getSharedController: () => LoginHandoffController | null = () => null,
    now: () => number = Date.now,
  ) {
    super(leaf);
    this.getPool = getPool;
    this.getSharedController = getSharedController;
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

    this.takeOverButtonEl = this.headerEl.createEl('button', { cls: 'ct-browser-preview-takeover', text: 'Take over' });
    setTooltip(this.takeOverButtonEl, 'Drive this browser yourself (sign in, solve a captcha). The agent waits until you return control.');
    this.takeOverButtonEl.addEventListener('click', () => this.takeOver());

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
    this.takeControlButtonEl.addEventListener('click', () => this.takeControl());
    this.returnControlButtonEl = bannerActions.createEl('button', {
      cls: 'ct-browser-login-banner-action',
      text: 'Return control',
    });
    this.returnControlButtonEl.addEventListener('click', () => this.returnControl());
    this.bannerEl.style.display = 'none';

    const body = root.createDiv({ cls: 'ct-browser-preview-body' });
    this.imageEl = body.createEl('img', { cls: 'ct-browser-preview-frame' });
    this.imageEl.alt = 'Current agent browser page';
    // Focusable so keydown/keyup can be forwarded during a login handoff.
    this.imageEl.tabIndex = 0;
    // The frame is a live remote screen, not an image to drag or save: a drag
    // would swallow the pointerup and the click never reaches the page.
    this.imageEl.draggable = false;
    // Stop the <img> taking DOM focus on press; the guest is given focus instead.
    this.registerDomEvent(this.imageEl, 'mousedown', (event) => event.preventDefault());
    this.registerDomEvent(this.imageEl, 'dragstart', (event) => event.preventDefault());
    this.emptyEl = body.createDiv({ cls: 'ct-browser-preview-empty' });

    // Pages (Apple ID widgets among them) drive hover/focus state off mouse
    // moves, so a bare press with no preceding move is often ignored and takes
    // several tries. Send moves (throttled) and one right before every press.
    this.registerDomEvent(this.imageEl, 'pointermove', (event) => {
      const at = this.now();
      if (at - this.lastMoveAt < 40) return;
      this.lastMoveAt = at;
      this.forwardMouseEvent('mouseMove', event);
    });
    this.registerDomEvent(this.imageEl, 'pointerdown', (event) => {
      this.forwardMouseEvent('mouseMove', event);
      this.forwardMouseEvent('mouseDown', event);
    });
    this.registerDomEvent(this.imageEl, 'pointerup', (event) => this.forwardMouseEvent('mouseUp', event));
    this.registerDomEvent(this.imageEl, 'keydown', (event) => this.forwardKeyboardEvent(event));
    this.registerDomEvent(this.imageEl, 'keyup', (event) => this.forwardKeyboardEvent(event));

    // registerInterval ties the timer to the view's lifetime, so closing the
    // leaf stops the capture loop without any explicit teardown here.
    this.registerInterval(window.setInterval(() => void this.refresh(), 1000));
    this.attachController();
    this.render();
  }

  async onClose(): Promise<void> {
    // Nothing to reclaim about the guests: they are owned by the pool, not by
    // this view. Closing the pane must never close the agent's browser — and
    // that includes a login guest mid-handoff, which is left for the pool's
    // own idle/TTL reaper rather than torn down here (ADR-0014's Risks: an
    // abandoned handoff is reclaimed on the same schedule as anything else).
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    // Only a controller this view created is torn down with it; the shared
    // one belongs to the plugin and outlives the pane.
    if (this.ownsController) this.controller?.stop();
    this.controller = null;
    this.ownsController = false;
  }

  private stopActiveSession(): void {
    const pool = this.getPool();
    const guest = pool?.mostRecentlyUsed();
    if (!pool || !guest) return;
    pool.destroyForThread(guest.threadId, 'tool');
    this.render();
  }

  // ── Login handoff (ADR-0014) ────────────────────────────────────────────────
  // State, the capture loop and input forwarding live in LoginHandoffController;
  // this view is one of its subscribers.

  private attachController(): void {
    let controller = this.getSharedController();
    if (!controller) {
      controller = new LoginHandoffController({
        getPool: this.getPool,
        now: this.now,
        notify: (message) => { new Notice(message); },
      });
      controller.start();
      this.ownsController = true;
    }
    this.controller = controller;
    this.cleanups.push(
      controller.subscribe(() => this.render()),
      controller.subscribeFrames((threadId, dataUrl) => this.showHandoffFrame(threadId, dataUrl)),
      controller.subscribeFocus(() => this.app.workspace.revealLeaf(this.leaf)),
      // Frames are only captured while this (or another) surface is looking.
      controller.attachViewer(() => this.isVisible()),
    );
    // A handoff already in progress when the pane opens: paint what we have.
    const active = controller.getActiveSnapshot();
    if (active) this.showHandoffFrame(active.threadId, controller.getFrame(active.threadId));
  }

  private showHandoffFrame(threadId: string, dataUrl: string | null): void {
    if (!dataUrl || this.controller?.getActiveSnapshot()?.threadId !== threadId) return;
    this.imageEl.src = dataUrl;
    this.imageEl.style.display = '';
  }

  private takeControl(): void {
    const snapshot = this.bannerSnapshot(this.getPool()?.mostRecentlyUsed() ?? null);
    if (!snapshot || snapshot.phase !== 'requested') return;
    void this.controller?.takeControl(snapshot.threadId);
  }

  private takeOver(): void {
    const guest = this.getPool()?.mostRecentlyUsed() ?? null;
    if (!guest) return;
    const result = this.controller?.takeOver(guest.threadId);
    if (result && !result.ok && result.message) new Notice(result.message);
  }

  private returnControl(): void {
    const active = this.controller?.getActiveSnapshot();
    if (active) this.controller?.returnControl(active.threadId, 'login-complete');
  }

  private forwardMouseEvent(type: 'mouseDown' | 'mouseUp' | 'mouseMove', event: { clientX: number; clientY: number }): void {
    const active = this.controller?.getActiveSnapshot();
    if (!active) return;
    this.controller?.forwardPointer(active.threadId, type, event.clientX, event.clientY, this.imageEl.getBoundingClientRect());
  }

  private forwardKeyboardEvent(event: KeyboardEvent): void {
    const active = this.controller?.getActiveSnapshot();
    if (!active) return;
    const forwarded = this.controller?.forwardKey(active.threadId, {
      key: event.key,
      type: event.type as 'keydown' | 'keyup',
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    });
    if (forwarded) event.preventDefault();
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

    if (this.controller?.getActiveSnapshot()) {
      // Frame capture during a handoff is owned by the controller's faster
      // dedicated loop; this tick still drives the countdown text and keeps
      // the header/detail rows current.
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

    if (this.controller?.getActiveSnapshot()) {
      // The opener guest is never touched during a handoff, so the stop
      // control (which only ever targets the primary guest) stays hidden —
      // "Return control" in the banner is the only exit while one is active.
      this.stopButtonEl.toggleClass('is-hidden', true);
      this.takeOverButtonEl.toggleClass('is-hidden', true);
      this.detailEl.setText('Signing in — you have control of this page.');
      this.emptyEl.style.display = 'none';
      this.renderBanner(guest);
      return;
    }

    this.stopButtonEl.toggleClass('is-hidden', guest === null);
    this.takeOverButtonEl.toggleClass('is-hidden', guest === null || !this.controller);

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
  /**
   * The snapshot the banner should show: the active handoff, or a request /
   * expiry scoped to the thread currently displayed (ADR-0014 §4 — a pending
   * request for a different thread does not surface here).
   */
  private bannerSnapshot(guest: AgentBrowserGuest | null): LoginHandoffSnapshot | null {
    const controller = this.controller;
    if (!controller) return null;
    const active = controller.getActiveSnapshot();
    if (active) return active;
    if (!guest) return null;
    const snapshot = controller.getSnapshot(guest.threadId);
    return snapshot && (snapshot.phase === 'requested' || snapshot.phase === 'expired') ? snapshot : null;
  }

  private renderBanner(guest: AgentBrowserGuest | null): void {
    const snapshot = this.bannerSnapshot(guest);

    if (snapshot?.phase === 'active') {
      this.bannerEl.style.display = '';
      this.bannerEl.toggleClass('is-handoff-active', true);
      this.bannerTextEl.setText(
        snapshot.mode === 'takeover'
          ? 'You are driving the agent\'s browser — the agent is paused until you return control.'
          : 'You are signing in on a temporary browser page.',
      );
      this.takeControlButtonEl.style.display = 'none';
      this.returnControlButtonEl.style.display = '';
      return;
    }

    this.bannerEl.toggleClass('is-handoff-active', false);
    this.returnControlButtonEl.style.display = 'none';

    if (!snapshot) {
      this.bannerEl.style.display = 'none';
      return;
    }

    this.bannerEl.style.display = '';
    const expired = snapshot.phase === 'expired';
    this.takeControlButtonEl.style.display = expired ? 'none' : '';

    if (expired) {
      this.bannerTextEl.setText(
        `The sign-in request for ${snapshot.host} expired. Click sign-in on the page again to retry.`,
      );
      return;
    }

    const remainingSeconds = Math.max(0, Math.ceil(((snapshot.expiresAt ?? 0) - this.now()) / 1000));
    this.bannerTextEl.setText(
      `This page wants you to sign in (${snapshot.host}) — ${remainingSeconds}s to take control.`,
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
