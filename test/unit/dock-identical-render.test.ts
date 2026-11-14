/**
 * @vitest-environment jsdom
 *
 * The Ask-the-orchestrator dock sheet renders a conversation IDENTICALLY to the main panel (Rick's decision after
 * PR #912, which only shared code): the same `.ct-message` rows, tool-call grouping, markdown, links, notices and
 * dividers, built by the same shared renderer with the TRUSTED link policy. These tests drive the REAL ThreadsView
 * (appendMessage over mergeAdjacentToolOnlyMessages, exactly like renderMessagesBody) and the REAL dock sheet with the
 * same messages and compare the row DOM node for node.
 *
 * Only addressing differs, never rendering: the sheet tags each row with data-id / data-role (its keyed reconcile)
 * and appends its own "Sent, will be picked up" label; those are masked here.
 *
 * Sanitizer: the unit-test `sanitizeHTMLToDom` mock is a bare innerHTML copy, which would make every "hostile content is
 * removed" assertion vacuous. This file replaces it with a stand-in that strips what the real Geode / Obsidian one
 * strips (script, on* handlers, javascript: URLs) and counts its calls, so a regression that skips the sanitizer in the
 * dock path fails. It is a stand-in: the real sanitizer is exercised in the screenshot harness and a real Geode run.
 */
import '../setup/obsidian-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sanitizeCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian')>();
  return {
    ...actual,
    setIcon: (el: HTMLElement, icon: string) => { el.setAttribute('data-icon', icon); },
    setTooltip: (el: HTMLElement, tip: string) => { el.setAttribute('data-tooltip', tip); },
    sanitizeHTMLToDom: (html: string): DocumentFragment => {
      sanitizeCalls.count++;
      const doc = document.implementation.createHTMLDocument('');
      const body = doc.body;
      body.innerHTML = html;
      body.querySelectorAll('script, iframe, object, embed, style').forEach((n) => n.remove());
      body.querySelectorAll('*').forEach((n) => {
        for (const a of Array.from(n.attributes)) {
          if (/^on/i.test(a.name)) n.removeAttribute(a.name);
          else if (['href', 'src', 'xlink:href'].includes(a.name) && /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
        }
      });
      const frag = document.createDocumentFragment();
      while (body.firstChild) frag.appendChild(document.adoptNode(body.firstChild));
      return frag;
    },
  };
});

import { ThreadsView } from '../../src/ThreadsView';
import { OrchestratorDock, type OrchestratorDockDeps } from '../../src/orchestratorDock';
import { RemoteImageCache } from '../../src/remote/remoteImages';
import { mergeAdjacentToolOnlyMessages } from '../../src/toolNameUtils';
import type { ChatMessage, ToolCallRecord, Thread } from '../../src/types';
import { dumpDom } from '../helpers/domDump';
import { FIXTURE_BRIDGE_REPO, FIXTURE_VAULT_FILES, FIXTURE_VAULT_ROOT } from '../fixtures/richChatMessages';

