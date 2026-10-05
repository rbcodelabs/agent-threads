// @vitest-environment jsdom
/**
 * The guest paints its overlay (agent cursor / focus ring) into the page right
 * before every capture, so it is in each frame the pane, the chat card and step
 * screenshots show. It must never cost script budget, never break a capture,
 * and forget the pointer when the page navigates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentBrowserGuest } from '../../src/agentBrowser/AgentBrowserGuest';
import { AGENT_BROWSER_PARTITION } from '../../src/agentBrowser/AgentBrowserPool';

let originalCreateElement: typeof document.createElement;
let exec: ReturnType<typeof vi.fn>;
let order: string[];

function installFakeWebview(): void {
  originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, opts?: unknown) => {
    const el = originalCreateElement(tagName as 'div', opts as ElementCreationOptions);
    if (tagName !== 'webview') return el;
    Object.assign(el, {
      loadURL: vi.fn(async () => {}),
      getURL: () => 'https://acme.io/',
      getTitle: () => 'Acme',
      stop: vi.fn(),
      executeJavaScript: exec,
      capturePage: vi.fn(async () => {
        order.push('capturePage');
        const img = { toPNG: () => new Uint8Array([1]), resize: () => img, getSize: () => ({ width: 1, height: 1 }) };
        return img;
      }),
      insertCSS: vi.fn(),
      getWebContentsId: () => 7,
      sendInputEvent: vi.fn(),
      focus: vi.fn(),
    });
    queueMicrotask(() => el.dispatchEvent(new Event('dom-ready')));
    return el;
  }) as typeof document.createElement);
}

async function makeGuest(now: () => number = () => 5000) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const guest = new AgentBrowserGuest({
    threadId: 't1', container, doc: document, partition: AGENT_BROWSER_PARTITION, urlPolicy: {}, onDied: vi.fn(), now,
  });
  await guest.start();
  return guest;
}

beforeEach(() => {
  order = [];
  exec = vi.fn(async (code: string) => { order.push(code.includes('"pointer"') ? 'overlay' : 'script'); return true; });
  installFakeWebview();
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('AgentBrowserGuest overlay', () => {
  it('paints the overlay before the frame is captured', async () => {
    const guest = await makeGuest();
    exec.mockClear();
    order.length = 0;
    await guest.capture(512);
    expect(order).toEqual(['overlay', 'capturePage']);
  });

  it('draws the last agent pointer, with a ripple time only for clicks', async () => {
    const guest = await makeGuest();
    guest.markAgentPointer(120, 80, true);
    exec.mockClear();
    await guest.capture(512);
    const click = JSON.parse(/var UPDATE = (.*);/.exec(String(exec.mock.calls[0][0]))![1]);
    expect(click.pointer).toEqual({ x: 120, y: 80, clickAt: 5000 });

    guest.markAgentPointer(10, 20, false);
    exec.mockClear();
    await guest.capture(512);
    const move = JSON.parse(/var UPDATE = (.*);/.exec(String(exec.mock.calls[0][0]))![1]);
    expect(move.pointer).toEqual({ x: 10, y: 20, clickAt: null });
  });

  it('does not spend script budget on the overlay', async () => {
    const guest = await makeGuest();
    await guest.capture(512);
    await guest.capture(512);
    expect(guest.facts().scriptCount).toBe(0);
  });

  it('still captures when the overlay script fails or the page is gone', async () => {
    const guest = await makeGuest();
    exec.mockRejectedValue(new Error('page navigated'));
    await expect(guest.capture(512)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('forgets the pointer when the page starts a navigation', async () => {
    const guest = await makeGuest();
    guest.markAgentPointer(1, 2, true);
    guest.element!.dispatchEvent(Object.assign(new Event('did-start-navigation'), { url: 'https://acme.io/next', isMainFrame: true }));
    exec.mockClear();
    await guest.capture(512);
    const update = JSON.parse(/var UPDATE = (.*);/.exec(String(exec.mock.calls[0][0]))![1]);
    expect(update.pointer).toBeNull();
  });

  it('re-installs the overlay when a new document is ready (idempotent re-injection)', async () => {
    const guest = await makeGuest();
    exec.mockClear();
    guest.element!.dispatchEvent(new Event('dom-ready'));
    await Promise.resolve();
    // dom-ready also installs the devtools network hook (see agent-browser-devtools.test.ts).
    const overlayCalls = exec.mock.calls.filter((c) => String(c[0]).includes('var UPDATE'));
    expect(overlayCalls).toHaveLength(1);
  });
});
