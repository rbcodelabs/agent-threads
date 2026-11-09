/**
 * dock-markdown.test.ts
 * @vitest-environment jsdom
 *
 * dockMarkdown: marked + sanitizeHTMLToDom for the reply sheet. The obsidian mock's
 * sanitizeHTMLToDom does NOT sanitize (see spike S1), so these tests prove link
 * rewriting and that model-controlled labels never reach the DOM as markup.
 */
import '../setup/obsidian-dom';
import { describe, it, expect } from 'vitest';
import { renderDockMarkdown, rewriteDockMarkup } from '../../src/dockMarkdown';

const threads = [{ id: 't1', title: 'Deploy curation' }, { id: 't2', title: 'Mobile polish' }];
async function render(md: string): Promise<HTMLElement> {
  const el = document.createElement('div');
  await renderDockMarkdown(md, el, { threads });
  return el;
}

describe('renderDockMarkdown', () => {
  it('renders ordinary markdown (bold, lists, GFM tables)', async () => {
    const el = await render('**bold**\n\n- a\n- b\n\n| h |\n|---|\n| c |');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('table td')?.textContent).toBe('c');
  });

  it('[[thread:id|Title]] becomes a.ct-thread-link[data-thread-id] with the label as text', async () => {
    const el = await render('See [[thread:t1|Deploy fix]] now');
    const a = el.querySelector('a.ct-thread-link') as HTMLAnchorElement;
    expect(a.getAttribute('data-thread-id')).toBe('t1');
    expect(a.textContent).toBe('Deploy fix');
    expect(a.classList.contains('internal-link')).toBe(false);
  });

  it('resolves a thread link by exact title when the ref is not an id', async () => {
    const el = await render('[[thread:Mobile polish]]');
    expect((el.querySelector('a.ct-thread-link') as HTMLElement).getAttribute('data-thread-id')).toBe('t2');
  });

  it('labels are model-controlled: markup in a label is text, never an element', async () => {
    const el = await render('[[thread:t1|<img src=x onerror=alert(1)> & <b>go</b>]]');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('a.ct-thread-link')?.textContent).toBe('<img src=x onerror=alert(1)> & <b>go</b>');
  });

  it('markdown punctuation in a label stays literal (not parsed as emphasis)', async () => {
    const el = await render('[[thread:t1|*raw* _label_]]');
    expect(el.querySelector('em')).toBeNull();
    expect(el.querySelector('a.ct-thread-link')?.textContent).toBe('*raw* _label_');
  });

  it('an unresolvable thread link degrades to plain label text', async () => {
    const el = await render('see [[thread:nope|Gone]] ok');
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('see Gone ok');
  });

  it('a thread link inside bold and inside a table cell (escaped pipe) survives', async () => {
    const bold = await render('**see [[thread:t1|Deploy]]**');
    expect(bold.querySelector('strong a.ct-thread-link')).toBeTruthy();
    const table = await render('| a |\n|---|\n| [[thread:t1\\|Deploy]] |');
    expect(table.querySelector('td a.ct-thread-link')?.textContent).toBe('Deploy');
  });

  it('[[note|alias]] becomes a.internal-link[data-href]', async () => {
    const el = await render('[[Projects/Plan|the plan]]');
    const a = el.querySelector('a.internal-link') as HTMLElement;
    expect(a.getAttribute('data-href')).toBe('Projects/Plan');
    expect(a.textContent).toBe('the plan');
  });

  it('does not leave the transport attribute on anchors', async () => {
    const el = await render('[[thread:t1|Deploy]] [[Note]]');
    expect(el.querySelector('[data-label]')).toBeNull();
  });
});

describe('review: code is literal (A3)', () => {
  it('a thread link inside inline code or a fenced block stays literal text', async () => {
    const el = await render('use `[[thread:t1|Deploy]]` here\n\n```\n[[thread:t1|Deploy]]\n[[Note]]\n```\n\nand [[thread:t1|Deploy]] outside');
    expect(el.querySelectorAll('a.ct-thread-link')).toHaveLength(1);
    expect(el.querySelector('code')!.textContent).toContain('[[thread:t1|Deploy]]');
    expect(el.querySelector('pre')!.textContent).toContain('[[Note]]');
    expect(el.querySelector('a.internal-link')).toBeNull();
  });
  it('a table-cell link outside code still works', async () => {
    const el = await render('| a | b |\n|---|---|\n| `[[Note]]` | [[thread:t1\\|Deploy]] |');
    const cells = el.querySelectorAll('td');
    expect(cells[0].querySelector('a')).toBeNull();
    expect(cells[1].querySelector('a.ct-thread-link')).toBeTruthy();
  });
});

describe('review: untrusted content posture (A12)', () => {
  it('images (markdown and raw) never load: they become plain text links', async () => {
    const el = await render('![pic](https://evil.example/x.png) and <img src="https://evil.example/y.png" alt="raw">');
    expect(el.querySelector('img')).toBeNull();
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://evil.example/x.png');
    expect(el.textContent).toContain('pic');
  });
  it('a model-authored raw thread anchor is honoured only for an id that exists', async () => {
    const el = await render('<a class="ct-thread-link" data-thread-id="t2" href="#">ok</a> <a class="ct-thread-link" data-thread-id="nope" href="#">bad</a>');
    const anchors = [...el.querySelectorAll('a.ct-thread-link')];
    expect(anchors.map((a) => a.getAttribute('data-thread-id'))).toEqual(['t2']);
    expect(el.textContent).toContain('bad');
  });
  it('script / iframe / style elements are removed even if the sanitizer lets them through', async () => {
    const el = await render('x <script>alert(1)</script><iframe src="https://e.example"></iframe><style>a{}</style> y');
    expect(el.querySelector('script, iframe, style')).toBeNull();
  });
  it('an unresolvable wikilink renders as inert text when a resolver says so', async () => {
    const el = document.createElement('div');
    await renderDockMarkdown('[[Ghost]] [[Real]]', el, { threads, resolveLink: (h) => h === 'Real' });
    expect(el.querySelectorAll('a.internal-link')).toHaveLength(1);
    expect(el.querySelector('.ct-orch-wikilink-unresolved')!.textContent).toBe('Ghost');
  });
});

describe('rewriteDockMarkup', () => {
  it('is pure and leaves plain text alone', () => {
    expect(rewriteDockMarkup('no links here')).toBe('no links here');
  });
});
