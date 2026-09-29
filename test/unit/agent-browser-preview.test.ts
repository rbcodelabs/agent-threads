// @vitest-environment jsdom
/**
 * The preview pane's job is to make a running browser session visible and
 * stoppable. Its most load-bearing behaviours are the negative ones: it must not
 * capture frames nobody is looking at, and it must never take ownership of the
 * guest.
 */

import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentBrowserPreviewView } from '../../src/agentBrowser/AgentBrowserPreviewView';
import type { AgentBrowserPool, PoolStatus } from '../../src/agentBrowser/AgentBrowserPool';
import type { AgentBrowserGuest, GuestFacts, GuestState } from '../../src/agentBrowser/AgentBrowserGuest';

function makeGuest(overrides: Partial<GuestFacts> & { state?: GuestState } = {}) {
  const facts: GuestFacts = {
    threadId: 'thread-1',
    state: overrides.state ?? 'ready',
    url: 'https://example.com/docs',
    ageMs: 90_000,
    idleMs: 1_000,
    navCount: 3,
    scriptCount: 5,
    captureCount: 1,
    ...overrides,
  };
  const capture = vi.fn().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  return {
    guest: {
      threadId: facts.threadId,
      currentState: facts.state,
      idleMs: facts.idleMs,
      facts: () => facts,
      capture,
      isAlive: () => true,
    } as unknown as AgentBrowserGuest,
    capture,
  };
}

function makePool(
  guest: AgentBrowserGuest | null,
  status: Partial<PoolStatus> = {},
  overrides: Partial<{
    findPrimaryByWebContentsId: (id: number) => string | null;
    findLoginByWebContentsId: (id: number) => string | null;
    acquireLoginGuest: (threadId: string, url: string) => Promise<AgentBrowserGuest>;
    releaseLoginGuest: (threadId: string, reason?: string) => void;
  }> = {},
) {
  const destroyForThread = vi.fn();
  const releaseLoginGuest = vi.fn(overrides.releaseLoginGuest ?? (() => {}));
  const pool = {
    status: (): PoolStatus => ({
      inUse: guest ? 1 : 0,
      max: 2,
      fdBlocked: false,
      fdAvailable: true,
      guests: [],
      ...status,
    }),
    mostRecentlyUsed: () => guest,
    destroyForThread,
    findPrimaryByWebContentsId: overrides.findPrimaryByWebContentsId ?? (() => null),
    findLoginByWebContentsId: overrides.findLoginByWebContentsId ?? (() => null),
    acquireLoginGuest: overrides.acquireLoginGuest ?? vi.fn(),
    releaseLoginGuest,
  } as unknown as AgentBrowserPool;
  return { pool, destroyForThread, releaseLoginGuest };
}

function makeLeaf() {
  return {} as never;
}

/** Drive one interval tick without waiting a real second. */
async function tick(view: AgentBrowserPreviewView, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await (view as unknown as { refresh(): Promise<void> }).refresh();
  }
}

let visible = true;

beforeEach(() => {
  visible = true;
  // The view asks Obsidian whether its leaf is on screen; jsdom has no such
  // concept, so stand the method up and control it per test.
  (HTMLElement.prototype as HTMLElement & { isShown?: () => boolean }).isShown = () => visible;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as HTMLElement & { isShown?: () => boolean }).isShown;
});

