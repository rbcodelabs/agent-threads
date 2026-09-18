// @vitest-environment jsdom
/**
 * The agent browser exists to stop browser processes accumulating until the app
 * crashes, so these tests are mostly about refusal and reclamation rather than
 * capability. Anything that lets a guest outlive its thread, or lets one more
 * start when the machine is already out of headroom, is the original bug coming
 * back in a new shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ABSOLUTE_MAX_GUESTS,
  DEFAULT_MAX_GUESTS,
  FD_GREEN,
  FD_RED,
  HARD_TTL_MS,
  IDLE_REAP_MS,
  MIN_CREATE_INTERVAL_MS,
  OP_QUEUE_DEPTH,
  REAPER_TICK_MS,
  SCRIPT_TIMEOUT_MS,
  clampMaxGuests,
  evaluateUrl,
} from '../../src/agentBrowser/agentBrowserPolicy';
import { FdGate, type FdPressureSnapshot } from '../../src/agentBrowser/fdGate';
import { AgentBrowserHost, AGENT_BROWSER_HOST_ID } from '../../src/agentBrowser/agentBrowserHost';
import { AgentBrowserGuest } from '../../src/agentBrowser/AgentBrowserGuest';
import { AgentBrowserPool, AGENT_BROWSER_PARTITION } from '../../src/agentBrowser/AgentBrowserPool';
import { AgentBrowserError } from '../../src/agentBrowser/agentBrowserErrors';

// ── Fake guest element ───────────────────────────────────────────────────────

interface FakeWebviewControls {
  /** Suppress the automatic dom-ready so a start timeout can be exercised. */
  neverReady?: boolean;
}

let fakeOptions: FakeWebviewControls = {};
let createdElements: HTMLElement[] = [];
let originalCreateElement: typeof document.createElement;

/**
 * jsdom has no `<webview>`, so stand one up: a real element (so DOM semantics
 * like isConnected and remove() behave normally) with the Electron methods the
 * guest calls bolted on.
 */
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
      __killContents: () => {
        contentsAlive = false;
      },
    });

    createdElements.push(el);
    if (!fakeOptions.neverReady) {
      // Fires after the guest has registered its listener (which happens
      // synchronously, before start() first awaits) but without needing timers.
      queueMicrotask(() => el.dispatchEvent(new Event('dom-ready')));
    }
    return el;
  }) as typeof document.createElement);
}

function liveWebviewCount(): number {
  return document.querySelectorAll('webview').length;
}

function makeSnapshot(ratio: number | null, overrides: Partial<FdPressureSnapshot> = {}): FdPressureSnapshot {
  return {
    openFileDescriptors: ratio === null ? null : Math.round(ratio * 1000),
    limit: 1000,
    ratio,
    underPressure: ratio !== null && ratio >= FD_RED,
    exhausted: false,
    ...overrides,
  };
}

