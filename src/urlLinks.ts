/**
 * Pure helpers for finding http(s) URLs in plain text. Used to make bare URLs
 * clickable in chat messages (user text, inline code) and to feed them into the
 * recent-files pill. No Obsidian/Node deps.
 */

const URL_RE = /https?:\/\/[^\s<>"'`\]]+/gi;
// Trailing punctuation that is almost always sentence structure, not URL.
const TRAILING_RE = /[.,;:!?*_~]+$/;

export interface TextUrlSegment {
  text: string;
  /** Set when this segment is a URL. */
  url?: string;
}

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_RE, '');
  // A closing paren only belongs to the URL if it balances an opener inside it.
  while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  return url;
}

/** Split text into plain and URL segments. Concatenating `text` restores the input. */
export function splitTextWithUrls(text: string): TextUrlSegment[] {
  const out: TextUrlSegment[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    const url = trimUrl(m[0]);
    if (!/^https?:\/\/[^/\s]+/i.test(url) || url.length <= 'http://'.length) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: url, url });
    last = m.index + url.length;
    URL_RE.lastIndex = last;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Unique http(s) URLs in order of first appearance. */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const seg of splitTextWithUrls(text)) if (seg.url) seen.add(seg.url);
  return [...seen];
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

/** Short chip label for a URL: host plus a trimmed path. */
export function urlChipLabel(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const p = u.pathname.replace(/\/+$/, '');
    return p ? `${host}${p}` : host;
  } catch {
    return url;
  }
}
