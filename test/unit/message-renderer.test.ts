/**
 * @vitest-environment jsdom
 *
 * Unit tests for the shared, host-injected markdown renderer
 * (src/messageRenderer). The module has no view state: everything a surface
 * differs on (link routing, vault lookup, visualize/message-content hydration,
 * remote images) comes in through MessageRenderHost, so it is driven here with
 * a plain stub host. Broader behavior preservation is covered by the
 * ThreadsView/MobileView golden tests.
 */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';
import { linkifyUrls, renderMarkdown, type MessageRenderHost } from '../../src/messageRenderer';

function makeHost(overrides: Partial<MessageRenderHost> = {}) {
  const calls: string[] = [];
  const host: MessageRenderHost = {
    signal: new AbortController().signal,
    threadId: () => 'thread-1',
    getThread: () => undefined,
    sourcePath: () => 'Threads/t.md',
    openLinkText: (target, sourcePath) => { calls.push(`open(${target}|${sourcePath ?? "-"})`); },
    openExternal: (href, force) => { calls.push(`external(${href}|${force})`); },
    confirmOutsideVault: (href) => { calls.push(`outside(${href})`); },
    vaultHas: (p) => p === 'Notes/abs.md',
    visualize: { enabled: true, streamingAware: true, hydrate: () => {} },
    ...overrides,
  };
  return { host, calls };
}

async function render(md: string, host: MessageRenderHost, opts = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await renderMarkdown(md, el, host, opts);
  return el;
}

describe('renderMarkdown (shared)', () => {
  it('wraps GFM tables in a scroll container', async () => {
    const { host } = makeHost();
    const el = await render('| a | b |\n| - | - |\n| 1 | 2 |', host);
    expect(el.querySelector('.ct-table-scroll > table')).not.toBeNull();
  });

  it('routes wikilinks through host.openLinkText with the thread note as source', async () => {
    const { host, calls } = makeHost();
    const el = await render('see [[Project Plan]]', host);
    el.querySelector<HTMLAnchorElement>('a.internal-link')!.click();
    expect(calls).toEqual(['open(Project Plan|Threads/t.md)']);
  });

  it('resolves absolute vault hrefs on click and refuses unmapped absolute paths', async () => {
    const { host, calls } = makeHost();
    const el = await render('[a](/Users/x/Vault/Notes/abs.md#H%20One) [b](/etc/hosts)', host);
    const [a, b] = Array.from(el.querySelectorAll<HTMLAnchorElement>('a'));
    a.click(); b.click();
    expect(calls).toEqual(['open(Notes/abs.md#H One|Threads/t.md)', 'outside(/etc/hosts)']);
  });

  it('sends http(s) clicks to host.openExternal, honoring the Cmd modifier', async () => {
    const { host, calls } = makeHost();
    const el = await render('[s](https://example.com) and `https://code.example.com`', host);
    const [a] = Array.from(el.querySelectorAll<HTMLAnchorElement>('a'));
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(calls).toEqual(['external(https://example.com|true)']);
    expect(el.querySelector('code a.ct-auto-link')).not.toBeNull();
  });

  it('attaches no external handler and no bare-URL linkify when the host has no openExternal', async () => {
    const { host, calls } = makeHost({ openExternal: undefined });
    const el = await render('[s](https://example.com) and `https://code.example.com`', host);
    const a = el.querySelector<HTMLAnchorElement>('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    expect(el.querySelector('a.ct-auto-link')).toBeNull();
  });

  it('linkifies bridge paths only when the vault copy exists', async () => {
    const { host, calls } = makeHost({
      bridges: () => [{ id: 'b', name: 'B', repoPath: '/Users/t/repo', sourcePath: '', vaultPath: 'Bridge', branch: 'main', autoSync: true, status: 'ok' }],
      vaultHas: (p) => p === 'Bridge/src/a.ts',
    });
    const el = await render('/Users/t/repo/src/a.ts and /Users/t/repo/src/b.ts', host);
    const links = el.querySelectorAll<HTMLAnchorElement>('a.internal-link');
    expect(links).toHaveLength(1);
    links[0].click();
    expect(calls).toEqual(['open(Bridge/src/a.ts|-)']);
  });

  it('hands visualize markers to the host, interactive only when settled', async () => {
    const hydrate = vi.fn();
    const { host } = makeHost({ visualize: { enabled: true, streamingAware: true, hydrate } });
    const md = 'visualize{"path":"/tmp/v.html"}';
    await render(md, host);
    await render(md, host, { streaming: true });
    expect(hydrate.mock.calls[0][2]).toEqual({ interactive: true });
    expect(hydrate.mock.calls[1][2]).toEqual({ interactive: false });
    expect(hydrate.mock.calls[0][1]).toHaveLength(1);
  });

  it('leaves visualize lines untouched when the host disables them', async () => {
    const hydrate = vi.fn();
    const { host } = makeHost({ visualize: { enabled: false, streamingAware: true, hydrate } });
    const el = await render('visualize{"path":"/tmp/v.html"}', host);
    expect(el.textContent).toContain('visualize');
    expect(el.querySelector('.ct-visualize-slot')).toBeNull();
  });

  it('hydrates contributed message content only for a matching assistant transcript message', async () => {
    const { formatMessageContentReference } = await import('../../src/MessageContent');
    const md = formatMessageContentReference({ providerId: 'example.cards', id: 'x', schemaVersion: 1, title: 'T', data: {} });
    const hydrateMessageContent = vi.fn();
    const { host } = makeHost({
      getThread: () => ({ messages: [{ id: 'a', role: 'assistant', content: md, timestamp: 1 }, { id: 'u', role: 'user', content: md, timestamp: 1 }] }),
      hydrateMessageContent,
    });
    await render(md, host, { messageId: 'u' });
    expect(hydrateMessageContent.mock.calls[0][1]).toEqual([]);
    await render(md, host, { messageId: 'a' });
    expect(hydrateMessageContent.mock.calls[1][1]).toHaveLength(1);
    expect(hydrateMessageContent.mock.calls[1][2]).toMatchObject({ threadId: 'thread-1', messageId: 'a' });
    await render(md, host, { streaming: true });
    expect(hydrateMessageContent.mock.calls[2][2]).toMatchObject({ messageId: 'streaming' });
  });

  it('always extracts message content when the host asks (relay clients)', async () => {
    const { formatMessageContentReference } = await import('../../src/MessageContent');
    const md = formatMessageContentReference({ providerId: 'example.cards', id: 'x', schemaVersion: 1, title: 'T', data: {} });
    const hydrateMessageContent = vi.fn();
    const { host } = makeHost({ alwaysExtractMessageContent: true, hydrateMessageContent });
    await render(md, host);
    expect(hydrateMessageContent.mock.calls[0][1]).toHaveLength(1);
  });

  it('takes over remote-image srcs with the host loader', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AAAA');
    const { host } = makeHost({ remoteImageLoader: () => load });
    const el = await render('![x](/remote/pic.png)', host);
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('/remote/pic.png'));
    expect(el.querySelector('img.ct-remote-img')).not.toBeNull();
  });
});

describe('linkifyUrls (shared)', () => {
  it('turns bare URLs into anchors routed to the supplied opener', () => {
    const open = vi.fn();
    const p = document.createElement('p');
    p.textContent = 'see https://github.com/a/b now';
    linkifyUrls(p, open);
    p.querySelector<HTMLAnchorElement>('a.ct-auto-link')!.click();
    expect(open).toHaveBeenCalledWith('https://github.com/a/b', false);
  });
});
