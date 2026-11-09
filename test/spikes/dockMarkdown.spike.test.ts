// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderDockMarkdown } from '../../src/dockMarkdown';

describe('S1 dockMarkdown in isolation', () => {
  const render = async (md: string) => {
    const el = document.createElement('div');
    await renderDockMarkdown(md, el);
    return el;
  };
  it('renders markdown + GFM table', async () => {
    const el = await render('**bold**\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelector('table td')?.textContent).toBe('1');
  });
  it('rewrites [[target|alias]] to internal-link', async () => {
    const a = (await render('see [[Notes/Plan|the plan]]')).querySelector('a.internal-link')!;
    expect(a.getAttribute('data-href')).toBe('Notes/Plan');
    expect(a.textContent).toBe('the plan');
  });
  it('rewrites [[thread:id|Title]] to anchor with data-thread-id (no internal-link)', async () => {
    const el = await render('Check [[thread:abc-123|Deploy <fix> & go]] now');
    const a = el.querySelector('a[data-thread-id]')!;
    expect(a.getAttribute('data-thread-id')).toBe('abc-123');
    expect(a.textContent).toBe('Deploy <fix> & go');
    expect(a.classList.contains('internal-link')).toBe(false);
    expect(el.querySelector('a.internal-link')).toBeNull();
  });
  it('mock sanitizeHTMLToDom does NOT sanitize (real Obsidian does)', async () => {
    const el = await render('<img src=x onerror="1">');
    expect(el.querySelector('img')?.getAttribute('onerror')).toBe('1');
  });
});
