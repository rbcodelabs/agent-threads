/**
 * @vitest-environment jsdom
 *
 * `[[thread:id|Title]]` in the dock sheet composes with the TRUSTED shared pipeline by pre-rewriting
 * (rewriteThreadLinks) to the renderer's ordinary wikilink anchor `a.internal-link[data-href="thread:<id>"]`.
 * These are the still-valid link assertions of the removed strict-policy tests (dock-markdown.test.ts), ported to that path.
 * What the strict policy additionally enforced (allowlist, no images, token forgery) no longer applies: the sheet renders
 * like the main panel, whose sanitizer is exercised in dock-identical-render.test.ts.
 */
import '../setup/obsidian-dom';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, type MessageRenderHost } from '../../src/messageRenderer';
import { rewriteThreadLinks, threadIdOfHref } from '../../src/orchestratorDockModel';

const THREADS = [{ id: 't1', title: 'Deploy curation' }, { id: 't2', title: 'Mobile polish' }];
const HOST: MessageRenderHost = {
  signal: new AbortController().signal,
  threadId: () => 'orch', getThread: () => undefined, sourcePath: () => '',
  openLinkText: () => {}, confirmOutsideVault: () => {}, vaultHas: () => false,
  visualize: { enabled: false, streamingAware: true, hydrate: () => {} },
};

async function render(md: string): Promise<HTMLElement> {
  const el = document.createElement('div');
  await renderMarkdown(rewriteThreadLinks(md, THREADS), el, HOST);
  return el;
}
const links = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLAnchorElement>('a.internal-link[data-href^="thread:"]')).map((a) => [threadIdOfHref(a.getAttribute('data-href')), a.textContent]);

describe('dock thread links on the trusted pipeline', () => {
  it('[[thread:id|Title]] becomes an internal link carrying the thread id, with the label as text', async () => {
    expect(links(await render('See [[thread:t1|Deploy fix]].'))).toEqual([['t1', 'Deploy fix']]);
  });

  it('resolves by exact title when the ref is not an id, and labels with the thread title when there is no alias', async () => {
    expect(links(await render('[[thread:Mobile polish]] and [[thread:t1]]'))).toEqual([['t2', 'Mobile polish'], ['t1', 'Deploy curation']]);
  });

  it('an unresolvable thread link degrades to its plain label: no anchor', async () => {
    const el = await render('[[thread:unknown|Ghost]] and [[thread:nope]]');
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('Ghost and nope');
  });

  it('labels are model-controlled: markup in a label is text, never an element', async () => {
    const el = await render('[[thread:t1|<img src=x onerror=alert(1)> & <b>go</b>]]');
    expect(el.querySelector('img, b')).toBeNull();
    expect(links(el)).toEqual([['t1', '<img src=x onerror=alert(1)> & <b>go</b>']]);
  });

  it('a thread link inside bold and inside a table cell (escaped pipe) survives', async () => {
    const el = await render('**[[thread:t1|Bold]]**\n\n| a | b |\n| - | - |\n| [[thread:t2\\|Cell]] | x |');
    expect(links(el)).toEqual([['t1', 'Bold'], ['t2', 'Cell']]);
    expect(el.querySelector('strong a.internal-link')).not.toBeNull();
    expect(el.querySelector('td a.internal-link')).not.toBeNull();
  });

  it('a raw model-authored anchor is not a thread link unless it is a real wikilink anchor the renderer made', async () => {
    const el = await render('<a href="#" data-thread-id="t2">raw</a>');
    expect(links(el)).toEqual([]);
  });
});

describe('threadIdOfHref', () => {
  it('reads only the thread: prefix', () => {
    expect(threadIdOfHref('thread:abc')).toBe('abc');
    expect(threadIdOfHref('thread: abc ')).toBe('abc');
    for (const no of ['Plan note', 'thread:', 'Thread:abc', '', null, undefined]) expect(threadIdOfHref(no as string | null)).toBeNull();
  });
});
