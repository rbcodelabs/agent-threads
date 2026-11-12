import { setTooltip } from 'obsidian';
import { mapToVaultPath } from '../bridgeUtils';
import { splitTextWithUrls } from '../urlLinks';
import type { MessageRenderHost } from './types';

/**
 * Turn bare http(s) URLs in rendered text into clickable anchors. Marked's
 * GFM autolink misses URLs inside inline code and plain-text user messages;
 * this walks text nodes (excluding <pre> blocks and existing anchors) and
 * wires clicks through `open` like every other external link.
 */
export function linkifyUrls(root: HTMLElement, open: (url: string, forceExternal: boolean) => void): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = (node as Text).parentElement;
      if (!parent || parent.closest('pre, a')) return NodeFilter.FILTER_REJECT;
      return /https?:\/\//i.test(node.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const tn of nodes) {
    const segments = splitTextWithUrls(tn.textContent ?? '');
    if (!segments.some(sg => sg.url)) continue;
    const frag = document.createDocumentFragment();
    for (const seg of segments) {
      if (!seg.url) { frag.appendChild(document.createTextNode(seg.text)); continue; }
      const url = seg.url;
      const a = document.createElement('a');
      a.className = 'ct-auto-link';
      a.setAttribute('href', url);
      a.textContent = url;
      a.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        open(url, event.metaKey || event.ctrlKey);
      });
      frag.appendChild(a);
    }
    tn.replaceWith(frag);
  }
}

/**
 * Convert absolute file paths that fall inside a configured Vault Bridge's
 * source repo into clickable internal links targeting the synced vault copy.
 * Walks rendered text nodes (including inline code, excluding <pre> blocks
 * and existing anchors) so markdown structure is never disturbed. Only paths
 * whose vault copy actually exists are linkified, so clicking can never
 * create a stray note.
 */
export function linkifyBridgePaths(root: HTMLElement, host: MessageRenderHost): void {
  const bridges = host.bridges?.() ?? [];
  if (bridges.length === 0) return;

  // One regex matching any bridge root prefix followed by a path tail.
  // Longer prefixes first so nested roots resolve to the deepest match.
  const prefixes = new Set<string>();
  for (const b of bridges) {
    for (const base of [b.repoPath, b.activeWorktreePath]) {
      if (base) prefixes.add(base.replace(/\\/g, '/').replace(/\/+$/, ''));
    }
  }
  if (prefixes.size === 0) return;
  const escaped = [...prefixes]
    .sort((a, b) => b.length - a.length)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pathRe = new RegExp(`(?:${escaped.join('|')})(?:/[^\\s)\\]}"'\`<>:]+)+`, 'g');

  // Collect text nodes first; mutating the tree during the walk is unsafe.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = (node as Text).parentElement;
      if (!parent || parent.closest('pre, a')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

  for (const tn of textNodes) {
    const text = tn.textContent ?? '';
    let last = 0;
    let frag: DocumentFragment | null = null;
    pathRe.lastIndex = 0;
    for (let m = pathRe.exec(text); m; m = pathRe.exec(text)) {
      // Trim trailing sentence punctuation picked up by the greedy tail.
      const matchText = m[0].replace(/[.,;:!?]+$/, '');
      const mapped = mapToVaultPath(matchText, bridges);
      if (!mapped || !host.vaultHas(mapped.vaultRelPath)) continue;
      if (!frag) frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.className = 'internal-link';
      a.setAttribute('data-href', mapped.vaultRelPath);
      a.setAttribute('href', '#');
      a.textContent = matchText;
      setTooltip(a, mapped.vaultRelPath);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        host.openLinkText(mapped.vaultRelPath);
      });
      frag.appendChild(a);
      last = m.index + matchText.length;
    }
    if (frag) {
      frag.appendChild(document.createTextNode(text.slice(last)));
      tn.replaceWith(frag);
    }
  }
}