const PNG = 'iVBORw0KGgo=';
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const tool = (name: string, summary: string, over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({ name, summary, status: 'success', toolUseId: `${name}-${summary}`, ...over });

const MARKDOWN = [
  '# Heading',
  '',
  'Intro with **bold**, _em_ and `code`, a [[Project Plan]] wikilink, [design](docs/design.md#Overview), [site](https://example.com/page), [mail](mailto:a@b.co) and a bare https://bare.example.com/x link.',
  '',
  '| A | B |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '- one',
  '- [x] done',
  '',
  '```ts',
  'const u = "https://in-code.example.com";',
  '```',
  '',
  `Bridge ${FIXTURE_BRIDGE_REPO}/src/index.ts here.`,
].join('\n');

/** Rows in the order a real conversation has them. Ids are unique; the two tool-only runs exercise the adjacent-tool merge. */
function conversation(): ChatMessage[] {
  return [
    { id: 'u1', role: 'user', timestamp: 1, content: 'see https://user.example.com/x please', images: [{ name: 's.png', mediaType: 'image/png', base64: PNG }] },
    { id: 'a1', role: 'assistant', timestamp: 2, content: MARKDOWN, cost: 0.0123 },
    // A tool-only run of three steps (one persisted message per SDK turn): merges into ONE row with ONE group.
    { id: 't1', role: 'assistant', timestamp: 3, content: '', toolCalls: [tool('Read', 'Read: /a.md')] },
    { id: 't2', role: 'assistant', timestamp: 4, content: '', toolCalls: [tool('Read', 'Read: /b.md'), tool('Grep', 'Grep: TODO', { status: 'error' })] },
    { id: 't3', role: 'assistant', timestamp: 5, content: '', toolCalls: [tool('Bash', 'Bash: ls')], toolResultImages: [{ mediaType: 'image/png', data: PNG }] },
    { id: 'a2', role: 'assistant', timestamp: 6, content: 'Done. Two **notes** changed.', toolCalls: [tool('Edit', 'Edit: /a.md'), tool('Edit', 'Edit: /b.md')], cost: 0.5 },
    { id: 'n1', role: 'notice', timestamp: 7, content: 'Background task finished', noticeStatus: 'completed' },
    { id: 'c1', role: 'compact', timestamp: 8, content: '', compactTrigger: 'auto', preTokens: 98000 },
    { id: 'u2', role: 'user', timestamp: 9, content: 'thanks' },
  ];
}

const HOSTILE = [
  'Click [here](javascript:alert(1)) or [there](https://ok.example.com).',
  '',
  '<script>window.pwned = 1</script>',
  '',
  '<img src="x" onerror="window.pwned = 2"> and ![tracker](https://evil.example/pixel.png)',
  '',
  '<a href="javascript:alert(3)" onclick="window.pwned = 4">raw anchor</a>',
].join('\n');

// ── The main panel: the real ThreadsView.appendMessage over the merged rows ───────────────────────────────────────

function mainPanelRows(messages: ChatMessage[]): Promise<HTMLElement> {
  const view = Object.create(ThreadsView.prototype) as ThreadsView & Record<string, any>;
  const thread = { id: 'orch', noteFile: 'Threads/orch.md', messages };
  view.app = {
    vault: { adapter: { basePath: FIXTURE_VAULT_ROOT }, getAbstractFileByPath: (p: string) => (FIXTURE_VAULT_FILES.includes(p) ? { path: p } : null) },
    workspace: { openLinkText: () => {} },
    plugins: { plugins: { 'vault-bridges': { api: { getBridges: () => [bridge()] } } } },
  };
  view.plugin = { settings: { enableInlineVisualizations: true, toolCallStyle: 'tree' }, isConversationFirst: () => false, contextPanel: { openLinkText: () => {} }, daemonRegistry: { clientFor: () => undefined } };
  view.manager = { getThread: () => thread };
  view.activeThreadId = 'orch';
  view.messageContentController = new AbortController();
  view.visualizeManager = { hydrate: () => {} };
  view.remoteImageCache = new RemoteImageCache();
  view.compressedView = false;
  view.summaryTextEls = new Map();
  view.browserRowEls = new Map();
  view.browser = undefined;
  for (const k of ['expandedToolGroups', 'userCollapsedToolGroups', 'liveExpandedToolGroups', 'expandedOuterToolWrap', 'liveExpandedOuterToolWrap']) view[k] = new Set();
  view.attachUserMessageMenu = () => {};
  view.formatShortTime = (t: number) => `t${t}`;
  view.openLink = () => {};
  view.confirmOpenOutsideVaultLink = () => {};
  const messagesEl = document.createElement('div');
  document.body.appendChild(messagesEl);
  view.messagesEl = messagesEl;
  return (async () => {
    // renderMessagesBody: merge, then append each row.
    for (const msg of mergeAdjacentToolOnlyMessages(messages)) await view.appendMessage(msg);
    await flush();
    return messagesEl;
  })();
}

const bridge = () => ({ id: 'b', name: 'Bridge', repoPath: FIXTURE_BRIDGE_REPO, sourcePath: '', vaultPath: 'Bridge', branch: 'main', autoSync: true, status: 'ok' });

// ── The dock sheet: the real OrchestratorDock with the same messages ──────────────────────────────────────────────

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return { id, title: `Thread ${id}`, cwd: '/r', messages: [], createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true, ...over } as Thread;
}

function openDock(messages: ChatMessage[], extra: Partial<OrchestratorDockDeps> = {}) {
  const orch = thread('orch', { messages: messages as never });
  const threads = [orch, thread('a', { title: 'Deploy curation' }), thread('b')];
  const manager = {
    getThread: (id: string) => threads.find((t) => t.id === id),
    isRunning: () => false, hasPendingPermission: () => false, hasPendingQuestion: () => false, hasPendingPlan: () => false,
    hasActiveBackgroundTasks: () => false, getQueuedMessages: () => [], removeQueuedMessageAt: vi.fn(), getThreadActivity: () => undefined,
    interrupt: vi.fn(), sendMessage: vi.fn(), subscribe: vi.fn(() => () => {}),
  };
  const deps: OrchestratorDockDeps = {
    manager: manager as never,
    listThreads: () => threads,
    hasPendingWakeup: () => false,
    getOrchestratorThreadId: () => 'orch',
    ensureOrchestrator: vi.fn(async () => {}),
    openThread: vi.fn(),
    openLink: vi.fn(),
    resolveLink: vi.fn(() => true),
    mode: () => 'pill',
    daemons: null,
    messageHost: {
      vaultHas: (p) => FIXTURE_VAULT_FILES.includes(p),
      openExternal: () => {},
      bridges: () => [bridge()],
      formatTime: (t) => `t${t}`,
      toolPathContext: () => ({ vaultRoot: FIXTURE_VAULT_ROOT }),
      toolCallStyle: () => 'tree',
    },
    ...extra,
  };
  const stage = document.createElement('div');
  stage.className = 'ct-kanban-dispatch';
  const host = document.createElement('div');
  stage.appendChild(host);
  document.body.appendChild(stage);
  const dock = new OrchestratorDock(host, deps);
  dock.mount();
  dock.openSheet();
  return { dock, deps, stage, orch, log: () => stage.querySelector<HTMLElement>('.ct-orch-sheet-log')! };
}

