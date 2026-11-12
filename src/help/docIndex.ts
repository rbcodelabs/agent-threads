/**
 * Markdown section index shared by every `docRoots` provider and the built-in Agent Threads docs.
 *
 * Files are split on H2/H3 headings so `get` returns a section, not a 40 KB document. Search is a small
 * deterministic BM25 over title + body (title weighted): no embeddings, no external service.
 *
 * Doc ids are `<relative path>#<heading slug>` (a section), `<relative path>#top` (text before the first H2/H3)
 * or a bare `<relative path>` (the whole file, paged by `get`).
 */
import type * as FsModule from 'fs';
import type * as PathModule from 'path';
import { findBestExcerpt, tokenizeQuery } from '../searchUtils';
import { HELP_LIMITS, type HelpDoc, type HelpHit, type HelpTopic } from './types';

// Node built-ins are required lazily (never at module init): Obsidian Mobile's require() returns null for them
// and this module is part of the always-loaded bundle. See test/unit/bundle-safety.test.ts.
/* eslint-disable @typescript-eslint/no-require-imports */
function nodeFs(): typeof FsModule {
  return require('fs') as typeof FsModule;
}
function nodePath(): typeof PathModule {
  return require('path') as typeof PathModule;
}
/* eslint-enable @typescript-eslint/no-require-imports */

export interface DocFile { readonly path: string; readonly text: string }

export interface DocSection {
  readonly docId: string;
  readonly filePath: string;
  readonly title: string;
  readonly text: string;
  readonly textLower: string;
  readonly titleLower: string;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

function slugify(heading: string): string {
  const slug = heading.toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
  return slug || 'section';
}

/** Splits one Markdown file into sections. Headings inside code fences are ignored. */
export function splitMarkdownSections(filePath: string, text: string): { fileTitle: string; sections: DocSection[] } {
  const lines = text.split(/\r?\n/);
  const raw: Array<{ title: string; slug: string; lines: string[] }> = [];
  let fileTitle = '';
  let current: { title: string; slug: string; lines: string[] } | null = null;
  let inFence = false;
  const slugCounts = new Map<string, number>();
  const uniqueSlug = (base: string): string => {
    const n = slugCounts.get(base) ?? 0;
    slugCounts.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  const open = (title: string, slug: string) => { current = { title, slug, lines: [] }; raw.push(current); };
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADING.exec(line);
    if (m) {
      const level = m[1].length;
      if (level === 1 && !fileTitle) fileTitle = m[2];
      if (level >= 2) { open(m[2], uniqueSlug(slugify(m[2]))); current!.lines.push(line); continue; }
      if (!current) open('', 'top');
      current!.lines.push(line);
      continue;
    }
    if (!current) open('', 'top');
    current!.lines.push(line);
  }
  const base = nodePath().basename(filePath, nodePath().extname(filePath));
  const title = fileTitle || base;
  const sections: DocSection[] = [];
  for (const chunk of raw) {
    const body = chunk.lines.join('\n').trim();
    if (!body) continue;
    const sectionTitle = chunk.slug === 'top' ? title : `${title} > ${chunk.title}`;
    sections.push({
      docId: `${filePath}#${chunk.slug}`, filePath, title: sectionTitle.slice(0, HELP_LIMITS.titleChars),
      text: body, textLower: body.toLowerCase(), titleLower: sectionTitle.toLowerCase(),
    });
  }
  return { fileTitle: title, sections };
}

function snippetFor(section: DocSection, terms: string[]): string {
  const excerpt = terms.length ? findBestExcerpt(section.text, section.textLower, terms, 200) : '';
  const body = (excerpt || section.text.replace(/^#+\s.*\n?/, '').replace(/\s+/g, ' ').trim()).replace(/\s+/g, ' ');
  return body.length > HELP_LIMITS.snippetChars ? `${body.slice(0, HELP_LIMITS.snippetChars - 1)}…` : body;
}

export class DocCorpus {
  private readonly sections: DocSection[] = [];
  private readonly files = new Map<string, { title: string; text: string }>();
  private readonly avgLen: number;

  constructor(files: readonly DocFile[]) {
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const { fileTitle, sections } = splitMarkdownSections(file.path, file.text);
      this.files.set(file.path, { title: fileTitle, text: file.text });
      this.sections.push(...sections);
    }
    this.avgLen = this.sections.length ? this.sections.reduce((n, s) => n + s.text.length, 0) / this.sections.length : 1;
  }

  get size(): number { return this.sections.length; }

  /** BM25 over title (x3) + body. Scores are normalized so the best hit is 1. */
  search(query: string, limit: number): HelpHit[] {
    const terms = [...new Set(tokenizeQuery(query))];
    if (!terms.length || !this.sections.length) return [];
    const n = this.sections.length;
    const k1 = 1.2; const b = 0.75;
    const scored: Array<{ section: DocSection; score: number }> = [];
    const docFreq = terms.map((t) => this.sections.reduce((c, s) => c + (s.textLower.includes(t) || s.titleLower.includes(t) ? 1 : 0), 0));
    for (const section of this.sections) {
      let score = 0;
      terms.forEach((term, i) => {
        const tf = countOccurrences(section.textLower, term) + 3 * countOccurrences(section.titleLower, term);
        if (!tf) return;
        const idf = Math.log(1 + (n - docFreq[i] + 0.5) / (docFreq[i] + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (section.text.length / this.avgLen))));
      });
      if (score > 0) scored.push({ section, score });
    }
    scored.sort((x, y) => y.score - x.score || x.section.docId.localeCompare(y.section.docId));
    const top = scored[0]?.score ?? 1;
    return scored.slice(0, limit).map(({ section, score }) => ({
      docId: section.docId, title: section.title, snippet: snippetFor(section, terms), score: score / top,
    }));
  }

  get(docId: string, offset: number, maxChars: number): HelpDoc | null {
    const hash = docId.indexOf('#');
    const filePath = hash === -1 ? docId : docId.slice(0, hash);
    const file = this.files.get(filePath);
    if (!file) return null;
    let title = file.title;
    let text = file.text;
    if (hash !== -1) {
      const section = this.sections.find((s) => s.docId === docId);
      if (!section) return null;
      title = section.title; text = section.text;
    }
    return { title, text: text.slice(offset, offset + maxChars), totalChars: text.length };
  }

  topics(): HelpTopic[] {
    return [...this.files.entries()].map(([filePath, f]) => ({ docId: filePath, title: f.title.slice(0, HELP_LIMITS.titleChars) }));
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) { count++; idx = haystack.indexOf(needle, idx + needle.length); }
  return count;
}

// ── docRoots: validation and scanning ────────────────────────────────────────

function isInside(parent: string, child: string): boolean {
  const rel = nodePath().relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !nodePath().isAbsolute(rel));
}

