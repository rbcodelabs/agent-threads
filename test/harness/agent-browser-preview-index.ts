import './obsidian-mock'; // must be first — sets up HTMLElement.prototype
import { AgentBrowserPreviewView } from '../../src/agentBrowser/AgentBrowserPreviewView';
import type { AgentBrowserPool, PoolStatus } from '../../src/agentBrowser/AgentBrowserPool';
import type { AgentBrowserGuest, GuestFacts, GuestState, GuestEndReason } from '../../src/agentBrowser/AgentBrowserGuest';
import { mockLeaf, mockWorkspace } from './obsidian-mock';

/**
 * Harness for `AgentBrowserPreviewView`'s login-handoff banner (ADR-0014).
 *
 * PR #631 shipped this banner with no browser-level coverage because
 * triggering it requires the Geode `window.geode.onAgentBrowserWindowOpen`
 * popup bridge plus Electron's `ipcRenderer` close/focus channels — neither
 * exists on a plain page. Both are dependency-injected by design (see the
 * doc comment atop `AgentBrowserLoginBridge.ts`): `window.geode` is a plain
 * object property any page can define before the view mounts, and
 * `ipcRenderer` resolves through the esbuild `electron` alias
 * (`./mocks/electron.ts`), which now exposes a controllable fake `emit()`.
 * Wiring both up here exercises the *real* `startLoginBridge()` production
 * path — the exact thing the PR's own description said it could not do.
 */

const THREAD_ID = 'thread-1';
/** Arbitrary ids standing in for Electron `webContents.id`s. */
const PRIMARY_WEBCONTENTS_ID = 42;
const LOGIN_WEBCONTENTS_ID = 43;

// A syntactically valid 1x1 transparent PNG, so the preview `<img>` renders a
// real (blank) image during a handoff instead of a browser's broken-image
// glyph — the latter differs across platforms and would be exactly the kind
// of screenshot noise this harness exists to avoid.
const ONE_PIXEL_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (char) => char.charCodeAt(0),
);

function makeGuestFacts(overrides: Partial<GuestFacts> & { state?: GuestState } = {}): GuestFacts {
  return {
    threadId: THREAD_ID,
    state: overrides.state ?? 'ready',
    url: 'https://example.com/docs',
    ageMs: 90_000,
    idleMs: 1_000,
    navCount: 3,
    scriptCount: 5,
    captureCount: 1,
    viewport: { width: 1280, height: 800 },
    ...overrides,
  };
}

const primaryFacts = makeGuestFacts();
const primaryGuest = {
  threadId: primaryFacts.threadId,
  currentState: primaryFacts.state,
  facts: () => primaryFacts,
  capture: async () => ONE_PIXEL_PNG,
  isAlive: () => true,
} as unknown as AgentBrowserGuest;

const loginFacts = makeGuestFacts({
  state: 'ready',
  url: 'https://accounts.example.com/login',
  navCount: 1,
  idleMs: 0,
});
const sendInputEventCalls: unknown[] = [];
let loginGuestFocusCalls = 0;
const loginGuest = {
  threadId: THREAD_ID,
  currentState: loginFacts.state,
  facts: () => loginFacts,
  capture: async () => ONE_PIXEL_PNG,
  isAlive: () => true,
  focus: () => { loginGuestFocusCalls += 1; },
  sendInputEvent: (event: unknown) => { sendInputEventCalls.push(event); },
} as unknown as AgentBrowserGuest;

const destroyForThreadCalls: Array<{ threadId: string; reason: GuestEndReason }> = [];
const releaseLoginGuestCalls: Array<{ threadId: string; reason: GuestEndReason }> = [];
let acquireLoginGuestCalls = 0;