/** Rows as DOM text with the sheet's own addressing attributes masked. */
const rowsOf = (root: HTMLElement): string[] => Array.from(root.children).map((child) => {
  const wrap = document.createElement('div');
  const copy = child.cloneNode(true) as HTMLElement;
  copy.removeAttribute('data-id');
  copy.removeAttribute('data-role');
  copy.querySelectorAll('.ct-orch-pickup').forEach((n) => n.remove());
  wrap.appendChild(copy);
  return dumpDom(wrap);
});

beforeEach(() => { document.body.innerHTML = ''; sanitizeCalls.count = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('dock sheet renders a conversation identically to the main panel', () => {
  it('every row of a mixed conversation (user, markdown, merged tool runs, notice, divider) has the main panel DOM', async () => {
    const messages = conversation();
    const main = await mainPanelRows(messages.map((m) => ({ ...m })));
    const dock = openDock(messages.map((m) => ({ ...m })));
    await flush();
    const expected = rowsOf(main);
    const actual = rowsOf(dock.log());
    // Same number of rows: the three tool-only messages are ONE row in both.
    expect(actual.length).toBe(expected.length);
    expect(expected.length).toBe(conversation().length - 2);
    actual.forEach((dump, i) => expect(dump, `row ${i}`).toBe(expected[i]));
    // And they really are the main panel's classes, not the old compact bubble.
    expect(dock.log().querySelectorAll(':scope > .ct-message').length).toBeGreaterThan(0);
    expect(dock.log().querySelector('.ct-orch-msg, .ct-orch-bubble, .ct-orch-tools')).toBeNull();
    expect(dock.log().querySelectorAll('.ct-tool-group').length).toBeGreaterThan(0);
  });

  it('adjacent tool-only messages merge into one row with one tool group, as in the main panel', async () => {
    const dock = openDock(conversation());
    await flush();
    const rows = dock.log().querySelectorAll<HTMLElement>(':scope > .ct-message');
    const toolRow = Array.from(rows).find((r) => r.dataset.id === 't1')!;
    expect(toolRow).toBeTruthy();
    expect(dock.log().querySelector('[data-id="t2"], [data-id="t3"]')).toBeNull();
    expect(toolRow.querySelectorAll('.ct-tool-group')).toHaveLength(1);
    expect(toolRow.querySelectorAll('.ct-tool-pill')).toHaveLength(4);
  });

  it('hostile content is sanitised exactly like the main panel, and the sanitizer runs in the dock path', async () => {
    const messages: ChatMessage[] = [{ id: 'h1', role: 'assistant', timestamp: 1, content: HOSTILE }];
    const main = await mainPanelRows(messages.map((m) => ({ ...m })));
    const mainCalls = sanitizeCalls.count;
    expect(mainCalls).toBeGreaterThan(0);
    sanitizeCalls.count = 0;
    const dock = openDock(messages.map((m) => ({ ...m })));
    await flush();
    expect(sanitizeCalls.count).toBeGreaterThan(0);
    expect(rowsOf(dock.log())).toEqual(rowsOf(main));
    const log = dock.log();
    expect(log.querySelector('script')).toBeNull();
    expect(log.querySelector('[onerror], [onclick]')).toBeNull();
    expect(Array.from(log.querySelectorAll('a')).some((a) => /^\s*javascript:/i.test(a.getAttribute('href') ?? ''))).toBe(false);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    // The user's own https link still works; the remote image is what the main panel does with it (trusted policy).
    expect(log.querySelector('a[href="https://ok.example.com"]')).not.toBeNull();
    expect(log.querySelector('img[src="https://evil.example/pixel.png"]')?.outerHTML).toBe(main.querySelector('img[src="https://evil.example/pixel.png"]')?.outerHTML);
  });

  it('hostile content in a USER message is plain text in both', async () => {
    const messages: ChatMessage[] = [{ id: 'h2', role: 'user', timestamp: 1, content: '<script>window.pwned = 9</script> <img src=x onerror=alert(1)> javascript:alert(2)' }];
    const main = await mainPanelRows(messages.map((m) => ({ ...m })));
    const dock = openDock(messages.map((m) => ({ ...m })));
    await flush();
    expect(rowsOf(dock.log())).toEqual(rowsOf(main));
    expect(dock.log().querySelector('script, img')).toBeNull();
  });

  it('notices and compaction dividers are the main panel rows (no wrapper)', async () => {
    const messages = conversation().filter((m) => m.role === 'notice' || m.role === 'compact');
    const main = await mainPanelRows(messages.map((m) => ({ ...m })));
    const dock = openDock(messages.map((m) => ({ ...m })));
    await flush();
    expect(rowsOf(dock.log())).toEqual(rowsOf(main));
    expect(dock.log().querySelector(':scope > .ct-notice-row')).not.toBeNull();
    expect(dock.log().querySelector(':scope > .ct-compact-divider')).not.toBeNull();
  });

  it('the dock sheet log carries the tool-call style class the main panel root does', async () => {
    const dock = openDock(conversation());
    await flush();
    expect(dock.log().classList.contains('ct-tools-tree')).toBe(true);
  });
});

describe('dock-only chrome on top of the identical rows', () => {
  const say = (id: string, content: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', timestamp: 1, content, ...over } as ChatMessage);
  const ask = (id: string, content: string): ChatMessage => ({ id, role: 'user', timestamp: 1, content });

  it('the 50-message cap counts rows AFTER the adjacent-tool merge', async () => {
    // 60 tool-only steps merge into ONE row, so 49 text messages + 1 merged row = 50 rows: nothing is hidden.
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 24; i++) messages.push(ask(`q${i}`, `q ${i}`), say(`r${i}`, `r ${i}`));
    messages.push(ask('q-last', 'one more'));
    for (let i = 0; i < 60; i++) messages.push(say(`s${i}`, '', { toolCalls: [tool('Read', `Read: /f${i}.md`)] }));
    const dock = openDock(messages);
    await flush();
    expect(dock.log().querySelector('.ct-orch-older')).toBeNull();
    expect(dock.log().querySelectorAll(':scope > .ct-message')).toHaveLength(50);
  });

  it('past 50 rows it shows the LAST 50 and an "Open full thread" row first', async () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 62; i++) messages.push(i % 2 ? say(`m${i}`, `reply ${i}`) : ask(`m${i}`, `ask ${i}`));
    const dock = openDock(messages);
    await flush();
    const log = dock.log();
    expect(log.firstElementChild?.className).toBe('ct-orch-older');
    expect(log.querySelectorAll(':scope > .ct-message')).toHaveLength(50);
    expect(log.querySelector('[data-id="m11"]')).toBeNull();
    expect(log.querySelector('[data-id="m12"]')).not.toBeNull();
  });

  it('[[thread:id|Title]] renders as the main panel internal link, opens that thread on click, and highlights its card on hover', async () => {
    const focusCard = vi.fn(() => true);
    const clearCardFocus = vi.fn();
    const dock = openDock([say('a1', 'See [[thread:a|Deploy]] and [[thread:Thread b]] and [[thread:ghost|Ghost]].')], { focusCard, clearCardFocus });
    await flush();
    const links = Array.from(dock.log().querySelectorAll<HTMLAnchorElement>('a.internal-link[data-href^="thread:"]'));
    expect(links.map((a) => [a.dataset.href, a.textContent])).toEqual([['thread:a', 'Deploy'], ['thread:b', 'Thread b']]);
    expect(dock.log().textContent).toContain('Ghost');
    expect(dock.log().querySelector('a[data-href="thread:ghost"]')).toBeNull();
    links[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(focusCard).toHaveBeenCalledWith('a', { scroll: true, flash: true });
    links[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    expect(clearCardFocus).toHaveBeenCalled();
    links[0].click();
    expect(dock.deps.openThread).toHaveBeenCalledWith('a');
  });

  it('a [[note]] opens through the dock link opener (never the active leaf), and an http link through the injected opener', async () => {
    const openExternal = vi.fn();
    const openLink = vi.fn();
    const dock = openDock([say('a1', 'Plan: [[Project Plan]], [design](docs/design.md) and [site](https://example.com/p).')], {
      openLink,
      messageHost: { vaultHas: () => true, openExternal, formatTime: () => '', toolPathContext: () => ({}), toolCallStyle: () => 'tree' },
    });
    await flush();
    dock.log().querySelector<HTMLAnchorElement>('a.internal-link[data-href="Project Plan"]')!.click();
    expect(openLink).toHaveBeenCalledWith('Project Plan');
    dock.log().querySelector<HTMLAnchorElement>('a[href="https://example.com/p"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(openExternal).toHaveBeenCalledWith('https://example.com/p', true);
  });
});