/**
 * Validates a peer-supplied doc root. Must be an absolute, existing directory whose REAL path lies inside one of
 * the allowed bases (the owner's plugin directory or the vault). `/`, `/etc` and `..` tricks all fail here.
 * Returns the resolved real path, or an error string.
 */
export function resolveDocRoot(root: unknown, allowedBases: readonly string[]): { ok: true; real: string } | { ok: false; error: string } {
  if (typeof root !== 'string' || !root || !nodePath().isAbsolute(root)) return { ok: false, error: 'docRoots entries must be absolute paths.' };
  if (root.split(/[\\/]/).includes('..')) return { ok: false, error: `docRoot "${root}" must not contain "..".` };
  let real: string;
  try {
    real = nodeFs().realpathSync(root);
    if (!nodeFs().statSync(real).isDirectory()) return { ok: false, error: `docRoot "${root}" is not a directory.` };
  } catch {
    return { ok: false, error: `docRoot "${root}" does not exist.` };
  }
  const bases: string[] = [];
  for (const base of allowedBases) {
    try { bases.push(nodeFs().realpathSync(base)); } catch { /* base missing: cannot contain anything */ }
  }
  if (!bases.some((base) => isInside(base, real))) {
    return { ok: false, error: `docRoot "${root}" must be inside the plugin's own directory or the vault.` };
  }
  return { ok: true, real };
}

export interface ScanOptions {
  /** Directory names (relative to the root, `/`-separated) to skip. */
  readonly excludeDirs?: readonly string[];
}

/**
 * Reads the Markdown files under an already-validated root. Skips dotfiles/dirs, symlinks (any entry that is
 * not a plain file or directory), non-`.md` files, files over 2 MB, and stops at 2,000 files.
 */
async function scanRoot(real: string, previous: Map<string, { stamp: string; text: string }>, options: ScanOptions): Promise<{ files: Map<string, { stamp: string; text: string }> }> {
  const out = new Map<string, { stamp: string; text: string }>();
  const exclude = new Set(options.excludeDirs ?? []);
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 8 || out.size >= HELP_LIMITS.docRootMaxFiles) return;
    let entries;
    try { entries = await nodeFs().promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.size >= HELP_LIMITS.docRootMaxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = nodePath().join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!exclude.has(childRel)) await walk(full, childRel, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        let st;
        try { st = await nodeFs().promises.stat(full); } catch { continue; }
        if (st.size > HELP_LIMITS.docRootMaxFileBytes) continue;
        const stamp = `${st.mtimeMs}:${st.size}`;
        const cached = previous.get(childRel);
        if (cached && cached.stamp === stamp) { out.set(childRel, cached); continue; }
        try { out.set(childRel, { stamp, text: await nodeFs().promises.readFile(full, 'utf8') }); } catch { /* unreadable: skip */ }
      }
    }
  };
  await walk(real, '', 0);
  return { files: out };
}

/** Lazily built, mtime/size-cached corpus over one or more validated roots. */
export class FsDocCorpusCache {
  private readonly perRoot = new Map<string, Map<string, { stamp: string; text: string }>>();
  private corpus: DocCorpus | null = null;
  private signature = '';

  constructor(private readonly roots: readonly string[], private readonly options: ScanOptions = {}) {}

  async get(): Promise<DocCorpus> {
    const files: DocFile[] = [];
    let signature = '';
    for (const [i, root] of this.roots.entries()) {
      const { files: scanned } = await scanRoot(root, this.perRoot.get(root) ?? new Map(), this.options);
      this.perRoot.set(root, scanned);
      for (const [rel, f] of scanned) {
        signature += `${i}:${rel}:${f.stamp};`;
        // With several roots the root index prefixes the path so ids stay unique.
        files.push({ path: this.roots.length > 1 ? `${i}/${rel}` : rel, text: f.text });
      }
    }
    if (!this.corpus || signature !== this.signature) { this.corpus = new DocCorpus(files); this.signature = signature; }
    return this.corpus;
  }
}
