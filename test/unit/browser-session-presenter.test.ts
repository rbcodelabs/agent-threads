// @vitest-environment jsdom
/**
 * The presenter is the seam between the shared LoginHandoffController and the
 * chat's cards. These tests pin the two things that must never regress:
 * the privacy invariant (a sign-in frame or keystroke never lands in a
 * transcript, image list or persisted structure) and the render contract
 * (one card per session, expand state that survives re-renders, screenshots
 * drawn once inside their card).
 */
import '../setup/obsidian-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserSessionPresenter, type BrowserPresenterHost } from '../../src/BrowserSessionPresenter';
import { LoginHandoffController, HANDOFF_CAPTURE_MS } from '../../src/agentBrowser/LoginHandoffController';
import type { AgentBrowserPool } from '../../src/agentBrowser/AgentBrowserPool';
import type { AgentBrowserGuest } from '../../src/agentBrowser/AgentBrowserGuest';
import { groupToolCalls } from '../../src/toolNameUtils';
import type { ChatMessage, ToolCallRecord } from '../../src/types';

const THREAD = 't1';
let seq = 0;
const b = (short: string, extra: Partial<ToolCallRecord> = {}): ToolCallRecord => {
  seq += 1;
  return { name: `mcp__claude_threads__browser_${short}`, summary: '', timestamp: 1000 + seq, toolUseId: `x${seq}`, status: 'success', durationMs: 300, ...extra };
};

function setup(over: Partial<{ messages: ChatMessage[]; pending: Array<{ mediaType: string; data?: string; path?: string }>; running: boolean }> = {}) {
  let running = over.running ?? false;
  const messages: ChatMessage[] = over.messages ?? [];
  const pending = over.pending ?? [];
  const chip = vi.fn();
  const human = vi.fn();
  const announce = vi.fn();
  const refresh = vi.fn();

  const loginGuest = {
    capture: vi.fn().mockResolvedValue(new Uint8Array([137, 80, 78, 71])),
    sendInputEvent: vi.fn(),
    focus: vi.fn(),
    facts: () => ({ viewport: { width: 1280, height: 800 } }),
  } as unknown as AgentBrowserGuest;
  let openCb: ((r: { url: string; guestId: number; disposition: string }) => void) | null = null;
  const pool = {
    findPrimaryByWebContentsId: () => THREAD,
    findLoginByWebContentsId: () => THREAD,
    acquireLoginGuest: vi.fn().mockResolvedValue(loginGuest),
    releaseLoginGuest: vi.fn(),
  } as unknown as AgentBrowserPool;
  const controller = new LoginHandoffController({
    getPool: () => pool,
    bridgeDeps: {
      geode: { onAgentBrowserWindowOpen: (cb) => { openCb = cb as typeof openCb; return () => {}; } },
      ipcRenderer: { on: () => {}, removeListener: () => {} },
    },
  });
  controller.start();

  const host: BrowserPresenterHost = {
    app: {} as never,
    activeThreadId: () => THREAD,
    messages: () => messages,
    streamingTools: () => [],
    pendingImages: () => pending,
    turnRunning: () => running,
    imageSrc: (ref, data) => (ref.path ? `vault://${ref.path}` : `data:${ref.mediaType};base64,${data ?? ''}`),
    controller: () => controller,
    refreshRows: refresh,
    setControlChip: chip,
    setComposerHuman: human,
    announce,
    isVisible: () => true,
  };
  const presenter = new BrowserSessionPresenter(host);
  presenter.attach();
  return {
    presenter, controller, loginGuest, pool, messages, pending, chip, human, announce, refresh,
    setRunning: (v: boolean) => { running = v; },
    fireOpen: () => openCb?.({ url: 'https://accounts.acme.io/login?tok=SECRET', guestId: 1, disposition: 'foreground-tab' }),
  };
}

function render(presenter: BrowserSessionPresenter, tools: ToolCallRecord[]): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  for (const entry of groupToolCalls(tools)) if (entry.kind === 'browser') presenter.renderEntry(root, entry);
  return root;
}

const row = (id: string, tools: ToolCallRecord[], extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'assistant', content: '', timestamp: 1, toolCalls: tools, ...extra });