const pool = {
  status: (): PoolStatus => ({ inUse: 1, max: 2, fdBlocked: false, fdAvailable: true, guests: [] }),
  mostRecentlyUsed: () => primaryGuest,
  destroyForThread: (threadId: string, reason: GuestEndReason) => {
    destroyForThreadCalls.push({ threadId, reason });
  },
  // Only the thread whose primary guest is "PRIMARY_WEBCONTENTS_ID" is
  // recognised — mirrors the bridge's own "not a guest we recognise" guard.
  findPrimaryByWebContentsId: (id: number) => (id === PRIMARY_WEBCONTENTS_ID ? THREAD_ID : null),
  findLoginByWebContentsId: (id: number) => (id === LOGIN_WEBCONTENTS_ID ? THREAD_ID : null),
  acquireLoginGuest: async (_threadId: string, _url: string) => {
    acquireLoginGuestCalls += 1;
    return loginGuest;
  },
  releaseLoginGuest: (threadId: string, reason: GuestEndReason = 'login-complete') => {
    releaseLoginGuestCalls.push({ threadId, reason });
  },
} as unknown as AgentBrowserPool;

// Stand in for Geode's `window.geode.onAgentBrowserWindowOpen` — the view
// feature-detects this exactly like `AgentBrowserLoginBridge.available` does,
// and exactly like the vitest unit coverage in
// test/unit/agent-browser-preview.test.ts already fakes it. Must be set
// *before* the view's onOpen() runs startLoginBridge().
type OpenRequest = { url: string; guestId: number; disposition: string };
type OpenCallback = (request: OpenRequest) => void;
let openCallback: OpenCallback | null = null;
(window as unknown as { geode: unknown }).geode = {
  onAgentBrowserWindowOpen: (cb: OpenCallback) => {
    openCallback = cb;
    return () => { openCallback = null; };
  },
};

let revealLeafCalls = 0;
(mockWorkspace as unknown as { revealLeaf: (leaf: unknown) => void }).revealLeaf = () => {
  revealLeafCalls += 1;
};

const view = new AgentBrowserPreviewView(mockLeaf as never, () => pool);
const container = document.getElementById('app')!;
container.appendChild(view.containerEl);
void view.onOpen();

// ── Exposed for Playwright ──────────────────────────────────────────────────
(window as any).__view = view;

/** Simulates Geode reporting a denied `window.open()` from the primary guest. */
(window as any).__fireLoginOpen = (url: string, guestId: number = PRIMARY_WEBCONTENTS_ID) => {
  openCallback?.({ url, guestId, disposition: 'foreground-tab' });
};

// Resolves through the esbuild `electron` alias (./mocks/electron.ts), the
// same module instance `AgentBrowserLoginBridge`'s own `require('electron')`
// resolves to inside this bundle — so `emit()` here reaches the listeners the
// view's real `startLoginBridge()` registered.
const { ipcRenderer: mockIpcRenderer } = require('electron') as {
  ipcRenderer: { emit: (channel: string, ...args: unknown[]) => void };
};

/** Simulates the login guest's own popup being closed (ipcRenderer channel). */
(window as any).__fireIpcClose = (webContentsId: number = LOGIN_WEBCONTENTS_ID) => {
  mockIpcRenderer.emit('agent-browser-window-close', webContentsId);
};

/** Simulates the login guest's popup regaining OS focus (ipcRenderer channel). */
(window as any).__fireIpcFocus = (webContentsId: number = LOGIN_WEBCONTENTS_ID) => {
  mockIpcRenderer.emit('agent-browser-window-focus', webContentsId);
};

(window as any).__getRevealLeafCalls = () => revealLeafCalls;
(window as any).__getDestroyForThreadCalls = () => destroyForThreadCalls;
(window as any).__getReleaseLoginGuestCalls = () => releaseLoginGuestCalls;
(window as any).__getAcquireLoginGuestCalls = () => acquireLoginGuestCalls;
(window as any).__getLoginGuestFocusCalls = () => loginGuestFocusCalls;
(window as any).__getSendInputEventCalls = () => sendInputEventCalls;
