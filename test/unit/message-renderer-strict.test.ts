/**
 * @vitest-environment jsdom
 *
 * The strict link policy of the shared renderer (the dock's posture: inert
 * parsed tree, prose-only allowlist, tokenised links, no remote images).
 * Parity with the legacy renderDockMarkdown is asserted case by case, and the
 * recorded dock-markdown golden pins the absolute output.
 */
import '../setup/obsidian-dom';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/messageRenderer';
import { renderDockMarkdown } from '../../src/dockMarkdown';
import { dumpDom } from '../helpers/domDump';
import { DOCK_CASES, DOCK_RESOLVABLE, DOCK_THREADS } from '../fixtures/dockMarkdownCases';

async function strict(md: string, extra: Record<string, unknown> = {}): Promise<HTMLElement> {
  const el = document.createElement('div');
  await renderMarkdown(md, el, undefined, {
    linkPolicy: 'strict', threadRefs: DOCK_THREADS, resolveLink: (h: string) => DOCK_RESOLVABLE.has(h), ...extra,
  });
  return el;
}

describe('renderMarkdown linkPolicy "strict"', () => {
  for (const [name, md] of Object.entries(DOCK_CASES)) {
    it(`matches the legacy dock output: ${name}`, async () => {
      const legacy = document.createElement('div');
      await renderDockMarkdown(md, legacy, { threads: DOCK_THREADS, resolveLink: (h) => DOCK_RESOLVABLE.has(h) });
      expect(dumpDom(await strict(md))).toBe(dumpDom(legacy));
    });
  }

  it('builds thread anchors from its own token list, with the label as text', async () => {
    const el = await strict(DOCK_CASES.labelMarkup);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a.ct-thread-link')?.textContent).toBe('<img src=x onerror=alert(1)> & <b>go</b>');
  });

  it('turns remote images into links and local images into omitted text', async () => {
    const el = await strict(DOCK_CASES.images);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a[href="https://example.com/pic.png"]')).not.toBeNull();
    expect(el.querySelector('.ct-orch-image-omitted')).not.toBeNull();
  });

  it('drops unsafe hrefs and keeps http, mailto, relative and anchors', async () => {
    const el = await strict(DOCK_CASES.hrefs);
    const hrefs = Array.from(el.querySelectorAll('a')).map(a => a.getAttribute('href'));
    expect(hrefs).toEqual([null, null, null, null, null, '%5Cevil.example', 'docs/a.md#h', '#top', 'https://ok.example/p', 'mailto:a@b.co']);
  });

  it('never leaks a link token: attributes are scrubbed or hold the literal text', async () => {
    const el = await strict(DOCK_CASES.tokenInAttribute);
    expect(el.innerHTML).not.toContain('ctlnk');
    expect(el.querySelector('a[title]')).toBeNull();
    expect(el.querySelector('a[href^="https://y.example"]')?.getAttribute('href')).toBe('https://y.example/[[Project Plan]]');
  });

  it('keeps wikilinks inside code literal and wraps tables', async () => {
    const code = await strict(DOCK_CASES.code);
    expect(code.querySelector('code')?.textContent).toBe('[[Project Plan]]');
    expect(code.querySelectorAll('a.internal-link')).toHaveLength(1);
    expect((await strict(DOCK_CASES.gfm)).querySelector('.ct-table-scroll > table')).not.toBeNull();
  });

  it('with streaming, raw HTML is shown as text and never becomes an element', async () => {
    const el = await strict('<img src=x onerror=alert(1)> and **bold**', { streaming: true });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
  });

  it('needs no host in strict mode, and the trusted default still needs one', async () => {
    await expect(renderMarkdown('x', document.createElement('div'), undefined, {})).rejects.toThrow(/host/i);
  });
});
