/**
 * @vitest-environment jsdom
 *
 * `[[thread:<id>|Title]]` is handled by the SHARED renderer, not by one host: a surface supplies `resolveThread` (which
 * threads it knows) and `openThread` (what a click does). Before this, only the dock pre-rewrote the marker, so on the
 * main view the generic wikilink pass produced `a.internal-link[data-href="thread:<id>"]` and a click went to the vault
 * note opener (`openLinkText("thread:<id>")`), which opens nothing.
 *
 * Uses the real renderMarkdown with a ThreadsView-style host (resolveThread over every thread, openThread spy).
 */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../../src/messageRenderer/renderMarkdown';
import type { MessageRenderHost } from '../../src/messageRenderer/types';
import { resolveThreadLink } from '../../src/orchestratorDockModel';

const ID = '6d6adffa-1111-4222-8333-444455556666';
const OTHER = 'aaaaaaaa-1111-4222-8333-444455556666';
const THREADS = [{ id: ID, title: 'Portfolio orchestrator scope release' }, { id: OTHER, title: 'Other thread' }];

function makeHost(over: Partial<MessageRenderHost> = {}) {
  const openLinkText = vi.fn();
  const openThread = vi.fn();
  const host: MessageRenderHost = {
    signal: new AbortController().signal,
    threadId: () => undefined,
    getThread: () => undefined,
    sourcePath: () => 'note.md',
    openLinkText,
    confirmOutsideVault: () => {},
    vaultHas: () => false,
    visualize: { enabled: false, streamingAware: true, hydrate: () => {} },
    resolveThread: (ref, label) => resolveThreadLink(ref, label, THREADS),
    openThread,
    ...over,
  };
  return { host, openLinkText, openThread };
}

async function render(markdown: string, host: MessageRenderHost): Promise<HTMLElement> {
  const el = document.createElement('div');
  await renderMarkdown(markdown, el, host);
  return el;
}

describe('thread links in the shared renderer', () => {
  it('a click opens the thread by id and never reaches the vault-note opener', async () => {
    const { host, openLinkText, openThread } = makeHost();
    const el = await render(`See [[thread:${ID}|Portfolio orchestrator scope release]] now.`, host);
    const a = el.querySelector<HTMLAnchorElement>('a.internal-link[data-href^="thread:"]');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('data-href')).toBe(`thread:${ID}`);
    a!.click();
    expect(openThread).toHaveBeenCalledWith(ID);
    expect(openLinkText).not.toHaveBeenCalled();
  });

  it('a renamed thread opens by id even when the label differs from the title', async () => {
    const { host, openThread } = makeHost();
    const el = await render(`[[thread:${ID}|Old name]]`, host);
    const a = el.querySelector<HTMLAnchorElement>('a.internal-link')!;
    expect(a.textContent).toBe('Old name');
    a.click();
    expect(openThread).toHaveBeenCalledWith(ID);
  });

  it('a marker without an alias is labelled with the thread title', async () => {
    const { host } = makeHost();
    const el = await render(`[[thread:${ID}]]`, host);
    expect(el.querySelector('a.internal-link')!.textContent).toBe('Portfolio orchestrator scope release');
  });

  it('an unresolvable id renders the plain label with no anchor', async () => {
    const { host, openThread } = makeHost();
    const el = await render('Gone: [[thread:deadbeef-0000|Archived thing]] ok', host);
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('Gone: Archived thing ok');
    expect(openThread).not.toHaveBeenCalled();
  });

  it('an unresolvable marker without an alias renders the ref as text', async () => {
    const { host } = makeHost();
    const el = await render('[[thread:deadbeef-0000]]', host);
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('deadbeef-0000');
  });

  it('a host without resolveThread (mobile) renders plain text and no anchor', async () => {
    const { host } = makeHost({ resolveThread: undefined, openThread: undefined });
    const el = await render(`[[thread:${ID}|Some title]]`, host);
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('Some title');
  });

  it('escapes markdown and HTML metacharacters in the label', async () => {
    const { host, openThread } = makeHost();
    const el = await render(`[[thread:${ID}|Fix #12 *now* <b>x</b> & more]]`, host);
    const a = el.querySelector<HTMLAnchorElement>('a.internal-link')!;
    expect(a.textContent).toBe('Fix #12 *now* <b>x</b> & more');
    expect(a.querySelector('b, em')).toBeNull();
    expect(el.querySelector('h1,h2,h3')).toBeNull();
    a.click();
    expect(openThread).toHaveBeenCalledWith(ID);
  });

  it('works inside **bold**', async () => {
    const { host, openThread } = makeHost();
    const el = await render(`**see [[thread:${ID}|Title]] first**`, host);
    const a = el.querySelector<HTMLAnchorElement>('strong a.internal-link')!;
    expect(a).not.toBeNull();
    a.click();
    expect(openThread).toHaveBeenCalledWith(ID);
  });

  it('works in a GFM table cell with an escaped pipe', async () => {
    const { host, openThread } = makeHost();
    const md = ['| Thread | State |', '| - | - |', `| [[thread:${ID}\\|Table title]] | running |`].join('\n');
    const el = await render(md, host);
    const a = el.querySelector<HTMLAnchorElement>('td a.internal-link')!;
    expect(a).not.toBeNull();
    expect(a.textContent).toBe('Table title');
    a.click();
    expect(openThread).toHaveBeenCalledWith(ID);
  });

  it('a marker spanning a newline is not a thread link', async () => {
    const { host } = makeHost();
    const el = await render(`[[thread:${ID}|Split\nlabel]]`, host);
    expect(el.querySelector('a[data-href^="thread:"]')).toBeNull();
  });

  it('a pre-rewritten dock marker still resolves by id', async () => {
    const { host, openThread } = makeHost();
    const el = await render(`[[thread:${OTHER}|Other thread]]`, host);
    el.querySelector<HTMLAnchorElement>('a.internal-link')!.click();
    expect(openThread).toHaveBeenCalledWith(OTHER);
  });

  it('a thread: href never falls through to openLinkText even when the host has no openThread', async () => {
    const { host, openLinkText } = makeHost({ openThread: undefined });
    const el = await render(`[[thread:${ID}|Title]]`, host);
    el.querySelector<HTMLAnchorElement>('a.internal-link')!.click();
    expect(openLinkText).not.toHaveBeenCalled();
  });

  it('ordinary wikilinks still go to openLinkText', async () => {
    const { host, openLinkText, openThread } = makeHost();
    const el = await render('Read [[Some Note]] and [[Folder/Other|alias]].', host);
    const links = el.querySelectorAll<HTMLAnchorElement>('a.internal-link');
    expect(links).toHaveLength(2);
    links[0].click();
    links[1].click();
    expect(openLinkText).toHaveBeenNthCalledWith(1, 'Some Note', 'note.md');
    expect(openLinkText).toHaveBeenNthCalledWith(2, 'Folder/Other', 'note.md');
    expect(openThread).not.toHaveBeenCalled();
  });
});
