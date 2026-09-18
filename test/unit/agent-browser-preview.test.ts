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

function makePool(guest: AgentBrowserGuest | null, status: Partial<PoolStatus> = {}) {
  const destroyForThread = vi.fn();
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
  } as unknown as AgentBrowserPool;
  return { pool, destroyForThread };
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
