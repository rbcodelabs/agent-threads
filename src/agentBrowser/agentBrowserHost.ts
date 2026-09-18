/**
 * The container that holds every agent `<webview>`.
 *
 * Why this exists at all: Geode's tab groups swap panes by clearing the host
 * element (`contentHostEl.innerHTML = ""` in `src/renderer/workspace.ts`, and
 * eight more sites like it). A `<webview>` inside any workspace leaf is
 * therefore disconnected from the document — and destroyed — the moment the user
 * clicks a different tab. An agent driving a page in a normal tab would lose its
 * browser mid-task simply because someone looked at their notes.
 *
 * So the guests live here instead: one container appended directly to
 * `document.body`, outside `#app`, which nothing in the host clears.
 *
 * "Hidden" deliberately does not mean `display:none`. Chromium does not paint
 * `display:none`, zero-size, or `visibility:hidden` subtrees, so a genuinely
 * hidden guest returns blank screenshots, and an occluded one is
 * background-throttled until its timers stall. The container is instead a real
 * 1280x800 box parked off-screen, which keeps the guest painting and its clocks
 * running.
 */

import { GUEST_HEIGHT, GUEST_WIDTH } from './agentBrowserPolicy';

export const AGENT_BROWSER_HOST_ID = 'claude-threads-agent-browser-host';

/**
 * Off-screen rather than hidden — see the module comment. `pointer-events:none`
 * and a negative z-index keep it inert even in the unlikely event that a layout
 * change brings it back on-screen.
 */
const HOST_STYLE = [
  'position:fixed',
  'left:-20000px',
  'top:0',
  `width:${GUEST_WIDTH}px`,
  `height:${GUEST_HEIGHT}px`,
  'overflow:hidden',
  'pointer-events:none',
  'opacity:0',
  'z-index:-1',
].join(';');

export interface AgentBrowserHostOptions {
  /**
   * Called when the container is removed from the document by something other
   * than `destroy()`. Every guest inside it is already dead at that point — its
   * WebContents went with the detach — so the owner must drop its registry
   * rather than keep handing out references to corpses.
   */
  onDetached: () => void;
}

export class AgentBrowserHost {
  private readonly doc: Document;
  private readonly onDetached: () => void;
  private el: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private destroyed = false;

  constructor(doc: Document, options: AgentBrowserHostOptions) {
    this.doc = doc;
    this.onDetached = options.onDetached;
  }

  /**
   * Return the container, creating it if necessary.
   *
   * Also adopts a container left behind by a previous plugin load: an id lookup
   * first means a reload cannot orphan an element that still holds live guests.
   */
  ensure(): HTMLElement {
    if (this.destroyed) throw new Error('Agent browser host has been destroyed.');
    if (this.el && this.el.isConnected) return this.el;

    const existing = this.doc.getElementById(AGENT_BROWSER_HOST_ID);
    if (existing) {
      // Anything inside is from a previous load and has no owner now.
      existing.replaceChildren();
      this.el = existing;
    } else {
      const el = this.doc.createElement('div');
      el.id = AGENT_BROWSER_HOST_ID;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = HOST_STYLE;
      this.doc.body.appendChild(el);
      this.el = el;
    }

    this.watch();
    return this.el;
  }

  /** The container if it currently exists and is attached, else null. */
  get element(): HTMLElement | null {
    return this.el && this.el.isConnected ? this.el : null;
  }

  /**
   * True when the container is present and still a child of the document body.
   * Checked before every guest operation: an element that was detached and
   * re-attached hosts a different WebContents, so "still there" is not the same
   * question as "still ours".
   */
  isHealthy(): boolean {
    return !this.destroyed && this.el !== null && this.el.isConnected && this.doc.body.contains(this.el);
  }

  /**
   * Watch `document.body` for the container disappearing.
   *
   * Nothing in Geode clears `document.body` today, but that is an incidental
   * property of the host rather than a guarantee it makes to plugins. If it ever
   * changes, the alternative to detecting it is silently handing the agent a
   * browser that no longer exists.
   */
  private watch(): void {
    if (this.observer || !this.el) return;
    const MutationObserverCtor = (this.doc.defaultView as (Window & typeof globalThis) | null)?.MutationObserver;
    if (!MutationObserverCtor) return; // jsdom without the API, or a headless bundle

    this.observer = new MutationObserverCtor(() => {
      if (this.destroyed) return;
      if (this.el && !this.el.isConnected) {
        this.el = null;
        this.onDetached();
      }
    });
    this.observer.observe(this.doc.body, { childList: true });
  }

  /**
   * Remove the container and everything in it.
   *
   * Synchronous and idempotent by contract: `el.remove()` destroys each guest's
   * WebContents immediately, and this runs from plugin teardown paths that are
   * not awaited. Detaching the observer first stops `onDetached` firing for our
   * own removal.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}
