/**
 * Deterministic DOM serializer for golden-output tests.
 *
 * One line per node, indented by depth: `tag.class1.class2 [attr="v"]` then
 * text nodes. Attributes are sorted and random per-render tokens are
 * normalised, so a golden diff reads as a real structural change.
 */
const VOLATILE_ATTR_VALUE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function dumpDom(root: Node, depth = 0): string {
  const lines: string[] = [];
  const pad = '  '.repeat(depth);
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) lines.push(`${pad}"${text}"`);
    } else if (node.nodeType === 1) {
      const el = node as HTMLElement;
      const cls = Array.from(el.classList).sort().map(c => `.${c}`).join('');
      const attrs = Array.from(el.attributes)
        .filter(a => a.name !== 'class')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => `${a.name}="${a.value.replace(VOLATILE_ATTR_VALUE, '<id>')}"`)
        .join(' ');
      lines.push(`${pad}${el.tagName.toLowerCase()}${cls}${attrs ? ` [${attrs}]` : ''}`);
      const inner = dumpDom(el, depth + 1);
      if (inner) lines.push(inner);
    }
  }
  return lines.join('\n');
}

/** Click every anchor (plain click, then Cmd-click) recording what each routed to. */
export async function recordAnchorClicks(root: HTMLElement, calls: string[]): Promise<string> {
  const out: string[] = [];
  const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('a'));
  for (const [i, a] of anchors.entries()) {
    const label = `${i} ${a.className || '-'} ${a.getAttribute('data-href') ?? a.getAttribute('href') ?? ''} "${(a.textContent ?? '').trim()}"`;
    for (const meta of [false, true]) {
      calls.length = 0;
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: meta });
      a.dispatchEvent(ev);
      await new Promise(r => setTimeout(r, 0));
      out.push(`${label} ${meta ? 'meta' : 'plain'} -> prevented=${ev.defaultPrevented} ${calls.length ? calls.join(' | ') : '(no routing)'}`);
    }
  }
  calls.length = 0;
  return out.join('\n');
}