beforeEach(() => { document.body.innerHTML = ''; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('BrowserSessionPresenter — rendering', () => {
  it('draws exactly one card per session and no tool pills', () => {
    const tools = [b('navigate', { summary: 'https://acme.io/pricing' }), b('click', { summary: 'e1' }), b('close')];
    const h = setup({ messages: [row('r', tools)] });
    const root = render(h.presenter, tools);
    expect(root.querySelectorAll('.ct-bc')).toHaveLength(1);
    expect(root.querySelector('.ct-tool-pill')).toBeNull();
    expect(root.querySelector('.ct-bc')!.className).toContain('is-closed'); // ended
  });

  it('a finished session is a collapsed chip; expanding is remembered across re-renders', () => {
    const tools = [b('navigate', { summary: 'https://acme.io/pricing' }), b('read_text')];
    const h = setup({ messages: [row('r', tools)] });
    let root = render(h.presenter, tools);
    const cardEl = root.querySelector('.ct-bc')!;
    expect(cardEl.className).toContain('is-collapsed');
    (root.querySelector('.ct-bc-chip') as HTMLButtonElement).click();
    expect(cardEl.className).not.toContain('is-collapsed');

    h.presenter.invalidate();
    root = render(h.presenter, tools); // a fresh render (live rebuild / finalize)
    expect(root.querySelector('.ct-bc')!.className).not.toContain('is-collapsed');

    h.presenter.clearExpansion(); // thread switch
    root = render(h.presenter, tools);
    expect(root.querySelector('.ct-bc')!.className).toContain('is-collapsed');
  });

  it('shows the claimed screenshot inside the card and reports it as claimed so it is not also loose', () => {
    const tools = [b('navigate', { summary: 'https://acme.io/' }), b('screenshot')];
    const h = setup({
      messages: [row('r', tools), row('final', [], { content: 'Done.', toolResultImages: [{ mediaType: 'image/png', data: 'AAAA' }, { mediaType: 'image/png', data: 'BBBB' }] })],
    });
    const root = render(h.presenter, tools);
    (root.querySelector('.ct-bc-chip') as HTMLButtonElement).click();
    expect(root.querySelector('.ct-bc-view img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect([...h.presenter.claimedImageIndexes('final')]).toEqual([0]); // BBBB still renders loose
    expect([...h.presenter.claimedImageIndexes('r')]).toEqual([]);
  });

  it('uses an image that has not reached a message yet (pending)', () => {
    const tools = [b('navigate', { summary: 'https://acme.io/' }), b('screenshot')];
    const h = setup({ messages: [row('r', tools)], pending: [{ mediaType: 'image/png', data: 'PEND' }], running: true });
    const root = render(h.presenter, tools);
    expect(root.querySelector('.ct-bc-view img')!.getAttribute('src')).toBe('data:image/png;base64,PEND');
    expect([...h.presenter.claimedPendingIndexes()]).toEqual([0]);
  });

  it('a session with no screenshot call keeps the skeleton even if other images exist', () => {
    const tools = [b('navigate', { summary: 'https://acme.io/' }), b('read_text')];
    const h = setup({ messages: [row('r', tools, { toolResultImages: [{ mediaType: 'image/png', data: 'Q' }] })], running: true });
    const root = render(h.presenter, tools);
    expect(root.querySelector('.ct-bc-skel')).not.toBeNull();
    expect(h.presenter.claimedImageIndexes('r').size).toBe(0);
  });

  it('is live only while the turn runs', () => {
    const tools = [b('navigate', { summary: 'https://acme.io/' }), b('click', { summary: 'e2' })];
    const h = setup({ messages: [row('r', tools)], running: true });
    expect(render(h.presenter, tools).querySelector('.ct-bc')!.className).toContain('is-live');
    h.setRunning(false);
    h.presenter.invalidate();
    expect(render(h.presenter, tools).querySelector('.ct-bc')!.className).toContain('is-done');
  });

  it('needsAttention reflects a handoff waiting on the human (so an outer wrap opens)', () => {
    const tools = [b('navigate', { summary: 'https://acme.io/' })];
    const h = setup({ messages: [row('r', tools)], running: true });
    expect(h.presenter.needsAttention(tools)).toBe(false);
    h.fireOpen();
    h.presenter.invalidate();
    expect(h.presenter.needsAttention(tools)).toBe(true);
  });

  it('draws a standalone card when there is a handoff but no browser session', () => {
    const h = setup({ messages: [], running: true });
    h.fireOpen();
    h.presenter.invalidate();
    const messagesEl = document.createElement('div');
    h.presenter.syncStandalone(messagesEl);
    expect(messagesEl.querySelector('.ct-bc-standalone .ct-bc.is-request')).not.toBeNull();
    h.controller.dismissRequest(THREAD);
    h.presenter.invalidate();
    h.presenter.syncStandalone(messagesEl);
    expect(messagesEl.querySelector('.ct-bc')).toBeNull();
  });
});

describe('BrowserSessionPresenter — handoff wiring', () => {
  it('shows the chip and composer cue only while in control, and announces mode changes once', async () => {
    const tools = [b('navigate', { summary: 'https://acme.io/' })];
    const h = setup({ messages: [row('r', tools)], running: true });
    h.fireOpen();
    expect(h.refresh).toHaveBeenCalled();
    expect(h.chip).toHaveBeenLastCalledWith(false);
    expect(h.announce).toHaveBeenCalledTimes(1);
    expect(h.announce.mock.calls[0][0]).toContain('30 seconds');

    // Countdown ticks never announce.
    vi.advanceTimersByTime(5000);
    expect(h.announce).toHaveBeenCalledTimes(1);

    await h.controller.takeControl(THREAD);
    expect(h.chip).toHaveBeenLastCalledWith(true);
    expect(h.human).toHaveBeenLastCalledWith(true);
    expect(h.announce).toHaveBeenCalledTimes(2);
    expect(h.announce.mock.calls[1][0]).toContain("You're in control");

    h.controller.returnControl(THREAD);
    expect(h.chip).toHaveBeenLastCalledWith(false);
    expect(h.announce.mock.calls[2][0]).toContain('Claude resumed');
  });

  it('ignores handoff changes for other threads', () => {
    const h = setup({ messages: [], running: true });
    const other = new BrowserSessionPresenter({
      ...({ activeThreadId: () => 'other' } as object),
    } as unknown as BrowserPresenterHost);
    expect(() => other.detach()).not.toThrow();
    h.fireOpen();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('no controller (plain Obsidian / mobile): attach is inert and cards offer no handoff', () => {
    const tools = [b('navigate', { summary: 'https://acme.io/' })];
    const presenter = new BrowserSessionPresenter({
      app: {} as never, activeThreadId: () => THREAD, messages: () => [row('r', tools)], streamingTools: () => [],
      pendingImages: () => [], turnRunning: () => true, imageSrc: () => '', controller: () => null,
      refreshRows: () => {}, setControlChip: () => {}, setComposerHuman: () => {}, announce: () => {}, isVisible: () => true,
    });
    expect(() => presenter.attach()).not.toThrow();
    const root = render(presenter, tools);
    expect(root.querySelector('.ct-bc-btn')).toBeNull();
    expect(root.querySelector('.ct-bc.is-live')).not.toBeNull();
    presenter.syncStandalone(document.createElement('div'));
    presenter.detach();
  });

  it('PRIVACY: sign-in frames and keystrokes go only to the DOM / login guest, never into transcript data', async () => {
    const tools = [b('navigate', { summary: 'https://acme.io/pricing' }), b('click', { summary: 'e1' })];
    const messages = [row('r', tools, { toolResultImages: [{ mediaType: 'image/png', data: 'REAL_SCREENSHOT' }] })];
    const pending: Array<{ mediaType: string; data?: string }> = [];
    const h = setup({ messages, pending, running: true });
    const snapshot = () => JSON.stringify({ messages, pending });
    const before = snapshot();

    h.fireOpen();
    await h.controller.takeControl(THREAD);
    h.presenter.invalidate();
    const root = render(h.presenter, tools);
    const frameImg = root.querySelector('.ct-bc.is-control .ct-bc-view.is-frame img') as HTMLImageElement;
    expect(frameImg).not.toBeNull();

    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS * 2);
    // The frame reached the <img> (a DOM sink) ...
    expect(frameImg.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    // ... and typing reaches the login guest ...
    for (const ch of 'hunter2') h.controller.forwardKey(THREAD, { key: ch, type: 'keydown', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
    expect(h.loginGuest.sendInputEvent).toHaveBeenCalledTimes(14); // keyDown + char per character;

    // ... but nothing the agent can read or that is persisted changed.
    const after = snapshot();
    expect(after).toBe(before);
    expect(after).not.toContain('data:image/png');
    expect(after).not.toContain('hunter2');
    expect(after).not.toContain('SECRET'); // the request URL's query string
    // The only announcement text never contains what was typed or the URL query.
    expect(JSON.stringify(h.announce.mock.calls)).not.toContain('hunter2');
    expect(JSON.stringify(h.announce.mock.calls)).not.toContain('SECRET');
    // And the card's own DOM shows host+path only, not the query string.
    expect(root.textContent).not.toContain('SECRET');
  });
});
