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

describe('rewriteDockMarkup', () => {
  it('is pure and leaves plain text alone', () => {
    expect(rewriteDockMarkup('no links here')).toBe('no links here');
  });
});
