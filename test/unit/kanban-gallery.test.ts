/**
 * kanban-gallery.test.ts
 * @vitest-environment jsdom
 *
 * Agent Board Gallery mode: drives the real KanbanView in 'gallery' group-by.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { FileSystemAdapter } from 'obsidian';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (n: string) => n }));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class { mount() {} destroy() {} setValue() {} } }));

import { KanbanView } from '../../src/KanbanView';
import type { VisibilityObserverFactory } from '../../src/galleryLazy';
import type { ChatMessage, Thread } from '../../src/types';

type TR = NonNullable<ChatMessage['toolResultImages']>;
const imgs = (n: number, prefix = 'a', extra: Partial<TR[number]> = {}): TR =>
  Array.from({ length: n }, (_, i) => ({ mediaType: 'image/png', path: `att/${prefix}-${i}.png`, ...extra }));

function makeThread(id: string, over: Partial<Thread> & { images?: TR } = {}): Thread {
  const { images, ...rest } = over;
  const messages: ChatMessage[] = [
    { id: `${id}-m1`, role: 'assistant', content: `last words of ${id}`, timestamp: 1000, toolResultImages: images } as ChatMessage,
  ];
  return { id, title: `Thread ${id}`, cwd: '/repo', messages, createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true, ...rest } as Thread;
}

interface Opts { groupBy?: string; permission?: Set<string>; running?: Set<string>; observer?: VisibilityObserverFactory; pending?: Record<string, Array<{ mediaType: string; data: string }>> }

function makeHarness(threads: Thread[], opts: Opts = {}) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const permission = opts.permission ?? new Set<string>();
  const running = opts.running ?? new Set<string>();
  const resolvePermission = vi.fn();
  const ensureImageThumbnail = vi.fn(async () => null as string | null);
  const manager = {
    vaultRoot: '/vault',
    getThreads: () => [...threads],
    getThread: (id: string) => byId.get(id),
    isRunning: (id: string) => running.has(id),
    hasPendingPermission: (id: string) => permission.has(id),
    hasPendingQuestion: (id: string) => (byId.get(id)?.pendingQuestions?.length ?? 0) > 0,
    hasPendingPlan: () => false,
    isRunStale: () => false,
    hasActiveBackgroundTasks: () => false,
    getThreadActivity: () => 'Working...',
    getProject: () => undefined,
    getProjects: () => [],
    getPendingPermission: (id: string) => (permission.has(id) ? { toolName: 'Bash', detail: 'pnpm prisma migrate deploy' } : undefined),
    getPendingToolResultImages: (id: string) => opts.pending?.[id] ?? [],
    getAgentRuns: () => [],
    getRemoteScope: () => undefined,
    resolvePermission,
    ensureImageThumbnail,
    subscribe: () => () => {},
  };
  const adapter = Object.assign(new FileSystemAdapter(), { getResourcePath: (p: string) => `res://${p}` });
  const plugin = {
    manager,
    app: { vault: { adapter } },
    settings: { kanbanGroupBy: opts.groupBy ?? 'gallery', stackScheduledThreads: false, alwaysAllowedTools: [], extraEnv: '', kanbanCollapseSide: 'none' },
    hasPendingWakeup: () => false,
    getPendingWakeups: () => [],
    getActiveThreadId: () => null,
    saveSettings: vi.fn(),
    openThreadInChatView: vi.fn(),
  };
  const view = new KanbanView({} as never, plugin as never) as unknown as {
    app: unknown;
    boardEl: HTMLElement; headerCountEl: HTMLElement; render: () => void; searchQuery: string; needsYouOnly: boolean;
    galleryObserverFactory?: VisibilityObserverFactory;
    computeCardPlacement(t: Thread): { bucketKey: string; state: string };
  };
  view.app = plugin.app;
  if (opts.observer) view.galleryObserverFactory = opts.observer;
  view.boardEl = document.createElement('div');
  view.headerCountEl = document.createElement('div');
  document.body.appendChild(view.boardEl);
  view.render();
  return { view, plugin, manager, resolvePermission, ensureImageThumbnail };
}

const cards = (b: HTMLElement) => Array.from(b.querySelectorAll<HTMLElement>('.ct-gallery-card'));
const card = (b: HTMLElement, id: string) => b.querySelector<HTMLElement>(`.ct-gallery-card[data-thread-id="${id}"]`)!;
const hero = (c: HTMLElement) => c.querySelector<HTMLImageElement>('.ct-gallery-hero')!;
const counter = (c: HTMLElement) => c.querySelector('.ct-gallery-count')?.textContent;

beforeEach(() => { document.body.innerHTML = ''; });

describe('Gallery mode: layout', () => {
  it('renders one card per thread, recent activity first, in a grid', () => {
    const { view } = makeHarness([
      makeThread('old', { updatedAt: 1, images: imgs(1, 'old') }),
      makeThread('new', { updatedAt: 9, images: imgs(1, 'new') }),
      makeThread('mid', { updatedAt: 5, images: imgs(1, 'mid') }),
    ]);
    expect(cards(view.boardEl).map((c) => c.dataset.threadId)).toEqual(['new', 'mid', 'old']);
    expect(view.boardEl.querySelector('.ct-gallery-board')).not.toBeNull();
    expect(view.boardEl.querySelector('.ct-kanban-board')).toBeNull();
  });

  it('keeps the existing empty state', () => {
    const { view } = makeHarness([]);
    expect(view.boardEl.querySelector('.ct-agents-empty')?.textContent).toContain('No threads yet.');
    expect(view.boardEl.querySelector('.ct-gallery-board')).toBeNull();
  });

  it('applies the search filter and the Only-needs-you filter', () => {
    const a = makeThread('a', { title: 'Alpha', images: imgs(1) });
    const b = makeThread('b', { title: 'Beta', images: imgs(1), proposedReply: { text: 'ok', generatedAt: 1, sourceThreadId: 'o' } as never });
    const h = makeHarness([a, b]);
    h.view.searchQuery = 'alp'; h.view.render();
    expect(cards(h.view.boardEl).map((c) => c.dataset.threadId)).toEqual(['a']);
    h.view.searchQuery = ''; h.view.needsYouOnly = true; h.view.render();
    expect(cards(h.view.boardEl).map((c) => c.dataset.threadId)).toEqual(['b']);
  });

  it('records a stable gallery bucket key and never a status-board key', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(1) })]);
    expect(view.computeCardPlacement(makeThread('a')).bucketKey).toBe('gallery::grid');
  });
});

describe('Gallery mode: featured Needs-you card', () => {
  it('features a Needs-you thread and wires Allow/Deny to the lane handlers', () => {
    const t = makeThread('perm', { images: imgs(2, 'perm') });
    const { view, resolvePermission } = makeHarness([t, makeThread('other', { images: imgs(1) })], { permission: new Set(['perm']), running: new Set(['perm']) });
    const featured = view.boardEl.querySelector<HTMLElement>('.ct-gallery-featured')!;
    expect(featured.dataset.threadId).toBe('perm');
    expect(featured.classList.contains('is-needs')).toBe(true);
    const allow = featured.querySelector<HTMLButtonElement>('.ct-permission-allow')!;
    const deny = featured.querySelector<HTMLButtonElement>('.ct-permission-deny')!;
    expect(allow).not.toBeNull();
    allow.click(); deny.click();
    expect(resolvePermission).toHaveBeenNthCalledWith(1, 'perm', true);
    expect(resolvePermission).toHaveBeenNthCalledWith(2, 'perm', false);
    expect(view.boardEl.querySelector('.ct-gallery-banner')?.textContent).toContain('1 thread needs you');
  });

  it('features an inbox Needs-you thread (proposed reply) with the shared reply block', () => {
    const t = makeThread('reply', { proposedReply: { text: 'Ship it', generatedAt: 1, sourceThreadId: 'o' } as never });
    const { view } = makeHarness([t]);
    const featured = view.boardEl.querySelector<HTMLElement>('.ct-gallery-featured')!;
    expect(featured.querySelector('.ct-kanban-reply-approve')).not.toBeNull();
    expect(featured.classList.contains('ct-gallery-textfirst')).toBe(true);
    expect(featured.querySelector('.ct-gallery-media')).toBeNull();
  });

  it('shows a Needs-you chip (no actions) on overflow cards beyond the featured area', () => {
    const mk = (id: string) => makeThread(id, { images: imgs(1, id), proposedReply: { text: 'x', generatedAt: 1, sourceThreadId: 'o' } as never });
    const { view } = makeHarness([mk('a'), mk('b'), mk('c')]);
    expect(view.boardEl.querySelectorAll('.ct-gallery-featured')).toHaveLength(2);
    const overflow = cards(view.boardEl).filter((c) => !c.classList.contains('ct-gallery-featured'));
    expect(overflow).toHaveLength(1);
    expect(overflow[0].querySelector('.ct-gallery-chip-needs')?.textContent).toBe('Needs you');
    expect(overflow[0].querySelector('.ct-permission-btn')).toBeNull();
  });
});

describe('Gallery mode: hero, filmstrip and stepping', () => {
  it('shows the newest image first with badge, counter and filmstrip cap with +N', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(8) })]);
    const c = card(view.boardEl, 'a');
    expect(hero(c).getAttribute('src')).toBe('res://att/a-7.png'); // newest-first
    expect(counter(c)).toBe('1 / 8');
    expect(c.querySelector('.ct-gallery-badge')?.textContent).toBe('Image');
    expect(c.querySelectorAll('.ct-gallery-strip button.ct-gallery-thumb')).toHaveLength(3);
    expect(c.querySelector('.ct-gallery-more')?.textContent).toBe('+6');
    expect(c.querySelectorAll('.ct-gallery-strip li')).toHaveLength(3);
  });

  it('caps the featured filmstrip at 5', () => {
    const t = makeThread('f', { images: imgs(9), proposedReply: { text: 'x', generatedAt: 1, sourceThreadId: 'o' } as never });
    const { view } = makeHarness([t]);
    expect(card(view.boardEl, 'f').querySelectorAll('.ct-gallery-strip button.ct-gallery-thumb')).toHaveLength(5);
  });

  it('keeps equal footprint: empty slots render as skeletons', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(1) })]);
    const c = card(view.boardEl, 'a');
    expect(c.querySelectorAll('.ct-gallery-strip li')).toHaveLength(3);
    expect(c.querySelectorAll('.ct-gallery-skel')).toHaveLength(2);
    expect(c.querySelector('.ct-gallery-prev')).toBeNull(); // single image: no arrows
  });

  it('steps with next/prev buttons, wraps, and updates counter, aria-current and the aria-live region', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(3) })]);
    const c = card(view.boardEl, 'a');
    expect(c.querySelector('.ct-gallery-count')?.getAttribute('aria-live')).toBe('polite');
    c.querySelector<HTMLButtonElement>('.ct-gallery-next')!.click();
    expect(counter(c)).toBe('2 / 3');
    expect(hero(c).getAttribute('src')).toBe('res://att/a-1.png');
    expect(c.querySelectorAll('.ct-gallery-thumb[aria-current="true"]')).toHaveLength(1);
    expect(c.querySelector('.ct-gallery-thumb[data-i="1"]')?.getAttribute('aria-current')).toBe('true');
    c.querySelector<HTMLButtonElement>('.ct-gallery-prev')!.click();
    c.querySelector<HTMLButtonElement>('.ct-gallery-prev')!.click();
    expect(counter(c)).toBe('3 / 3'); // wrapped
  });

  it('steps with ArrowLeft/ArrowRight on the focused hero', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(3) })]);
    const c = card(view.boardEl, 'a');
    const media = c.querySelector<HTMLElement>('.ct-gallery-media')!;
    expect(media.getAttribute('tabindex')).toBe('0');
    expect(media.getAttribute('role')).toBe('group');
    media.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(counter(c)).toBe('2 / 3');
    media.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    media.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(counter(c)).toBe('3 / 3');
  });

  it('jumps via thumbs, which are real buttons with labels', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(3) })]);
    const c = card(view.boardEl, 'a');
    const thumb = c.querySelector<HTMLButtonElement>('.ct-gallery-thumb[data-i="2"]')!;
    expect(thumb.tagName).toBe('BUTTON');
    expect(thumb.getAttribute('aria-label')).toBe('Show image 3 of 3');
    thumb.click();
    expect(counter(c)).toBe('3 / 3');
  });

  it('keeps the stepped position across a full re-render', () => {
    const h = makeHarness([makeThread('a', { images: imgs(4) })]);
    card(h.view.boardEl, 'a').querySelector<HTMLButtonElement>('.ct-gallery-next')!.click();
    h.view.render();
    expect(counter(card(h.view.boardEl, 'a'))).toBe('2 / 4');
  });

  it('opens the thread from the title link', () => {
    const { view, plugin } = makeHarness([makeThread('a', { images: imgs(1) })]);
    card(view.boardEl, 'a').querySelector<HTMLAnchorElement>('.ct-gallery-title-link')!.click();
    expect(plugin.openThreadInChatView).toHaveBeenCalledWith('a');
  });
});

describe('Gallery mode: image sources and placeholders', () => {
  it('renders a placeholder (same footprint) for a thread without images', () => {
    const { view } = makeHarness([makeThread('none')]);
    const c = card(view.boardEl, 'none');
    expect(c.classList.contains('is-placeholder')).toBe(true);
    expect(c.querySelector('.ct-gallery-ph-tag')?.textContent).toBe('No images yet');
    expect(c.querySelector('.ct-gallery-ph-excerpt')?.textContent).toContain('last words of none');
    expect(c.querySelectorAll('.ct-gallery-strip li')).toHaveLength(3);
    expect(c.querySelector('img')).toBeNull();
  });

  it('never resolves or renders images for private threads', () => {
    const { view } = makeHarness([makeThread('priv', { private: true, images: imgs(3) })]);
    const c = card(view.boardEl, 'priv');
    expect(c.classList.contains('is-placeholder')).toBe(true);
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('.ct-gallery-ph-tag')?.textContent).toMatch(/private/i);
  });

  it('excludes user-uploaded images', () => {
    const t = makeThread('u');
    t.messages.push({ id: 'um', role: 'user', content: 'see', timestamp: 1, images: [{ base64: 'AAA', mediaType: 'image/png', name: 'x.png', path: 'att/user.png' }] } as ChatMessage);
    const { view } = makeHarness([t]);
    expect(card(view.boardEl, 'u').classList.contains('is-placeholder')).toBe(true);
  });

  it('includes pending (not yet attached) images as the newest', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(1) })], { pending: { a: [{ mediaType: 'image/png', data: 'QUJD' }] } });
    const c = card(view.boardEl, 'a');
    expect(counter(c)).toBe('1 / 2');
    expect(hero(c).getAttribute('src')).toBe('data:image/png;base64,QUJD');
  });

  it('shows "Image unavailable" when the image fails to load, and still steps', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(2) })]);
    const c = card(view.boardEl, 'a');
    hero(c).dispatchEvent(new Event('error'));
    expect(c.querySelector('.ct-gallery-media')!.classList.contains('is-broken')).toBe(true);
    expect(c.querySelector('.ct-gallery-unavailable')?.textContent).toBe('Image unavailable');
    c.querySelector<HTMLButtonElement>('.ct-gallery-next')!.click();
    expect(counter(c)).toBe('2 / 2');
    expect(c.querySelector('.ct-gallery-media')!.classList.contains('is-broken')).toBe(false);
  });
});

describe('Gallery mode: thumbnails', () => {
  it('uses the thumb sidecar in the filmstrip when present, full image for the hero', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(2, 'a', { thumbPath: 'att/t.thumb.webp' }) })]);
    const c = card(view.boardEl, 'a');
    expect(hero(c).getAttribute('src')).toBe('res://att/a-1.png');
    const srcs = Array.from(c.querySelectorAll('.ct-gallery-thumb img')).map((i) => i.getAttribute('src'));
    expect(srcs).toEqual(['res://att/t.thumb.webp', 'res://att/t.thumb.webp']);
  });

  it('falls back to the full image for the thumb when the sidecar fails to load', () => {
    const { view } = makeHarness([makeThread('a', { images: imgs(1, 'a', { thumbPath: 'att/t.thumb.webp' }) })]);
    const t = card(view.boardEl, 'a').querySelector<HTMLImageElement>('.ct-gallery-thumb img')!;
    t.dispatchEvent(new Event('error'));
    expect(t.getAttribute('src')).toBe('res://att/a-0.png');
  });

  it('lazily backfills thumbnails for visible cards, then swaps the thumb src', async () => {
    const h = makeHarness([makeThread('a', { images: imgs(1) })]);
    h.ensureImageThumbnail.mockResolvedValue('att/new.thumb.webp');
    h.view.render();
    expect(h.ensureImageThumbnail).toHaveBeenCalledWith('a', 'a-m1', 0, 'res://att/a-0.png');
    await Promise.resolve(); await Promise.resolve();
    expect(card(h.view.boardEl, 'a').querySelector('.ct-gallery-thumb img')!.getAttribute('src')).toBe('res://att/new.thumb.webp');
  });

  it('keeps the full image when backfill fails', async () => {
    const h = makeHarness([makeThread('a', { images: imgs(1) })]);
    await Promise.resolve();
    expect(card(h.view.boardEl, 'a').querySelector('.ct-gallery-thumb img')!.getAttribute('src')).toBe('res://att/a-0.png');
  });
});

describe('Gallery mode: lazy loading', () => {
  function mockObserver() {
    const state: { cb?: (el: Element, visible: boolean) => void; observed: Element[]; disconnected: number } = { observed: [], disconnected: 0 };
    const factory: VisibilityObserverFactory = (cb) => {
      state.cb = cb;
      return { observe: (el) => { state.observed.push(el); }, unobserve() {}, disconnect: () => { state.disconnected++; } };
    };
    return { state, factory };
  }

  it('sets src only once a card is near the viewport and clears it when far away', () => {
    const { state, factory } = mockObserver();
    const { view } = makeHarness([makeThread('a', { images: imgs(2) })], { observer: factory });
    const c = card(view.boardEl, 'a');
    expect(state.observed).toContain(c);
    expect(hero(c).getAttribute('src')).toBeNull();
    expect(c.querySelector('.ct-gallery-thumb img')!.getAttribute('src')).toBeNull();
    expect(hero(c).getAttribute('loading')).toBe('lazy');
    expect(hero(c).getAttribute('decoding')).toBe('async');

    state.cb!(c, true);
    expect(hero(c).getAttribute('src')).toBe('res://att/a-1.png');
    expect(c.querySelector('.ct-gallery-thumb img')!.getAttribute('src')).not.toBeNull();

    state.cb!(c, false);
    expect(hero(c).getAttribute('src')).toBeNull();
    expect(c.querySelector('.ct-gallery-thumb img')!.getAttribute('src')).toBeNull();
  });

  it('hands the board element to the observer factory as the scroll root', () => {
    const roots: Array<Element | null | undefined> = [];
    const factory: VisibilityObserverFactory = (_cb, root) => { roots.push(root); return { observe() {}, disconnect() {} }; };
    const { view } = makeHarness([makeThread('a', { images: imgs(1) })], { observer: factory });
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(view.boardEl.querySelector('.ct-gallery-board'));
  });

  it('does not backfill thumbnails for cards that were never visible', () => {
    const { factory } = mockObserver();
    const { ensureImageThumbnail } = makeHarness([makeThread('a', { images: imgs(2) })], { observer: factory });
    expect(ensureImageThumbnail).not.toHaveBeenCalled();
  });

  it('disconnects the observer on re-render', () => {
    const { state, factory } = mockObserver();
    const { view } = makeHarness([makeThread('a', { images: imgs(1) })], { observer: factory });
    view.render();
    expect(state.disconnected).toBeGreaterThanOrEqual(1);
  });
});
