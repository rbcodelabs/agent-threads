// @vitest-environment jsdom
/**
 * The login-handoff guest role (ADR-0014 §3): `AgentBrowserPool` gains a
 * second, parallel per-thread map so a "take control" session can exist
 * alongside the primary guest without becoming a second, uncounted creation
 * path — the exact leak class the pool's own header comment says `admit()`
 * exists to prevent. These tests are about the two invariants that matter:
 * the login role counts against the same cap/reaper as the primary role, and
 * the MCP-facing surface (`peek()`/`acquire()`) never sees it.
 *
 * Also covers `AgentBrowserGuest.sendInputEvent()`/`focus()`, the low-latency,
 * best-effort path the login-handoff UI forwards synthetic input through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ABSOLUTE_MAX_GUESTS, IDLE_REAP_MS, MIN_CREATE_INTERVAL_MS, REAPER_TICK_MS } from '../../src/agentBrowser/agentBrowserPolicy';
import { AgentBrowserGuest } from '../../src/agentBrowser/AgentBrowserGuest';
import { AgentBrowserPool, AGENT_BROWSER_PARTITION } from '../../src/agentBrowser/AgentBrowserPool';

// ── Fake guest element (mirrors agent-browser-pool.test.ts, plus sendInputEvent/focus) ──

interface FakeWebviewControls {
  neverReady?: boolean;
}

let fakeOptions: FakeWebviewControls = {};
let originalCreateElement: typeof document.createElement;

function installFakeWebview(): void {
  originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, opts?: unknown) => {
    const el = originalCreateElement(tagName as 'div', opts as ElementCreationOptions);
    if (tagName !== 'webview') return el;

    let url = 'about:blank';
    let contentsAlive = true;
    Object.assign(el, {
      loadURL: vi.fn(async (next: string) => {
        url = next;
      }),
      getURL: () => url,
      getTitle: () => 'Fake page',
      stop: vi.fn(),
      executeJavaScript: vi.fn(async () => 'ok'),
      capturePage: vi.fn(async () => ({
        toPNG: () => new Uint8Array([1, 2, 3]),
        resize: () => ({ toPNG: () => new Uint8Array([1, 2]), resize: () => null, getSize: () => ({ width: 1, height: 1 }) }),
        getSize: () => ({ width: 1280, height: 800 }),
      })),
      insertCSS: vi.fn(async () => 'x'),
      getWebContentsId: () => {
        if (!contentsAlive) throw new Error('WebContents is gone');
        return 42;
      },
      sendInputEvent: vi.fn(),
      focus: vi.fn(),
      __killContents: () => {
        contentsAlive = false;
      },
    });

    if (!fakeOptions.neverReady) {
      queueMicrotask(() => el.dispatchEvent(new Event('dom-ready')));
    }
    return el;
  }) as typeof document.createElement);
}

function liveWebviewCount(): number {
  return document.querySelectorAll('webview').length;
}

beforeEach(() => {
  fakeOptions = {};
  document.body.innerHTML = '';
  installFakeWebview();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function movingClock(stepMs = MIN_CREATE_INTERVAL_MS * 2) {
  let value = 1_000_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
    step: () => {
      value += stepMs;
    },
  };
}

function makePool(overrides: Partial<{ maxGuests: number; now: () => number }> = {}) {
  const hostWindow = { geode: { getFdPressure: async () => ({ openFileDescriptors: 10, limit: 1000, ratio: 0.01, underPressure: false, exhausted: false }) } };
  return new AgentBrowserPool({
    doc: document,
    hostWindow,
    getMaxGuests: () => overrides.maxGuests ?? ABSOLUTE_MAX_GUESTS,
    getUrlPolicy: () => ({}),
    now: overrides.now,
  });
}

// ── AgentBrowserGuest.sendInputEvent / focus ────────────────────────────────

describe('AgentBrowserGuest — synthetic input (ADR-0014 §2)', () => {
  async function makeGuest() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const guest = new AgentBrowserGuest({
      threadId: 't1',
      container,
      doc: document,
      partition: AGENT_BROWSER_PARTITION,
      urlPolicy: {},
      onDied: vi.fn(),
    });
    await guest.start();
    return guest;
  }

  it('forwards a mouse input event straight to the element, bypassing the operation queue', async () => {
    const guest = await makeGuest();
    const el = guest.element as unknown as { sendInputEvent: ReturnType<typeof vi.fn>; executeJavaScript: ReturnType<typeof vi.fn> };
    // Saturate the queue with a hung script — sendInputEvent must not queue
    // behind it, since MCP tool calls and human input never compete for the
    // same guest (a login guest has no MCP surface at all).
    el.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    void guest.runScript('hang');

    guest.sendInputEvent({ type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 });

    expect(el.sendInputEvent).toHaveBeenCalledWith({ type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 });
  });

  it('forwards a keyboard input event the same way', async () => {
    const guest = await makeGuest();
    const el = guest.element as unknown as { sendInputEvent: ReturnType<typeof vi.fn> };

    guest.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: [] });

    expect(el.sendInputEvent).toHaveBeenCalledWith({ type: 'keyDown', keyCode: 'a', modifiers: [] });
  });

  it('is a silent no-op against a dead guest rather than throwing', async () => {
    const guest = await makeGuest();
    guest.destroy('tool');
    expect(() => guest.sendInputEvent({ type: 'mouseDown', x: 0, y: 0, button: 'left', clickCount: 1 })).not.toThrow();
  });

  it('focus() calls through to the element, and is a silent no-op when dead', async () => {
    const guest = await makeGuest();
    const el = guest.element as unknown as { focus: ReturnType<typeof vi.fn> };
    guest.focus();
    expect(el.focus).toHaveBeenCalledTimes(1);

    guest.destroy('tool');
    expect(() => guest.focus()).not.toThrow();
  });
});

// ── AgentBrowserPool — dual-map admission ───────────────────────────────────

describe('AgentBrowserPool — login-guest role (ADR-0014 §3)', () => {
  it('creates a login guest and navigates it to the requested URL', async () => {
    const clock = movingClock();
    const pool = makePool({ now: clock.now });

    const guest = await pool.acquireLoginGuest('thread-a', 'https://accounts.example.com/login');

    expect(guest.element!.getURL()).toBe('https://accounts.example.com/login');
    expect(liveWebviewCount()).toBe(1);
    pool.destroy();
  });

  it('a login guest counts against the same shared cap as a primary guest', async () => {
    const clock = movingClock();
    const pool = makePool({ maxGuests: 1, now: clock.now });

    await pool.acquire('primary-thread');
    clock.step();

    await expect(pool.acquireLoginGuest('login-thread', 'https://example.com')).rejects.toMatchObject({
      code: 'admission_denied_cap',
    });
    pool.destroy();
  });

  it('a primary guest is refused once a login guest already fills the cap', async () => {
    const clock = movingClock();
    const pool = makePool({ maxGuests: 1, now: clock.now });

    await pool.acquireLoginGuest('login-thread', 'https://example.com');
    clock.step();

    await expect(pool.acquire('primary-thread')).rejects.toMatchObject({ code: 'admission_denied_cap' });
    pool.destroy();
  });

  it('peek() and acquire() never see or return a login guest', async () => {
    const clock = movingClock();
    const pool = makePool({ now: clock.now });

    await pool.acquireLoginGuest('thread-a', 'https://example.com');

    expect(pool.peek('thread-a')).toBeNull();
    clock.step();
    const primary = await pool.acquire('thread-a');
    // acquire() must build its own, independent primary guest — not somehow
    // hand back the login one.
    expect(pool.peekLoginGuest('thread-a')).not.toBe(primary);
    expect(liveWebviewCount()).toBe(2);
    pool.destroy();
  });

  it('peekLoginGuest() returns the live login guest, or null once released', async () => {
    const clock = movingClock();
    const pool = makePool({ now: clock.now });

    await pool.acquireLoginGuest('thread-a', 'https://example.com');
    expect(pool.peekLoginGuest('thread-a')).not.toBeNull();

    pool.releaseLoginGuest('thread-a');
    expect(pool.peekLoginGuest('thread-a')).toBeNull();
    expect(liveWebviewCount()).toBe(0);
    pool.destroy();
  });

  it('releaseLoginGuest() is safe to call when no login guest exists', () => {
    const pool = makePool();
    expect(() => pool.releaseLoginGuest('nobody')).not.toThrow();
    pool.destroy();
  });

  it('reusing acquireLoginGuest for the same thread re-navigates rather than creating a second guest', async () => {
    const clock = movingClock();
    const pool = makePool({ now: clock.now });

    const first = await pool.acquireLoginGuest('thread-a', 'https://one.example.com');
    const second = await pool.acquireLoginGuest('thread-a', 'https://two.example.com');

    expect(second).toBe(first);
    expect(liveWebviewCount()).toBe(1);
    expect(second.element!.getURL()).toBe('https://two.example.com/');
    pool.destroy();
  });

  it('destroyAll() clears both the primary and login maps', async () => {
    const clock = movingClock();
    const pool = makePool({ now: clock.now });

    await pool.acquire('primary-thread');
    clock.step();
    await pool.acquireLoginGuest('login-thread', 'https://example.com');
    expect(liveWebviewCount()).toBe(2);

    pool.destroyAll('shutdown');

    expect(liveWebviewCount()).toBe(0);
    expect(pool.peek('primary-thread')).toBeNull();
    expect(pool.peekLoginGuest('login-thread')).toBeNull();
    pool.destroy();
  });

  it('destroy() leaves no webview behind for either role', async () => {
    const clock = movingClock();
    const pool = makePool({ now: clock.now });

    await pool.acquire('primary-thread');
    clock.step();
    await pool.acquireLoginGuest('login-thread', 'https://example.com');

    pool.destroy();

    expect(liveWebviewCount()).toBe(0);
  });

  it('the reaper idle-sweeps a login guest exactly like a primary one', async () => {
    vi.useFakeTimers();
    const clock = movingClock();
    const pool = makePool({ now: clock.now });
    pool.start();

    await pool.acquireLoginGuest('idle-login', 'https://example.com');
    expect(liveWebviewCount()).toBe(1);

    clock.advance(IDLE_REAP_MS + 1_000);
    await vi.advanceTimersByTimeAsync(REAPER_TICK_MS + 10);

    expect(liveWebviewCount()).toBe(0);
    expect(pool.peekLoginGuest('idle-login')).toBeNull();
    pool.destroy();
  });

  it('findPrimaryByWebContentsId resolves a primary guest’s thread, and never a login guest’s', async () => {
    const clock = movingClock();
    const pool = makePool({ now: clock.now });

    await pool.acquire('primary-thread');
    clock.step();
    await pool.acquireLoginGuest('login-thread', 'https://example.com');

    // The fake webview always reports webContentsId 42, so this also proves
    // the lookup only ever walks `guests`, not `loginGuests` — otherwise it
    // would be ambiguous which of the two threads it resolves to.
    expect(pool.findPrimaryByWebContentsId(42)).toBe('primary-thread');
    expect(pool.findPrimaryByWebContentsId(999)).toBeNull();
    pool.destroy();
  });

  it('findLoginByWebContentsId resolves a login guest’s thread, and never a primary guest’s', async () => {
    const clock = movingClock();
    const pool = makePool({ now: clock.now });

    await pool.acquireLoginGuest('login-thread', 'https://example.com');

    expect(pool.findLoginByWebContentsId(42)).toBe('login-thread');
    pool.destroy();
  });

  it('a login guest that fails URL policy is not left registered', async () => {
    const clock = movingClock();
    const pool = makePool({ now: clock.now });

    await expect(pool.acquireLoginGuest('thread-a', 'file:///etc/passwd')).rejects.toMatchObject({
      code: 'navigation_blocked',
    });

    expect(pool.peekLoginGuest('thread-a')).toBeNull();
    expect(liveWebviewCount()).toBe(0);
    pool.destroy();
  });
});
