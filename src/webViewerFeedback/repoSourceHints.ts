import * as fs from 'fs';
import * as path from 'path';
import type { WebViewerElementSelection } from './contract';

/**
 * Bounded async priority-BFS workspace scanner that maps a picked Web Viewer DOM
 * element back to up to 3 likely local source files + 1-based line numbers.
 *
 * Security invariants:
 * - Never touches `fs` when `isRemoteThread` is `true` or `cwd` is absent.
 * - Resolves `realpath` on `cwd` and every visited directory/file, skipping any
 *   symlink whose resolved target escapes `realRoot`.
 * - Enforces strict wall-clock, directory, file-count, per-file byte, and total
 *   byte budgets, plus `AbortSignal` cancellation.
 * - Emits strictly repo-relative POSIX paths and host-authored `reason` labels
 *   (never echoing untrusted Origin-G strings so hints are safe outside the fence).
 */

export interface RepoSourceHint {
  readonly relativePath: string;
  readonly line: number;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly reason: string;
}

export interface FindRepoSourceHintsOptions {
  readonly cwd: string | null | undefined;
  readonly isRemoteThread: boolean;
  readonly selection: WebViewerElementSelection;
  readonly signal?: AbortSignal;
  readonly maxWallMs?: number;
  readonly maxDirs?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export const DEFAULT_MAX_WALL_MS = 200;
export const DEFAULT_MAX_DIRS = 400;
export const DEFAULT_MAX_FILES = 500;
export const DEFAULT_MAX_FILE_BYTES = 262_144; // 256 KB
export const DEFAULT_MAX_TOTAL_BYTES = 8_388_608; // 8 MB
const MAX_HINTS = 3;
const BINARY_SNIFF_BYTES = 4096;

const PRIORITY_SUBDIRS: readonly string[] = [
  'src/app',
  'app',
  'src/pages',
  'pages',
  'src/components',
  'components',
  'src/views',
  'src/routes',
  'src',
];

const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
]);

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.ts',
  '.js',
]);

const STABLE_DATA_ATTRS = [
  'data-testid',
  'data-test',
  'data-cy',
  'data-qa',
  'data-slot',
  'data-component',
] as const;

const EXACT_UTILITY_CLASSES: ReadonlySet<string> = new Set([
  'flex', 'inline-flex', 'grid', 'inline-grid', 'block', 'inline-block', 'inline',
  'hidden', 'contents', 'table', 'flow-root', 'sr-only', 'not-sr-only', 'container',
  'prose', 'truncate', 'antialiased', 'subpixel-antialiased', 'italic', 'not-italic',
  'underline', 'overline', 'line-through', 'no-underline', 'uppercase', 'lowercase',
  'capitalize', 'normal-case', 'relative', 'absolute', 'fixed', 'sticky', 'static',
  'isolate', 'visible', 'invisible', 'collapse', 'grow', 'shrink', 'border', 'rounded',
  'shadow', 'ring', 'outline', 'blur', 'transition', 'duration', 'ease', 'delay',
  'animate', 'cursor', 'select', 'resize', 'scroll', 'snap', 'touch', 'will-change',
]);

const UTILITY_CLASS_PREFIX =
  /^-?(?:flex|grid|col|row|auto-cols|auto-rows|place|items|justify|content|self|p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|space-[xy]|gap|w|min-w|max-w|h|min-h|max-h|size|font|text|leading|tracking|align|whitespace|break|hyphens|bg|from|via|to|border|divide|outline|ring|rounded|shadow|opacity|mix-blend|bg-blend|filter|backdrop|blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|saturate|sepia|transition|duration|ease|delay|animate|scale|rotate|translate|skew|origin|accent|appearance|cursor|caret|pointer-events|resize|scroll|snap|touch|select|will-change|fill|stroke|object|overflow|overscroll|top|right|bottom|left|inset|z|aspect|columns|box|float|clear|isolation|list|decoration|underline-offset)-/;

const VARIANT_PREFIX_STRIP = /^(?:[a-z0-9-]+:)+/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isUtilityCssClass(rawClass: string): boolean {
  const trimmed = rawClass.trim();
  if (!trimmed) return true;
  const stripped = trimmed.replace(VARIANT_PREFIX_STRIP, '').replace(/^!/, '');
  if (stripped.length <= 2) return true;
  if (EXACT_UTILITY_CLASSES.has(stripped)) return true;
  if (UTILITY_CLASS_PREFIX.test(stripped)) return true;
  if (/^\[.+\]$/.test(stripped)) return true;
  return false;
}

