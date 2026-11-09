/**
 * dock-markdown.test.ts
 * @vitest-environment jsdom
 *
 * dockMarkdown: marked + sanitizeHTMLToDom for the reply sheet. The obsidian mock's
 * sanitizeHTMLToDom does NOT sanitize (see spike S1), so these tests prove link
 * rewriting and that model-controlled labels never reach the DOM as markup.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect } from 'vitest';
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
  it('a model-authored raw anchor is NEVER a thread link, classed or not, known id or not (delta B2)', async () => {
    const el = await render('<a class="ct-thread-link" data-thread-id="t2" href="#">classed</a> <a data-thread-id="t1" href="#">unclassed</a> <a class="internal-link" data-href="Secret" href="#">wiki</a> <a data-thread-id="nope" data-label="x" href="#">unknown</a>');
    expect(el.querySelectorAll('a.ct-thread-link, a.internal-link')).toHaveLength(0);
    expect(el.querySelectorAll('[data-thread-id], [data-href], [data-label]')).toHaveLength(0);
    expect(el.textContent).toContain('classed');
    expect(el.textContent).toContain('unclassed');
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

describe('delta B3: allowlist after sanitising (defence in depth; the real sanitizeHTMLToDom was not run)', () => {
  const html = [
    '<video poster="https://x.example/p.png" src="https://x.example/v.mp4"></video>',
    '<picture><source srcset="https://x.example/a.png 1x"><img src="https://x.example/b.png"></picture>',
    '<svg><image href="https://x.example/c.png"></image></svg>',
    '<p style="background:url(https://x.example/d.png)" onclick="alert(1)" background="https://x.example/e.png">styled</p>',
    '<img src="https://x.example/f.png" alt="pic">',
    '<iframe src="https://x.example"></iframe><object data="https://x.example"></object><embed src="https://x.example">',
    '<link rel="stylesheet" href="https://x.example/s.css"><style>p{background:url(https://x.example/g.png)}</style>',
    '<audio src="https://x.example/a.mp3"></audio><input value="x"><button>b</button><form action="https://x.example"></form>',
    '<a href="javascript:alert(1)" onmouseover="x()">js</a> <a href="https://ok.example/page">ok</a>',
  ].join('\n');

  it('removes every element outside the prose set', async () => {
    const el = await render(html);
    for (const sel of ['video', 'picture', 'source', 'svg', 'image', 'img', 'iframe', 'object', 'embed', 'link', 'style', 'audio', 'input', 'button', 'form', 'script']) {
      expect(el.querySelector(sel), sel).toBeNull();
    }
    expect(el.textContent).toContain('styled');
  });

  it('strips src, srcset, poster, background, style and on* from everything that is left', async () => {
    const el = await render(html);
    for (const attr of ['src', 'srcset', 'poster', 'background', 'style', 'onclick', 'onmouseover']) {
      expect(el.querySelector(`[${attr}]`), attr).toBeNull();
    }
    for (const node of el.querySelectorAll('*')) {
      expect([...node.attributes].some((a) => a.name.startsWith('on')), node.tagName).toBe(false);
    }
  });

  it('keeps ordinary prose: headings, lists, tables, code, blockquote, links with a safe href', async () => {
    const el = await render('# T\n\n> quote\n\n- a\n- b\n\n`c`\n\n[ok](https://ok.example/page)\n\n| h |\n|---|\n| v |');
    for (const sel of ['h1', 'blockquote', 'ul li', 'code', 'table td']) expect(el.querySelector(sel), sel).toBeTruthy();
    expect(el.querySelector('a')!.getAttribute('href')).toBe('https://ok.example/page');
  });

  it('a javascript: href is dropped', async () => {
    const el = await render('[bad](javascript:alert(1))');
    const a = el.querySelector('a');
    expect(a?.getAttribute('href') ?? null).toBeNull();
  });
});

describe('N3: nothing remote ever touches the live DOM (an inert tree does all the stripping)', () => {
  it('the sanitizer (and so the live container) only ever sees allowlisted, remote-free HTML', async () => {
    const obsidian = await import('obsidian');
    const spy = vi.spyOn(obsidian, 'sanitizeHTMLToDom');
    const el = document.createElement('div');
    await renderDockMarkdown('![x](https://evil.example/a.png)\n\n<img src="https://evil.example/b.png">\n\n<video poster="https://evil.example/p.png"></video><picture><source srcset="https://evil.example/s.png 1x"></picture><svg><image href="https://evil.example/i.png"/></svg><p style="background:url(https://evil.example/bg.png)">t</p>', el, { threads });
    expect(spy).toHaveBeenCalled();
    const seen = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(seen).not.toMatch(/<(img|video|picture|source|svg|image)\b/i);
    expect(seen).not.toMatch(/\b(src|srcset|poster|style|background)=/i);
    expect(el.querySelector('img, video, picture, source, svg, [src], [srcset], [poster], [style]')).toBeNull();
    spy.mockRestore();
  });
});

describe('delta (a): code detection edge cases', () => {
  it('a fence-like inline span (```code```) does not swallow the rest of the document', async () => {
    const el = await render('```code``` then\n\n[[thread:t1|Deploy]] after');
    expect(el.querySelector('a.ct-thread-link')).toBeTruthy();
  });
  it('4-space indented code after a blank line skips the wikilink rewrite', async () => {
    const el = await render('text\n\n    [[thread:t1|Deploy]]\n    [[Note]]\n\nand [[thread:t2|Mobile]]');
    expect(el.querySelectorAll('a.ct-thread-link')).toHaveLength(1);
    expect(el.querySelector('pre')!.textContent).toContain('[[thread:t1|Deploy]]');
  });
  it('an unclosed fence runs to the end; a ~~~ fence works too', async () => {
    const el = await render('~~~\n[[Note]]\n~~~\n\n[[thread:t1|Deploy]]\n\n```\n[[thread:t2|Mobile]]');
    expect(el.querySelectorAll('a.ct-thread-link')).toHaveLength(1);
    expect(el.querySelector('a.internal-link')).toBeNull();
  });
  it('a list continuation indented four spaces is still prose (links work)', async () => {
    const el = await render('- item\n\n    [[thread:t1|Deploy]]');
    expect(el.querySelector('a.ct-thread-link')).toBeTruthy();
  });
});

describe('rewriteDockMarkup', () => {
  it('is pure and leaves plain text alone', () => {
    expect(rewriteDockMarkup('no links here')).toBe('no links here');
  });
});