beforeEach(() => {
  fakeOptions = {};
  createdElements = [];
  document.body.innerHTML = '';
  installFakeWebview();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

// ── Policy ───────────────────────────────────────────────────────────────────

describe('agentBrowserPolicy', () => {
  it('clamps the guest cap into the supported range', () => {
    expect(clampMaxGuests(0)).toBe(1);
    expect(clampMaxGuests(99)).toBe(ABSOLUTE_MAX_GUESTS);
    expect(clampMaxGuests(2)).toBe(2);
    expect(clampMaxGuests(2.7)).toBe(2);
  });

  it('falls back to the default rather than throwing on a corrupt setting', () => {
    // A bad value in data.json must never stop the plugin loading.
    expect(clampMaxGuests(undefined)).toBe(DEFAULT_MAX_GUESTS);
    expect(clampMaxGuests('three')).toBe(DEFAULT_MAX_GUESTS);
    expect(clampMaxGuests(Number.NaN)).toBe(DEFAULT_MAX_GUESTS);
  });

  it('allows ordinary web URLs', () => {
    expect(evaluateUrl('https://example.com/x').allowed).toBe(true);
    expect(evaluateUrl('http://example.com').allowed).toBe(true);
  });

  it('rejects non-web schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>x',
      'geode-artifact://a/index.html',
      'chrome://settings',
    ]) {
      const decision = evaluateUrl(url);
      expect(decision.allowed, url).toBe(false);
    }
  });

  it('allows loopback so local dev servers can be tested', () => {
    expect(evaluateUrl('http://localhost:3000').allowed).toBe(true);
    expect(evaluateUrl('http://127.0.0.1:8080/x').allowed).toBe(true);
  });

  it('always denies cloud metadata addresses, even with private access enabled', () => {
    // An agent reading an attacker-controlled page must never be talked into
    // fetching instance credentials, so this one has no escape hatch.
    const decision = evaluateUrl('http://169.254.169.254/latest/meta-data/', {
      allowPrivateNetwork: true,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('link-local');
  });

  it('gates private networks behind the opt-in', () => {
    expect(evaluateUrl('http://192.168.1.10/').allowed).toBe(false);
    expect(evaluateUrl('http://192.168.1.10/', { allowPrivateNetwork: true }).allowed).toBe(true);
    expect(evaluateUrl('http://10.0.0.5/').allowed).toBe(false);
    expect(evaluateUrl('http://printer.local/').allowed).toBe(false);
  });

  it('rejects junk input without throwing', () => {
    expect(evaluateUrl('').allowed).toBe(false);
    expect(evaluateUrl('not a url').allowed).toBe(false);
    expect(evaluateUrl('example.com').allowed).toBe(false); // not absolute
  });
});

// ── FD gate ──────────────────────────────────────────────────────────────────

describe('FdGate', () => {
  it('allows when pressure is low', async () => {
    const gate = new FdGate(async () => makeSnapshot(0.2));
    expect((await gate.evaluate()).kind).toBe('allow');
  });

  it('denies once pressure reaches the red threshold', async () => {
    const gate = new FdGate(async () => makeSnapshot(FD_RED));
    expect((await gate.evaluate()).kind).toBe('deny-pressure');
  });

  it('stays blocked between green and red instead of flapping', async () => {
    // The whole reason for two thresholds: a single one admits at 0.849, the new
    // guest pushes pressure over, it gets reaped, and the cycle repeats — burning
    // descriptors faster than the leak it is meant to prevent.
    let ratio = FD_RED;
    let clock = 0;
    const gate = new FdGate(async () => makeSnapshot(ratio), () => clock);

    expect((await gate.evaluate()).kind).toBe('deny-pressure');
    expect(gate.isBlocked).toBe(true);

    // Drop to between GREEN and RED — must remain blocked.
    ratio = (FD_RED + FD_GREEN) / 2;
    clock += 10_000;
    gate.invalidate();
    expect((await gate.evaluate()).kind).toBe('deny-pressure');
    expect(gate.isBlocked).toBe(true);

    // Only once it clears GREEN does it reopen.
    ratio = FD_GREEN - 0.05;
    clock += 10_000;
    gate.invalidate();
    expect((await gate.evaluate()).kind).toBe('allow');
    expect(gate.isBlocked).toBe(false);
  });

  it('reports exhaustion distinctly so callers can destroy everything', async () => {
    const gate = new FdGate(async () => makeSnapshot(1, { exhausted: true }));
    const verdict = await gate.evaluate();
    expect(verdict.kind).toBe('deny-exhausted');
  });

  it('caches readings briefly so admission does not spam the host', async () => {
    let calls = 0;
    let clock = 0;
    const gate = new FdGate(async () => {
      calls += 1;
      return makeSnapshot(0.1);
    }, () => clock);
    await gate.evaluate();
    await gate.evaluate();
    expect(calls).toBe(1);
    clock += 5_000;
    await gate.evaluate();
    expect(calls).toBe(2);
  });

  it('allows when the host exposes no probe, and reports itself unavailable', async () => {
    const gate = new FdGate(null);
    expect(gate.available).toBe(false);
    expect((await gate.evaluate()).kind).toBe('allow');
  });

  it('treats a throwing probe as no reading rather than as pressure', async () => {
    // The gate must never become the reason the feature stops working.
    const gate = new FdGate(async () => {
      throw new Error('ipc failed');
    });
    expect((await gate.evaluate()).kind).toBe('allow');
  });
});

// ── Host container ───────────────────────────────────────────────────────────

describe('AgentBrowserHost', () => {
  it('attaches directly to document.body, outside the workspace', () => {
    // Anything inside a workspace leaf is destroyed on tab switch.
    const host = new AgentBrowserHost(document, { onDetached: () => {} });
    const el = host.ensure();
    expect(el.parentElement).toBe(document.body);
    expect(el.closest('.workspace-leaf')).toBeNull();
  });

  it('is off-screen but never display:none, so the guest keeps painting', () => {
    // Chromium does not paint hidden subtrees; a display:none guest returns
    // blank screenshots and gets background-throttled into stalling.
    const host = new AgentBrowserHost(document, { onDetached: () => {} });
    const el = host.ensure();
    expect(el.style.display).not.toBe('none');
    expect(el.style.visibility).not.toBe('hidden');
    expect(el.style.position).toBe('fixed');
    expect(parseInt(el.style.left, 10)).toBeLessThan(-1000);
    expect(parseInt(el.style.width, 10)).toBeGreaterThan(0);
    expect(parseInt(el.style.height, 10)).toBeGreaterThan(0);
  });

  it('adopts and empties a container left by a previous load', () => {
    const stale = document.createElement('div');
    stale.id = AGENT_BROWSER_HOST_ID;
    stale.appendChild(document.createElement('span'));
    document.body.appendChild(stale);

    const host = new AgentBrowserHost(document, { onDetached: () => {} });
    const el = host.ensure();
    expect(el).toBe(stale);
    expect(el.childElementCount).toBe(0);
    expect(document.querySelectorAll(`#${AGENT_BROWSER_HOST_ID}`)).toHaveLength(1);
  });

  it('reports detachment when something else removes the container', async () => {
    const onDetached = vi.fn();
    const host = new AgentBrowserHost(document, { onDetached });
    const el = host.ensure();
    expect(host.isHealthy()).toBe(true);

    el.remove();
    await new Promise((resolve) => setTimeout(resolve, 0)); // MutationObserver is async
    expect(onDetached).toHaveBeenCalled();
    expect(host.isHealthy()).toBe(false);
  });

  it('does not report detachment for its own destroy, and is idempotent', async () => {
    const onDetached = vi.fn();
    const host = new AgentBrowserHost(document, { onDetached });
    host.ensure();
    host.destroy();
    host.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onDetached).not.toHaveBeenCalled();
    expect(document.getElementById(AGENT_BROWSER_HOST_ID)).toBeNull();
  });
});

