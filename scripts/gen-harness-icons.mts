#!/usr/bin/env node
/**
 * Generate the Playwright harness's Lucide icon map from the pinned
 * `lucide-static` package.
 *
 * Why this exists: `test/harness/obsidian-mock.ts` used to hard-code a
 * 7-entry icon map plus a generic-circle fallback. The plugin calls
 * `setIcon()` with dozens of distinct names, so every unmapped one silently
 * rendered as a placeholder circle and the screenshot baselines quietly
 * enshrined that as "correct". Scanning `src/` at build time means the map
 * can never drift from the code again.
 *
 * The emitted markup mirrors real Obsidian exactly: Obsidian's setIcon does
 * `classList.add("svg-icon", "lucide-" + name)`, so we rewrite
 * lucide-static's own `class="lucide lucide-<name>"` to
 * `class="svg-icon lucide-<name>"`. The `svg-icon` class is load-bearing —
 * both `test/harness/obsidian-base.css` (sizing) and the plugin's own
 * `.ct-notice-icon .svg-icon` rule in `styles.css` select on it.
 *
 * Run manually with `npm run gen:harness-icons`; it also runs automatically
 * as the first step of `test/harness/esbuild.mjs`.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const LUCIDE_DIR = path.join(REPO_ROOT, 'node_modules', 'lucide-static', 'icons');
const LUCIDE_PKG = path.join(REPO_ROOT, 'node_modules', 'lucide-static', 'package.json');
const OUT_FILE = path.join(REPO_ROOT, 'test', 'harness', 'lucide-icons.generated.ts');

/**
 * Icon names referenced dynamically (built from a variable, looked up from a
 * map, etc.) that the static scan below cannot see. Add a name here when a
 * harness screenshot shows the loud magenta "missing icon" marker but grepping
 * `src/` for the literal turns up nothing.
 */
const EXTRA_ICONS: string[] = [
  // Used only by the harness's own design-plugin fixture
  // (test/harness/design-plugin/designArtifactProvider.ts), which the src/
  // scan does not cover. It used to be picked up incidentally from a stray
  // addIcon('play', ...) in src/main.ts.
  'play',
];

/**
 * Icon names arrive in two confidence tiers.
 *
 * STRICT — the literal is unambiguously an icon argument, so a name with no
 * matching lucide-static file is a real bug (a typo, or a Lucide rename) and
 * hard-fails the build. Covers every string literal in a `setIcon(...)` call,
 * including the many ternary forms this codebase uses, e.g.
 * `setIcon(el, expanded ? 'chevron-down' : 'chevron-right')`, plus the
 * `icon: 'name'` object property.
 *
 * SOFT — every other kebab-case string literal in src/, kept only when
 * lucide-static actually has a glyph by that name, and never failing the
 * build. This covers the names that never appear in an icon-shaped position:
 * `getToolIcon()` in src/toolNameUtils.ts and `resolveTagIcon()` in
 * src/statusLine.ts return them, `addIcon()` in src/main.ts registers them,
 * and helpers like `action(label, icon, cb)` pass them through. The tier is
 * not optional — the strict tier alone finds 62 of the ~130 names the plugin
 * actually renders.
 */
/**
 * Every kebab-case string literal in the file. Chasing the individual shapes
 * icon names hide in turned out to be a losing game — they arrive via ternary
 * returns (`return tone === 'warn' ? 'cloud-off' : 'cloud'`), pass-through
 * helper arguments (`action('Capture', 'camera', cb)`), `addIcon()`
 * registrations in src/main.ts, and lookup tables. Each shape missed here is a
 * magenta marker in a baseline. Collecting every literal and keeping only the
 * ones lucide-static actually has is both exhaustive and self-limiting: a
 * coincidental non-icon string only survives if a real glyph shares its name,
 * which costs a few unused KB in a test-only bundle and nothing else.
 */
const SOFT_LITERAL_PATTERN = /['"]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)['"]/g;

/** `icon: 'name'` — always an icon, so strict. */
const ICON_PROP_PATTERN = /\bicon:\s*['"]([a-z0-9-]+)['"]/g;

/** Recursively collect every .ts file under a directory. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Return the argument-list text of every `setIcon(...)` call in a source file,
 * found by balanced-paren scanning so nested calls and ternaries survive
 * intact — a flat regex stops at the first `)` and truncates them.
 */
function setIconArgLists(source: string): string[] {
  const out: string[] = [];
  const call = /\bsetIcon\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth === 0) out.push(source.slice(start, i - 1));
  }
  return out;
}

/**
 * Harvest candidate icon names from an expression, dropping the operands of
 * equality comparisons. Those are ternary *conditions*, not icon names —
 * `setIcon(el, task.status === 'completed' ? 'circle-check' : 'circle')` would
 * otherwise hard-fail the build on the non-icon literal 'completed'.
 */