function isInsideRoot(realRoot: string, candidateReal: string): boolean {
  const rel = path.relative(realRoot, candidateReal);
  return (
    rel === '' ||
    (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
  );
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function isTestOrStoryPath(posixRel: string): boolean {
  if (/(?:^|\/)(?:__tests__|__mocks__|test|tests)\//i.test(posixRel)) return true;
  if (/\.(?:test|spec|stories|story)\.[a-z0-9]+$/i.test(posixRel)) return true;
  return false;
}

function extractOpeningTag(html: string): string {
  const open = html.indexOf('<');
  if (open < 0) return '';
  let quote = '';
  for (let i = open + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return html.slice(open, i + 1);
    }
  }
  return html.slice(open, Math.min(html.length, open + 512));
}

function extractHtmlAttribute(tagText: string, attrName: string): string | null {
  const re = new RegExp(
    `(?:^|\\s)${escapeRegExp(attrName)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>/]+))`,
    'i',
  );
  const match = re.exec(tagText);
  if (!match) return null;
  const val = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  return val.length > 0 ? val : null;
}

interface ExtractedSignals {
  readonly ids: readonly string[];
  readonly dataAttrs: ReadonlyArray<{ readonly attr: string; readonly value: string }>;
  readonly a11yNames: readonly string[];
  readonly textAnchor: string | null;
  readonly routeSegments: readonly string[];
  readonly isRootRoute: boolean;
  readonly semanticClasses: readonly string[];
}

function extractSignals(selection: WebViewerElementSelection): ExtractedSignals {
  const openingTag = extractOpeningTag(selection.outerHTML.html);
  const selectors = [selection.selector, ...selection.selectorAlternates];

  // 1. Element IDs
  const idSet = new Set<string>();
  const htmlId = extractHtmlAttribute(openingTag, 'id');
  if (htmlId && htmlId.length <= 128) idSet.add(htmlId);
  for (const sel of selectors) {
    for (const match of sel.matchAll(/#([A-Za-z_][A-Za-z0-9_-]{0,127})/g)) {
      idSet.add(match[1]);
    }
  }

  // 2. Stable data-* attributes
  const dataAttrMap = new Map<string, { attr: string; value: string }>();
  for (const attr of STABLE_DATA_ATTRS) {
    const fromHtml = extractHtmlAttribute(openingTag, attr);
    if (fromHtml && fromHtml.length <= 128) {
      dataAttrMap.set(`${attr}=${fromHtml}`, { attr, value: fromHtml });
    }
    const selRe = new RegExp(
      `\\[\\s*${escapeRegExp(attr)}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s\\]"']+))\\s*\\]`,
      'gi',
    );
    for (const sel of selectors) {
      for (const m of sel.matchAll(selRe)) {
        const val = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        if (val && val.length <= 128) {
          dataAttrMap.set(`${attr}=${val}`, { attr, value: val });
        }
      }
    }
  }

  // 3. Accessible label / aria-label (>= 4 chars)
  const a11ySet = new Set<string>();
  const ariaLabel = extractHtmlAttribute(openingTag, 'aria-label');
  if (ariaLabel) {
    const norm = ariaLabel.replace(/\s+/g, ' ').trim();
    if (norm.length >= 4 && norm.length <= 120) a11ySet.add(norm);
  }
  if (selection.a11y.name) {
    const norm = selection.a11y.name.replace(/\s+/g, ' ').trim();
    if (norm.length >= 4 && norm.length <= 120) a11ySet.add(norm);
  }

  // 4. Visible textAnchor (>= 4 chars)
  const normAnchor = selection.textAnchor.text.replace(/\s+/g, ' ').trim();
  const textAnchor = normAnchor.length >= 4 && normAnchor.length <= 80 ? normAnchor : null;

  // 5. Route path segments
  const cleanRoute = selection.route.split(/[?#]/)[0]?.trim() ?? '';
  const routeSegments = cleanRoute
    .split('/')
    .map((seg) => seg.trim().toLowerCase())
    .filter((seg) => seg.length > 0 && /^[a-z0-9_-]+$/.test(seg))
    .slice(0, 8);
  const isRootRoute = cleanRoute === '/' && routeSegments.length === 0;

  // 6. Non-utility CSS classes
  const classSet = new Set<string>();
  const htmlClasses = extractHtmlAttribute(openingTag, 'class') ?? '';
  for (const token of htmlClasses.split(/\s+/)) {
    if (token && token.length <= 64 && !isUtilityCssClass(token)) {
      classSet.add(token);
    }
  }
  for (const sel of selectors) {
    for (const m of sel.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]{2,63})/g)) {
      if (!isUtilityCssClass(m[1])) classSet.add(m[1]);
    }
  }

  return {
    ids: [...idSet].slice(0, 4),
    dataAttrs: [...dataAttrMap.values()].slice(0, 6),
    a11yNames: [...a11ySet].slice(0, 3),
    textAnchor,
    routeSegments,
    isRootRoute,
    semanticClasses: [...classSet].slice(0, 8),
  };
}

function scoreRouteMatch(posixRel: string, signals: ExtractedSignals): number {
  const lower = posixRel.toLowerCase();
  if (signals.isRootRoute) {
    if (/(?:^|\/)(?:app\/page|pages\/index|routes\/\+page|routes\/index)\.[a-z0-9]+$/.test(lower)) {
      return 30;
    }
    return 0;
  }
  if (signals.routeSegments.length === 0) return 0;

  const joined = signals.routeSegments.join('/');
  const exactRouteRe = new RegExp(
    `(?:^|/)(?:app|pages|routes|views)/${escapeRegExp(joined)}(?:/(?:page|\\+page|index|route))?\\.[a-z0-9]+$`,
  );
  if (exactRouteRe.test(lower)) {
    return 48;
  }

  // Check if all static route segments appear in order along the file path
  const pathParts = lower.replace(/\.[a-z0-9]+$/, '').split('/');
  let searchFrom = 0;
  let matchedCount = 0;
  for (const seg of signals.routeSegments) {
    const idx = pathParts.indexOf(seg, searchFrom);
    if (idx !== -1) {
      matchedCount++;
      searchFrom = idx + 1;
    }
  }
  if (matchedCount === signals.routeSegments.length && matchedCount >= 1) {
    return 28;
  }
  return 0;
}

interface CompiledMatchers {
  readonly idPatterns: ReadonlyArray<{ readonly markup: RegExp; readonly cssOrJs: RegExp }>;
  readonly dataAttrPatterns: ReadonlyArray<{ readonly attrValue: RegExp }>;
  readonly a11yLiterals: readonly string[];
  readonly textAnchorLiteral: string | null;
  readonly classPatterns: readonly RegExp[];
}

function compileMatchers(signals: ExtractedSignals): CompiledMatchers {
  return {
    idPatterns: signals.ids.map((id) => {
      const esc = escapeRegExp(id);
      return {
        markup: new RegExp(`\\bid\\s*=\\s*(?:["']${esc}["']|\\{\\s*["'\`]${esc}["'\`]\\s*\\})`),
        cssOrJs: new RegExp(`#${esc}(?![\\w-])`),
      };
    }),
    dataAttrPatterns: signals.dataAttrs.map(({ attr, value }) => {
      const escAttr = escapeRegExp(attr);
      const escVal = escapeRegExp(value);
      return {
        attrValue: new RegExp(
          `${escAttr}\\s*=\\s*(?:["']${escVal}["']|\\{\\s*["'\`]${escVal}["'\`]\\s*\\})`,
          'i',
        ),
      };
    }),
    a11yLiterals: signals.a11yNames,
    textAnchorLiteral: signals.textAnchor,
    classPatterns: signals.semanticClasses.map(
      (cls) => new RegExp(`(?:^|[^\\w-])${escapeRegExp(cls)}(?![\\w-])`),
    ),
  };
}

interface FileCandidate {
  readonly relativePath: string;
  readonly line: number;
  readonly score: number;
  readonly isTestFile: boolean;
  readonly reasons: readonly string[];
  readonly visitOrder: number;
}

async function readBoundedTextFile(
  filePath: string,
  maxFileBytes: number,
): Promise<{ text: string; bytesRead: number } | null> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const toRead = Math.min(stat.size, maxFileBytes);
    handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    if (bytesRead === 0) return null;
    const sniffEnd = Math.min(bytesRead, BINARY_SNIFF_BYTES);
    if (buffer.subarray(0, sniffEnd).includes(0)) {
      return null; // Binary file
    }
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      bytesRead,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function scoreFileContent(
  posixRel: string,
  content: string,
  ext: string,
  signals: ExtractedSignals,
  matchers: CompiledMatchers,
  visitOrder: number,
): FileCandidate | null {
  const isCss = ext === '.css' || ext === '.scss';
  const routeBonus = scoreRouteMatch(posixRel, signals);
  const isTestFile = isTestOrStoryPath(posixRel);

  const lines = content.split('\n');
  let bestLine = 1;
  let bestLineScore = 0;
  let bestLineReasons: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 2000) continue;

    let lineScore = 0;
    const reasons: string[] = [];

    // 1. Stable data-* attributes (highest specificity)
    for (const pat of matchers.dataAttrPatterns) {
      if (pat.attrValue.test(line)) {
        lineScore += 95;
        reasons.push('data attribute');
        break;
      }
    }

    // 2. Element #id
    for (const idPat of matchers.idPatterns) {
      if (!isCss && idPat.markup.test(line)) {
        lineScore += 90;
        reasons.push('element id');
        break;
      } else if (idPat.cssOrJs.test(line)) {
        lineScore += 65;
        reasons.push('id selector');
        break;
      }
    }

    // 3. Accessible label / aria-label
    if (!isCss && matchers.a11yLiterals.length > 0) {
      const normalizedLine = line.replace(/\s+/g, ' ');
      for (const a11yName of matchers.a11yLiterals) {
        if (normalizedLine.includes(a11yName)) {
          const hasAriaAttr = /aria-label\s*=/i.test(line);
          lineScore += hasAriaAttr ? 68 : 50;
          reasons.push(hasAriaAttr ? 'aria-label attribute' : 'accessible label');
          break;
        }
      }
    }

    // 4. Visible textAnchor literal (avoid double-counting when identical to a11y label)
    if (
      !isCss &&
      matchers.textAnchorLiteral &&
      !matchers.a11yLiterals.includes(matchers.textAnchorLiteral)
    ) {
      const normalizedLine = line.replace(/\s+/g, ' ');
      if (normalizedLine.includes(matchers.textAnchorLiteral)) {
        lineScore += 45;
        reasons.push('visible text anchor');
      }
    }

    // 5. Semantic (non-utility) CSS classes
    if (matchers.classPatterns.length > 0) {
      let classHits = 0;
      for (const clsRe of matchers.classPatterns) {
        if (clsRe.test(line)) {
          classHits++;
          if (classHits >= 2) break;
        }
      }
      if (classHits > 0) {
        lineScore += classHits * 28;
        reasons.push('CSS class selector');
      }
    }

    if (lineScore > bestLineScore) {
      bestLineScore = lineScore;
      bestLine = i + 1;
      bestLineReasons = reasons;
    }
  }

  if (bestLineScore === 0 && routeBonus === 0) {
    return null;
  }

  let totalScore = bestLineScore + routeBonus;
  const combinedReasons = [...bestLineReasons];
  if (routeBonus > 0) {
    combinedReasons.push('route path');
  }

  if (isTestFile) {
    totalScore = Math.floor(totalScore * 0.35);
  }

  if (totalScore < 20) {
    return null;
  }

  return {
    relativePath: posixRel,
    line: bestLine,
    score: totalScore,
    isTestFile,
    reasons: combinedReasons,
    visitOrder,
  };
}