describe('AgentBrowserPreviewView', () => {
  it('shows the running count so an active session is never invisible', async () => {
    // The original failure mode was leaked browsers nobody knew about.
    const { guest } = makeGuest();
    const { pool } = makePool(guest);
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    expect(view.containerEl.textContent).toContain('Browser 1/2');
    expect(view.containerEl.textContent).toContain('example.com');
    expect(view.containerEl.textContent).toContain('3 pages');
  });

  it('reports an idle pool and hides the stop control', async () => {
    const { pool } = makePool(null);
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    expect(view.containerEl.textContent).toContain('No session running');
    expect(view.containerEl.querySelector('.ct-browser-preview-stop')?.classList.contains('is-hidden')).toBe(true);
  });

  it('explains itself when the feature is switched off', async () => {
    const view = new AgentBrowserPreviewView(makeLeaf(), () => null);
    await view.onOpen();
    expect(view.containerEl.textContent).toContain('Agent browser is off');
  });

  it('surfaces a file-handle pause rather than looking merely idle', async () => {
    const { pool } = makePool(null, { fdBlocked: true, inUse: 0 });
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();
    expect(view.containerEl.textContent).toContain('low on file handles');
  });

  it('captures a frame while the pane is visible', async () => {
    const { guest, capture } = makeGuest({ state: 'busy' });
    const { pool } = makePool(guest);
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    await tick(view);

    expect(capture).toHaveBeenCalled();
    const img = view.containerEl.querySelector('img') as HTMLImageElement;
    expect(img.src.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('captures nothing while the pane is hidden', async () => {
    // Screenshots are budgeted per guest, and exhausting that budget recycles
    // it — so a background pane could otherwise shorten a working session.
    const { guest, capture } = makeGuest({ state: 'busy' });
    const { pool } = makePool(guest);
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    visible = false;
    await tick(view, 10);

    expect(capture).not.toHaveBeenCalled();
  });

  it('captures less often when the session is idle', async () => {
    const { guest: busy, capture: busyCapture } = makeGuest({ state: 'busy' });
    const busyView = new AgentBrowserPreviewView(makeLeaf(), () => makePool(busy).pool);
    await busyView.onOpen();
    await tick(busyView, 5);

    const { guest: idle, capture: idleCapture } = makeGuest({ state: 'ready' });
    const idleView = new AgentBrowserPreviewView(makeLeaf(), () => makePool(idle).pool);
    await idleView.onOpen();
    await tick(idleView, 5);

    expect(busyCapture.mock.calls.length).toBeGreaterThan(idleCapture.mock.calls.length);
  });

  it('stops the session on demand', async () => {
    const { guest } = makeGuest();
    const { pool, destroyForThread } = makePool(guest);
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    (view.containerEl.querySelector('.ct-browser-preview-stop') as HTMLButtonElement).click();

    expect(destroyForThread).toHaveBeenCalledWith('thread-1', 'tool');
  });

  it('never closes the session just because the pane closed', async () => {
    // The pool owns the guest; this view is a window onto it, not its owner.
    const { guest } = makeGuest();
    const { pool, destroyForThread } = makePool(guest);
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    await view.onClose();

    expect(destroyForThread).not.toHaveBeenCalled();
  });

  it('survives a capture that fails because the guest died mid-frame', async () => {
    const { guest, capture } = makeGuest({ state: 'busy' });
    capture.mockRejectedValue(new Error('guest is gone'));
    const { pool } = makePool(guest);
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    await expect(tick(view)).resolves.toBeUndefined();
  });
});

// ── Login handoff (ADR-0014) ────────────────────────────────────────────────

function makeLoginGuest(threadId: string) {
  const facts = {
    threadId,
    state: 'ready' as GuestState,
    url: 'https://accounts.example.com/login',
    ageMs: 1_000,
    idleMs: 0,
    navCount: 1,
    scriptCount: 0,
    captureCount: 0,
    viewport: { width: 1280, height: 800 },
  };
  const capture = vi.fn().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  const sendInputEvent = vi.fn();
  const focus = vi.fn();
  return {
    guest: {
      threadId,
      currentState: facts.state,
      facts: () => facts,
      capture,
      isAlive: () => true,
      focus,
      sendInputEvent,
    } as unknown as AgentBrowserGuest,
    capture,
    sendInputEvent,
    focus,
  };
}

describe('AgentBrowserPreviewView — login handoff (ADR-0014)', () => {
  type OpenCallback = (request: { url: string; guestId: number; disposition: string }) => void;
  let openCallback: OpenCallback | null;

  beforeEach(() => {
    openCallback = null;
    // Stands in for Geode's `window.geode.onAgentBrowserWindowOpen` — the view
    // feature-detects this exactly like `fdGate`/`WakeLockService` do.
    (window as unknown as { geode?: unknown }).geode = {
      onAgentBrowserWindowOpen: (cb: OpenCallback) => {
        openCallback = cb;
        return () => {
          openCallback = null;
        };
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { geode?: unknown }).geode;
  });

  function fireOpen(request: { url: string; guestId: number; disposition?: string }): void {
    openCallback?.({ disposition: 'foreground-tab', ...request });
  }

  it('shows a "take control" banner for a pending request scoped to the displayed thread', async () => {
    const { guest } = makeGuest({ threadId: 'thread-1' });
    const { pool } = makePool(guest, {}, { findPrimaryByWebContentsId: () => 'thread-1' });
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    fireOpen({ url: 'https://accounts.example.com/login', guestId: 42 });

    expect(view.containerEl.textContent).toContain('sign in');
    expect(view.containerEl.textContent).toContain('accounts.example.com');
  });

  it('does not surface a request scoped to a thread other than the one displayed', async () => {
    const { guest } = makeGuest({ threadId: 'thread-1' });
    const { pool } = makePool(guest, {}, { findPrimaryByWebContentsId: () => 'some-other-thread' });
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    fireOpen({ url: 'https://accounts.example.com/login', guestId: 42 });

    expect(view.containerEl.textContent).not.toContain('sign in');
  });

  it('ignores an unrecognised guestId entirely', async () => {
    const { guest } = makeGuest({ threadId: 'thread-1' });
    const { pool } = makePool(guest, {}, { findPrimaryByWebContentsId: () => null });
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    expect(() => fireOpen({ url: 'https://evil.example.com', guestId: 999 })).not.toThrow();
    expect(view.containerEl.textContent).not.toContain('sign in');
  });

  it('"take control" acquires a login guest and switches capture to it', async () => {
    const { guest: primary } = makeGuest({ threadId: 'thread-1' });
    const { guest: loginGuest, capture, focus } = makeLoginGuest('thread-1');
    const acquireLoginGuest = vi.fn().mockResolvedValue(loginGuest);
    const { pool } = makePool(
      primary,
      {},
      { findPrimaryByWebContentsId: () => 'thread-1', acquireLoginGuest },
    );
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();
    fireOpen({ url: 'https://accounts.example.com/login', guestId: 42 });

    (view.containerEl.querySelector('.ct-browser-login-banner-action') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(acquireLoginGuest).toHaveBeenCalledWith('thread-1', 'https://accounts.example.com/login');
    expect(focus).toHaveBeenCalled();
    // The stop control targets only the primary guest and must be hidden —
    // "Return control" in the banner is the only exit during a handoff.
    expect(view.containerEl.querySelector('.ct-browser-preview-stop')?.classList.contains('is-hidden')).toBe(true);

    // Frame capture now belongs to the (here: view-owned) LoginHandoffController.
    await (view as unknown as { controller: { captureTick(): Promise<void> } }).controller.captureTick();
    expect(capture).toHaveBeenCalled();
    await view.onClose(); // stops the view-owned controller's capture loop
  });

  it('"return control" releases the login guest and reverts to the primary view', async () => {
    const { guest: primary } = makeGuest({ threadId: 'thread-1' });
    const { guest: loginGuest } = makeLoginGuest('thread-1');
    const acquireLoginGuest = vi.fn().mockResolvedValue(loginGuest);
    const { pool, releaseLoginGuest } = makePool(
      primary,
      {},
      { findPrimaryByWebContentsId: () => 'thread-1', acquireLoginGuest },
    );
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();
    fireOpen({ url: 'https://accounts.example.com/login', guestId: 42 });
    (view.containerEl.querySelector('.ct-browser-login-banner-action') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const returnButtons = view.containerEl.querySelectorAll('.ct-browser-login-banner-action');
    (returnButtons[returnButtons.length - 1] as HTMLButtonElement).click();

    expect(releaseLoginGuest).toHaveBeenCalledWith('thread-1', 'login-complete');
    expect(view.containerEl.querySelector('.ct-browser-preview-stop')?.classList.contains('is-hidden')).toBe(false);
  });

  it('an expired request explains itself instead of just disappearing', async () => {
    vi.useFakeTimers();
    const { guest } = makeGuest({ threadId: 'thread-1' });
    const { pool } = makePool(guest, {}, { findPrimaryByWebContentsId: () => 'thread-1' });
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();
    fireOpen({ url: 'https://accounts.example.com/login', guestId: 42 });

    await vi.advanceTimersByTimeAsync(30_001);

    expect(view.containerEl.textContent).toContain('expired');
    expect(view.containerEl.querySelector('.ct-browser-login-banner-action')).toHaveProperty('style.display', 'none');
    vi.useRealTimers();
  });

  // The test harness's `obsidian` mock (`test/__mocks__/obsidian.ts`) makes
  // `registerDomEvent` a no-op, so a real `dispatchEvent` on `imageEl` never
  // reaches the view's handler. The private forward methods are exercised
  // directly instead, the same way `tick()` above calls `refresh()` directly
  // rather than waiting on a real `setInterval`.
  type ForwardableView = {
    forwardMouseEvent(type: 'mouseDown' | 'mouseUp', event: { clientX: number; clientY: number }): void;
    forwardKeyboardEvent(event: KeyboardEvent): void;
  };

  it('forwards a pointer click on the frame to the login guest as guest-viewport coordinates', async () => {
    const { guest: primary } = makeGuest({ threadId: 'thread-1' });
    const { guest: loginGuest, sendInputEvent } = makeLoginGuest('thread-1');
    const acquireLoginGuest = vi.fn().mockResolvedValue(loginGuest);
    const { pool } = makePool(primary, {}, { findPrimaryByWebContentsId: () => 'thread-1', acquireLoginGuest });
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();
    fireOpen({ url: 'https://accounts.example.com/login', guestId: 42 });
    (view.containerEl.querySelector('.ct-browser-login-banner-action') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const img = view.containerEl.querySelector('img') as HTMLImageElement;
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 640,
      height: 400,
      right: 640,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    (view as unknown as ForwardableView).forwardMouseEvent('mouseDown', { clientX: 320, clientY: 200 });

    expect(sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mouseDown', x: 640, y: 400, button: 'left' }),
    );
  });

  it('does not forward input once no handoff is active', async () => {
    const { guest } = makeGuest({ threadId: 'thread-1' });
    const { pool } = makePool(guest, {}, { findPrimaryByWebContentsId: () => 'thread-1' });
    const view = new AgentBrowserPreviewView(makeLeaf(), () => pool);
    await view.onOpen();

    expect(() =>
      (view as unknown as ForwardableView).forwardMouseEvent('mouseDown', { clientX: 10, clientY: 10 }),
    ).not.toThrow();
  });
});
