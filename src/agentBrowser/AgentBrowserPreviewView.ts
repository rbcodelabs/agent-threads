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

import { ItemView, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';

import type { AgentBrowserPool } from './AgentBrowserPool';
import type { AgentBrowserGuest } from './AgentBrowserGuest';
import { pngDataUrl } from './agentBrowserImage';

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

export class AgentBrowserPreviewView extends ItemView {
  private readonly getPool: () => AgentBrowserPool | null;
  private headerEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private imageEl!: HTMLImageElement;
  private emptyEl!: HTMLElement;
  private stopButtonEl!: HTMLButtonElement;
  private tick = 0;
  /** Guards against overlapping captures when one is slower than the interval. */
  private capturing = false;

  constructor(leaf: WorkspaceLeaf, getPool: () => AgentBrowserPool | null) {
    super(leaf);
    this.getPool = getPool;
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

    const body = root.createDiv({ cls: 'ct-browser-preview-body' });
    this.imageEl = body.createEl('img', { cls: 'ct-browser-preview-frame' });
    this.imageEl.alt = 'Current agent browser page';
    this.emptyEl = body.createDiv({ cls: 'ct-browser-preview-empty' });

    // registerInterval ties the timer to the view's lifetime, so closing the
    // leaf stops the capture loop without any explicit teardown here.
    this.registerInterval(window.setInterval(() => void this.refresh(), 1000));
    this.render();
  }

  async onClose(): Promise<void> {
    // Nothing to reclaim: the guest is owned by the pool, not by this view.
    // Closing the pane must never close the agent's browser.
  }

  private stopActiveSession(): void {
    const pool = this.getPool();
    const guest = pool?.mostRecentlyUsed();
    if (!pool || !guest) return;
    pool.destroyForThread(guest.threadId, 'tool');
    this.render();
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
      return;
    }

    const status = pool.status();
    this.summaryEl.setText(`Browser ${status.inUse}/${status.max}`);
    this.stopButtonEl.toggleClass('is-hidden', guest === null);

    if (!guest) {
      this.detailEl.setText(status.fdBlocked ? 'Paused — low on file handles' : 'No session running');
      this.showEmpty('Nothing is being browsed right now.');
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