function confidenceFromCandidate(candidate: FileCandidate): RepoSourceHint['confidence'] {
  if (candidate.isTestFile) return 'low';
  if (candidate.score >= 80) return 'high';
  if (candidate.score >= 45) return 'medium';
  return 'low';
}

export async function findRepoSourceHints(
  options: FindRepoSourceHintsOptions,
): Promise<RepoSourceHint[]> {
  try {
    return await findRepoSourceHintsInner(options);
  } catch {
    return [];
  }
}

async function findRepoSourceHintsInner(
  options: FindRepoSourceHintsOptions,
): Promise<RepoSourceHint[]> {
  if (options.isRemoteThread || !options.cwd || !options.cwd.trim()) {
    return [];
  }
  if (options.signal?.aborted) {
    return [];
  }

  const maxWallMs = options.maxWallMs ?? DEFAULT_MAX_WALL_MS;
  const maxDirs = options.maxDirs ?? DEFAULT_MAX_DIRS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const deadline = Date.now() + maxWallMs;

  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(options.cwd);
    const rootStat = await fs.promises.stat(realRoot);
    if (!rootStat.isDirectory()) return [];
  } catch {
    return [];
  }

  const signals = extractSignals(options.selection);
  const hasAnySignal =
    signals.ids.length > 0 ||
    signals.dataAttrs.length > 0 ||
    signals.a11yNames.length > 0 ||
    signals.textAnchor !== null ||
    signals.routeSegments.length > 0 ||
    signals.isRootRoute ||
    signals.semanticClasses.length > 0;
  if (!hasAnySignal) {
    return [];
  }

  const matchers = compileMatchers(signals);
  const visitedDirs = new Set<string>();
  const visitedFiles = new Set<string>();
  const dirQueue: string[] = [];

  const tryEnqueueDir = async (candidatePath: string): Promise<void> => {
    if (options.signal?.aborted || Date.now() > deadline) return;
    if (visitedDirs.size >= maxDirs) return;
    let realDir: string;
    try {
      realDir = await fs.promises.realpath(candidatePath);
      if (!isInsideRoot(realRoot, realDir)) return;
      if (visitedDirs.has(realDir)) return;
      const st = await fs.promises.stat(realDir);
      if (!st.isDirectory()) return;
    } catch {
      return;
    }
    visitedDirs.add(realDir);
    dirQueue.push(realDir);
  };

  for (const sub of PRIORITY_SUBDIRS) {
    if (options.signal?.aborted || Date.now() > deadline) break;
    await tryEnqueueDir(path.join(realRoot, sub));
  }
  await tryEnqueueDir(realRoot);

  const candidates: FileCandidate[] = [];
  let filesScanned = 0;
  let totalBytesRead = 0;
  let queueIdx = 0;

  while (
    queueIdx < dirQueue.length &&
    filesScanned < maxFiles &&
    totalBytesRead < maxTotalBytes &&
    !options.signal?.aborted &&
    Date.now() <= deadline
  ) {
    const currentDir = dirQueue[queueIdx++];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const childDirs: string[] = [];
    for (const entry of entries) {
      if (options.signal?.aborted || Date.now() > deadline) break;
      const name = entry.name;
      if (name.startsWith('.')) continue;

      const fullPath = path.join(currentDir, name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIR_NAMES.has(name)) {
          childDirs.push(fullPath);
        }
        continue;
      }

      if (entry.isSymbolicLink()) {
        // Resolve symlink target and check whether it stays inside realRoot
        let realTarget: string;
        let targetStat: fs.Stats;
        try {
          realTarget = await fs.promises.realpath(fullPath);
          if (!isInsideRoot(realRoot, realTarget)) continue;
          targetStat = await fs.promises.stat(realTarget);
        } catch {
          continue;
        }
        if (targetStat.isDirectory()) {
          if (!IGNORED_DIR_NAMES.has(name) && !visitedDirs.has(realTarget) && visitedDirs.size < maxDirs) {
            visitedDirs.add(realTarget);
            dirQueue.push(realTarget);
          }
          continue;
        }
        if (!targetStat.isFile()) continue;
        await processCandidateFile(realTarget);
        continue;
      }

      if (entry.isFile()) {
        await processCandidateFile(fullPath);
      }
    }

    for (const childDir of childDirs) {
      if (visitedDirs.size >= maxDirs || options.signal?.aborted || Date.now() > deadline) break;
      await tryEnqueueDir(childDir);
    }
  }

  async function processCandidateFile(candidatePath: string): Promise<void> {
    if (filesScanned >= maxFiles || totalBytesRead >= maxTotalBytes) return;
    if (options.signal?.aborted || Date.now() > deadline) return;

    const lowerName = path.basename(candidatePath).toLowerCase();
    if (lowerName.endsWith('.d.ts') || lowerName.endsWith('.min.js') || lowerName.endsWith('.min.css')) {
      return;
    }
    const ext = path.extname(lowerName);
    if (!SOURCE_EXTENSIONS.has(ext)) return;

    let realFile: string;
    try {
      realFile = await fs.promises.realpath(candidatePath);
    } catch {
      return;
    }
    if (!isInsideRoot(realRoot, realFile)) return;
    if (visitedFiles.has(realFile)) return;
    visitedFiles.add(realFile);

    const relNative = path.relative(realRoot, realFile);
    const posixRel = toPosixPath(relNative);
    if (!posixRel || posixRel.startsWith('..') || posixRel.startsWith('/')) return;

    const remainingByteBudget = maxTotalBytes - totalBytesRead;
    if (remainingByteBudget <= 0) return;

    const readResult = await readBoundedTextFile(
      realFile,
      Math.min(maxFileBytes, remainingByteBudget),
    );
    filesScanned++;
    if (!readResult) return;
    totalBytesRead += readResult.bytesRead;

    const scored = scoreFileContent(
      posixRel,
      readResult.text,
      ext,
      signals,
      matchers,
      filesScanned,
    );
    if (scored) {
      candidates.push(scored);
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isTestFile !== b.isTestFile) return a.isTestFile ? 1 : -1;
    if (a.visitOrder !== b.visitOrder) return a.visitOrder - b.visitOrder;
    return a.relativePath.localeCompare(b.relativePath);
  });

  return candidates.slice(0, MAX_HINTS).map((c) => ({
    relativePath: c.relativePath,
    line: c.line,
    confidence: confidenceFromCandidate(c),
    reason: `matched ${c.reasons.join(' + ')}`,
  }));
}