function iconLiteralsIn(expression: string): string[] {
  const withoutComparisons = expression
    .replace(/[=!]==?\s*['"][^'"]*['"]/g, ' ')
    .replace(/['"][^'"]*['"]\s*[=!]==?/g, ' ');
  return [...withoutComparisons.matchAll(/['"]([a-z0-9][a-z0-9-]*)['"]/g)].map((m) => m[1]);
}

interface ScanResult {
  /** Must resolve to a lucide-static file, or the build fails. */
  strict: Set<string>;
  /** Included only if a lucide-static file exists; never fails the build. */
  soft: Set<string>;
}

function scanIconNames(files: string[]): ScanResult {
  const strict = new Set<string>();
  const soft = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const args of setIconArgLists(source)) {
      for (const name of iconLiteralsIn(args)) strict.add(name);
    }
    let match: RegExpExecArray | null;
    ICON_PROP_PATTERN.lastIndex = 0;
    while ((match = ICON_PROP_PATTERN.exec(source)) !== null) strict.add(match[1]);
    SOFT_LITERAL_PATTERN.lastIndex = 0;
    while ((match = SOFT_LITERAL_PATTERN.exec(source)) !== null) soft.add(match[1]);
  }
  for (const name of strict) soft.delete(name);
  return { strict, soft };
}

/**
 * Normalize one lucide-static SVG into a single-line string carrying the same
 * class list real Obsidian's setIcon() produces.
 */
function normalizeSvg(raw: string, name: string): string {
  const withoutLicense = raw.replace(/<!--[\s\S]*?-->/g, '');
  const oneLine = withoutLicense
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    // lucide-static puts each attribute on its own line, which leaves a stray
    // space before the closing bracket once newlines collapse. `/` is never
    // preceded by whitespace here, so self-closing tags are untouched.
    .replace(/\s+>/g, '>')
    .trim();
  const rewritten = oneLine.replace(
    /\sclass="[^"]*"/,
    ` class="svg-icon lucide-${name}"`,
  );
  if (!rewritten.includes(`class="svg-icon lucide-${name}"`)) {
    throw new Error(
      `Could not rewrite the class attribute for icon "${name}". ` +
        `lucide-static's markup shape changed — update normalizeSvg() in ` +
        `scripts/gen-harness-icons.mts.`,
    );
  }
  return rewritten;
}

const lucideVersion: string = JSON.parse(readFileSync(LUCIDE_PKG, 'utf8')).version;

const { strict, soft } = scanIconNames(collectTsFiles(SRC_DIR));

/** Read an icon's SVG source, or null when lucide-static has no such file. */
function readIcon(name: string): string | null {
  try {
    return readFileSync(path.join(LUCIDE_DIR, `${name}.svg`), 'utf8');
  } catch {
    return null;
  }
}

const icons: Record<string, string> = {};
const missing: string[] = [];

// Strict tier + EXTRA_ICONS: every name must resolve.
for (const name of [...new Set([...strict, ...EXTRA_ICONS])].sort()) {
  const raw = readIcon(name);
  if (raw === null) missing.push(name);
  else icons[name] = normalizeSvg(raw, name);
}

if (missing.length > 0) {
  console.error(
    `\n[gen-harness-icons] ${missing.length} icon name(s) referenced in src/ have ` +
      `no matching file in lucide-static@${lucideVersion}:\n` +
      missing
        .map((n) => `  - ${n}  (expected ${path.relative(REPO_ROOT, path.join(LUCIDE_DIR, `${n}.svg`))})`)
        .join('\n') +
      `\n\nEither the name is a typo in src/, or it is an Obsidian-era Lucide alias ` +
      `this Lucide version renamed. Fix the caller or map it deliberately — ` +
      `silently skipping is what caused placeholder circles in the first place.\n`,
  );
  process.exit(1);
}

// Soft tier: additive, and only where lucide-static actually has the glyph.
let softCount = 0;
for (const name of [...soft].sort()) {
  const raw = readIcon(name);
  if (raw === null) continue;
  icons[name] = normalizeSvg(raw, name);
  softCount++;
}

const header = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by scripts/gen-harness-icons.mts from lucide-static@${lucideVersion}
// (pinned exactly in package.json so screenshot baselines cannot shift on a
// reinstall). Icon names are scanned out of src/ on every harness build, so
// this map cannot drift from the code. Regenerate with:
//
//   npm run gen:harness-icons
//
// Each entry carries class="svg-icon lucide-<name>", matching what real
// Obsidian's setIcon() emits.
`;

const body = Object.keys(icons)
  .sort()
  .map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(icons[name])},`)
  .join('\n');

writeFileSync(
  OUT_FILE,
  `${header}\nexport const LUCIDE_ICONS: Record<string, string> = {\n${body}\n};\n`,
  'utf8',
);

console.log(
  `[gen-harness-icons] ${Object.keys(icons).length} icons → ` +
    `${path.relative(REPO_ROOT, OUT_FILE)} ` +
    `(${strict.size + EXTRA_ICONS.length} strict, ${softCount} soft, ` +
    `lucide-static@${lucideVersion})`,
);
