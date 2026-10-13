/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';

const fake = vi.hoisted(() => ({ callbacks: undefined as SessionCallbacks | undefined }));

vi.mock('../../src/HarnessFactory', () => ({
  createHarnessSession: () => ({
    turnInFlight: false, cwd: undefined,
    start: async (options: { callbacks: SessionCallbacks }) => { fake.callbacks = options.callbacks; },
    send: () => {},
    prepareForSend: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    close: () => {}, interrupt: async () => {}, getContextUsage: async () => null,
    getUsageSnapshot: async () => null,
  }),
}));

const { ThreadManager } = await import('../../src/ThreadManager');
const { ThreadsView } = await import('../../src/ThreadsView');
const { urlChipLabel } = await import('../../src/urlLinks');

beforeEach(() => { fake.callbacks = undefined; });

function thread(): Thread {
  return { id: 't', title: 'T', cwd: os.tmpdir(), sessionGeneration: 1, messages: [], createdAt: 1, updatedAt: 1, status: 'waiting' };
}

function linkify(root: HTMLElement) {
  const openLink = vi.fn();
  (ThreadsView.prototype as unknown as { linkifyUrls(r: HTMLElement): void }).linkifyUrls.call({ openLink }, root);
  return openLink;
}

describe('linkifyUrls (ThreadsView)', () => {
  it('turns a bare URL in a paragraph into an anchor that routes to openLink', () => {
    const p = document.createElement('p');
    p.textContent = 'see https://github.com/a/b for details';
    const openLink = linkify(p);
    const a = p.querySelector<HTMLAnchorElement>('a.ct-auto-link')!;
    expect(a.getAttribute('href')).toBe('https://github.com/a/b');
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openLink).toHaveBeenCalledWith('https://github.com/a/b', false);
    expect(p.textContent).toBe('see https://github.com/a/b for details');
  });

  it('linkifies a URL inside inline code', () => {
    const p = document.createElement('p');
    p.innerHTML = 'run <code>https://example.com/x</code> now';
    linkify(p);
    expect(p.querySelector('code a.ct-auto-link')?.getAttribute('href')).toBe('https://example.com/x');
  });

  it('does not linkify a URL inside a <pre> code block', () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre><code>curl https://example.com/block</code></pre>';
    linkify(root);
    expect(root.querySelector('a')).toBeNull();
  });

  it('does not double-wrap an existing anchor', () => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="https://example.com">https://example.com</a>';
    linkify(root);
    expect(root.querySelectorAll('a')).toHaveLength(1);
    expect(root.querySelector('a.ct-auto-link')).toBeNull();
  });

  it('trims trailing period and unbalanced closing parenthesis', () => {
    const p = document.createElement('p');
    p.textContent = 'Docs (https://example.com/a). Also https://example.com/b.';
    linkify(p);
    const hrefs = [...p.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(p.textContent).toBe('Docs (https://example.com/a). Also https://example.com/b.');
  });

  it('passes the modifier flag through on cmd-click', () => {
    const p = document.createElement('p');
    p.textContent = 'https://example.com';
    const openLink = linkify(p);
    p.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(openLink).toHaveBeenCalledWith('https://example.com', true);
  });
});

describe('ThreadManager records URLs shared by the assistant', () => {
  async function started() {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const t = thread();
    manager.loadThreads([t]);
    const events: Array<{ type: string; paths?: string[] }> = [];
    manager.subscribe((_id: string, e: any) => events.push(e));
    await manager.sendMessage('t', 'hi');
    return { t, events };
  }

  it('saves URLs to linkedUrls and emits files_edited, deduplicated', async () => {
    const { t, events } = await started();
    fake.callbacks!.onMessage('PR: https://github.com/a/b/pull/1. Docs https://example.com/d)', []);
    fake.callbacks!.onMessage('again https://github.com/a/b/pull/1 and https://x.dev', []);
    expect(t.linkedUrls).toEqual(['https://github.com/a/b/pull/1', 'https://example.com/d', 'https://x.dev']);
    expect(t.editedFiles ?? []).toEqual([]);
    expect(events.filter(e => e.type === 'files_edited').map(e => e.paths)).toEqual([
      ['https://github.com/a/b/pull/1', 'https://example.com/d'],
      ['https://x.dev'],
    ]);
  });

  it('caps linkedUrls at 50 entries, keeping the newest', async () => {
    const { t } = await started();
    const many = Array.from({ length: 60 }, (_, i) => `https://e.com/${i}`).join(' ');
    fake.callbacks!.onMessage(many, []);
    expect(t.linkedUrls).toHaveLength(50);
    expect(t.linkedUrls![49]).toBe('https://e.com/59');
  });

  it('does not touch linkedUrls for messages without URLs', async () => {
    const { t, events } = await started();
    fake.callbacks!.onMessage('no links here', []);
    expect(t.linkedUrls).toBeUndefined();
    expect(events.some(e => e.type === 'files_edited')).toBe(false);
  });
});

describe('urlChipLabel', () => {
  it('shows host plus path without scheme or www', () => {
    expect(urlChipLabel('https://github.com/a/b')).toBe('github.com/a/b');
    expect(urlChipLabel('https://www.example.com/')).toBe('example.com');
  });
});