// ── Guest ────────────────────────────────────────────────────────────────────

async function makeGuest(overrides: { onDied?: ReturnType<typeof vi.fn> } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onDied = overrides.onDied ?? vi.fn();
  const guest = new AgentBrowserGuest({
    threadId: 't1',
    container,
    doc: document,
    partition: AGENT_BROWSER_PARTITION,
    urlPolicy: {},
    onDied,
  });
  await guest.start();
  return { guest, container, onDied };
}

describe('AgentBrowserGuest', () => {
  it('hardens the element and never grants popups or a preload', async () => {
    const { guest } = await makeGuest();
    const el = guest.element!;
    const prefs = el.getAttribute('webpreferences') ?? '';

    expect(el.getAttribute('partition')).toBe(AGENT_BROWSER_PARTITION);
    expect(prefs).toContain('sandbox=yes');
    expect(prefs).toContain('contextIsolation=yes');
    expect(prefs).toContain('nodeIntegration=no');
    // Required, not cosmetic: an off-screen guest is throttled without it and
    // its timers stall, which is indistinguishable from a hung page.
    expect(prefs).toContain('backgroundThrottling=no');
    // A plugin-owned preload would be the one bridge from a hostile page to the host.
    expect(el.hasAttribute('preload')).toBe(false);
    expect(el.hasAttribute('allowpopups')).toBe(false);
    expect(el.hasAttribute('nodeintegration')).toBe(false);
  });

  it('is never parented inside a workspace leaf', async () => {
    // Invariant I1 — the tab-switch teardown is what kills guests.
    const leaf = document.createElement('div');
    leaf.className = 'workspace-leaf';
    document.body.appendChild(leaf);
    await makeGuest();
    expect(leaf.querySelector('webview')).toBeNull();
  });

  it('rejects a blocked URL before the page is ever contacted', async () => {
    const { guest } = await makeGuest();
    const el = guest.element!;
    await expect(guest.navigate('file:///etc/passwd')).rejects.toMatchObject({
      code: 'navigation_blocked',
    });
    expect((el as unknown as { loadURL: ReturnType<typeof vi.fn> }).loadURL).not.toHaveBeenCalled();
  });

  it('reports one death for a doubled crash event', async () => {
    // Some Electron/macOS builds emit render-process-gone AND the legacy alias.
    const onDied = vi.fn();
    const { guest } = await makeGuest({ onDied });
    const el = guest.element!;
    el.dispatchEvent(Object.assign(new Event('render-process-gone'), { details: { reason: 'crashed', exitCode: 6 } }));
    el.dispatchEvent(new Event('crashed'));
    expect(onDied).toHaveBeenCalledTimes(1);
    expect(guest.currentState).toBe('dead');
  });

  it('fails queued work immediately on crash rather than letting it time out', async () => {
    // Eight queued calls each waiting out their own deadline turns one crash
    // into minutes of apparent hang.
    const { guest } = await makeGuest();
    const el = guest.element!;
    (el as unknown as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript.mockImplementation(
      () => new Promise(() => {}),
    );
    const first = guest.runScript('1');
    const second = guest.runScript('2');
    await Promise.resolve();

    el.dispatchEvent(new Event('crashed'));

    await expect(first).rejects.toBeInstanceOf(AgentBrowserError);
    await expect(second).rejects.toBeInstanceOf(AgentBrowserError);
  });

  it('tells the agent its element refs are dead after a crash', async () => {
    // Without this the agent reuses a stale @eN, gets a second error, and burns
    // turns rediscovering what we already knew.
    const { guest } = await makeGuest();
    const pending = guest.runScript('x');
    (guest.element as unknown as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript.mockImplementation(
      () => new Promise(() => {}),
    );
    await Promise.resolve();
    guest.element!.dispatchEvent(new Event('crashed'));
    await expect(pending).rejects.toMatchObject({ hint: expect.stringContaining('refs') });
  });

  it('refuses work past the queue depth', async () => {
    const { guest } = await makeGuest();
    (guest.element as unknown as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript.mockImplementation(
      () => new Promise(() => {}),
    );
    const inflight: Array<Promise<unknown>> = [];
    for (let i = 0; i < OP_QUEUE_DEPTH; i += 1) inflight.push(guest.runScript(`${i}`).catch(() => {}));
    await expect(guest.runScript('overflow')).rejects.toMatchObject({ code: 'queue_depth_exceeded' });
    guest.destroy('tool');
    await Promise.allSettled(inflight);
  });

  it('times out a script that never settles', async () => {
    vi.useFakeTimers();
    const { guest } = await makeGuest();
    (guest.element as unknown as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript.mockImplementation(
      () => new Promise(() => {}),
    );
    const pending = guest.runScript('hang');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'script_timeout' });
    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS + 10);
    await assertion;
  });

  it('destroys synchronously and idempotently', async () => {
    const { guest } = await makeGuest();
    expect(liveWebviewCount()).toBe(1);
    guest.destroy('tool');
    // Synchronous: the element is gone by the time destroy() returns, because
    // unload paths are not awaited.
    expect(liveWebviewCount()).toBe(0);
    expect(guest.currentState).toBe('destroyed');
    expect(() => guest.destroy('tool')).not.toThrow();
  });

  it('treats a dead WebContents as not alive', async () => {
    const { guest } = await makeGuest();
    expect(guest.isAlive()).toBe(true);
    (guest.element as unknown as { __killContents: () => void }).__killContents();
    expect(guest.isAlive()).toBe(false);
  });

  it('fails a start that never reaches dom-ready', async () => {
    vi.useFakeTimers();
    fakeOptions.neverReady = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const guest = new AgentBrowserGuest({
      threadId: 't-slow',
      container,
      doc: document,
      partition: AGENT_BROWSER_PARTITION,
      urlPolicy: {},
      onDied: vi.fn(),
    });
    const started = guest.start();
    const assertion = expect(started).rejects.toMatchObject({ code: 'guest_start_timeout' });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    // A guest that failed to start must not leave its element behind.
    expect(liveWebviewCount()).toBe(0);
  });
});

// ── Pool ─────────────────────────────────────────────────────────────────────

function makePool(overrides: Partial<{
  ratio: number;
  exhausted: boolean;
  maxGuests: number;
  now: () => number;
  notify: (m: string) => void;
}> = {}) {
  const state = { ratio: overrides.ratio ?? 0.1, exhausted: overrides.exhausted ?? false };
  const hostWindow = {
    geode: {
      getFdPressure: async () => makeSnapshot(state.ratio, { exhausted: state.exhausted }),
    },
  };
  const pool = new AgentBrowserPool({
    doc: document,
    hostWindow,
    getMaxGuests: () => overrides.maxGuests ?? ABSOLUTE_MAX_GUESTS,
    getUrlPolicy: () => ({}),
    notify: overrides.notify,
    now: overrides.now,
  });
  return { pool, state };
}

/** The pool rate-limits creation, so tests that make several need a moving clock. */
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

describe('AgentBrowserPool', () => {
  it('reuses one guest per thread', async () => {
    const clock = movingClock();
    const { pool } = makePool({ now: clock.now });
    const first = await pool.acquire('thread-a');
    clock.step();
    const second = await pool.acquire('thread-a');
    expect(second).toBe(first);
    expect(pool.status().inUse).toBe(1);
    expect(liveWebviewCount()).toBe(1);
    pool.destroy();
  });

  it('refuses a new thread once the cap is reached', async () => {
    const clock = movingClock();
    const { pool } = makePool({ maxGuests: 2, now: clock.now });
    await pool.acquire('a');
    clock.step();
    await pool.acquire('b');
    clock.step();
    await expect(pool.acquire('c')).rejects.toMatchObject({ code: 'admission_denied_cap' });
    expect(liveWebviewCount()).toBe(2);
    pool.destroy();
  });

  it('refuses creation under file-descriptor pressure', async () => {
    // This is the crash the whole feature is designed around: a sandboxed guest
    // needs a spare descriptor at launch or it dies as a bare "exit code 6".
    const clock = movingClock();
    const notify = vi.fn();
    const { pool } = makePool({ ratio: FD_RED, now: clock.now, notify });
    await expect(pool.acquire('a')).rejects.toMatchObject({
      code: 'admission_denied_fd_pressure',
      retryable: true,
    });
    expect(liveWebviewCount()).toBe(0);
    expect(notify).toHaveBeenCalled();
    pool.destroy();
  });

  it('destroys every guest when descriptors are exhausted', async () => {
    // The agent's browser is discretionary; the user's editor is not.
    const clock = movingClock();
    const notify = vi.fn();
    const { pool, state } = makePool({ now: clock.now, notify });
    await pool.acquire('a');
    clock.step();
    expect(liveWebviewCount()).toBe(1);

    state.exhausted = true;
    clock.advance(10_000);
    await expect(pool.acquire('b')).rejects.toMatchObject({ code: 'admission_denied_fd_pressure', retryable: false });
    expect(liveWebviewCount()).toBe(0);
    expect(pool.status().inUse).toBe(0);
    pool.destroy();
  });

  it('rate-limits rapid creation', async () => {
    const { pool } = makePool({ now: () => 1_000_000 }); // frozen clock
    await pool.acquire('a');
    await expect(pool.acquire('b')).rejects.toMatchObject({ code: 'create_rate_limited' });
    pool.destroy();
  });

  it('trips a circuit breaker after repeated crashes on one thread', async () => {
    // Otherwise an agent retrying against a page that reliably kills its
    // renderer becomes a process-spawn loop.
    const clock = movingClock();
    const { pool } = makePool({ now: clock.now });

    const first = await pool.acquire('flaky');
    first.element!.dispatchEvent(new Event('crashed'));
    clock.step();

    const second = await pool.acquire('flaky');
    second.element!.dispatchEvent(new Event('crashed'));
    clock.step();

    await expect(pool.acquire('flaky')).rejects.toMatchObject({
      code: 'crash_cooldown',
      retryable: false,
    });
    // A different thread is unaffected.
    clock.step();
    await expect(pool.acquire('healthy')).resolves.toBeTruthy();
    pool.destroy();
  });

  it('reaps an idle guest on the reaper tick', async () => {
    vi.useFakeTimers();
    const clock = movingClock();
    const { pool } = makePool({ now: clock.now });
    pool.start();
    await pool.acquire('idle-thread');
    expect(liveWebviewCount()).toBe(1);

    clock.advance(IDLE_REAP_MS + 1_000);
    await vi.advanceTimersByTimeAsync(REAPER_TICK_MS + 10);

    expect(liveWebviewCount()).toBe(0);
    expect(pool.status().inUse).toBe(0);
    pool.destroy();
  });

  it('recycles a guest that reaches its hard TTL even while in use', async () => {
    // Idle reaping never fires against an agent polling a page every minute, so
    // this is the only bound on guest age.
    vi.useFakeTimers();
    let value = 1_000_000;
    const now = () => value;
    const { pool } = makePool({ now });
    pool.start();
    const guest = await pool.acquire('long-lived');

    // Keep it non-idle right up to the TTL.
    const keepAlive = setInterval(() => {
      value += IDLE_REAP_MS / 4;
      void guest.runScript('1').catch(() => {});
    }, REAPER_TICK_MS);

    value += HARD_TTL_MS + 1;
    await vi.advanceTimersByTimeAsync(REAPER_TICK_MS + 10);
    clearInterval(keepAlive);

    expect(pool.status().inUse).toBe(0);
    expect(liveWebviewCount()).toBe(0);
    pool.destroy();
  });

  it('reclaims a thread guest on demand', async () => {
    const clock = movingClock();
    const { pool } = makePool({ now: clock.now });
    await pool.acquire('gone-soon');
    pool.destroyForThread('gone-soon', 'thread-delete');
    expect(liveWebviewCount()).toBe(0);
    expect(pool.status().inUse).toBe(0);
    // Idempotent: delete and unload can both fire for the same thread.
    expect(() => pool.destroyForThread('gone-soon', 'unload')).not.toThrow();
    pool.destroy();
  });

  it('leaves no webview behind after destroy()', async () => {
    // The regression that matters: process count back to baseline.
    const clock = movingClock();
    const { pool } = makePool({ now: clock.now });
    await pool.acquire('a');
    clock.step();
    await pool.acquire('b');
    expect(liveWebviewCount()).toBe(2);

    pool.destroy();

    expect(liveWebviewCount()).toBe(0);
    expect(document.getElementById(AGENT_BROWSER_HOST_ID)).toBeNull();
  });

  it('drops its registry when the host container is removed externally', async () => {
    const clock = movingClock();
    const { pool } = makePool({ now: clock.now });
    await pool.acquire('a');
    document.getElementById(AGENT_BROWSER_HOST_ID)!.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.status().inUse).toBe(0);
    pool.destroy();
  });

  it('replaces a crashed guest lazily on the next request', async () => {
    const clock = movingClock();
    const { pool } = makePool({ now: clock.now });
    const first = await pool.acquire('t');
    first.element!.dispatchEvent(new Event('crashed'));
    expect(pool.status().inUse).toBe(0);

    clock.step();
    const second = await pool.acquire('t');
    expect(second).not.toBe(first);
    expect(liveWebviewCount()).toBe(1);
    pool.destroy();
  });

  it('reports itself incapable when the host exposes no diagnostics', async () => {
    const pool = new AgentBrowserPool({
      doc: document,
      hostWindow: {},
      getMaxGuests: () => 2,
      getUrlPolicy: () => ({}),
    });
    expect(pool.capable).toBe(false);
    await expect(pool.acquire('a')).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(liveWebviewCount()).toBe(0);
    pool.destroy();
  });
});
