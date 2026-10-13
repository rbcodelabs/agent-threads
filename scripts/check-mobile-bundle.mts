#!/usr/bin/env node
/**
 * Build-time guard for dist/main.mobile.js (the slim Geode-mobile bundle).
 *
 * Geode's mobile runtime evaluates the plugin with
 *   new Function('module', 'exports', 'require', 'fetch', code)
 * and its `require` shim only resolves a fixed module list. Geode also
 * preflights the source with es-module-lexer and rejects ESM syntax, and
 * rejects entrypoints over 16 MiB. This script fails the build if the bundle
 * could trip any of those, long before a phone finds out.
 *
 *   node scripts/check-mobile-bundle.mts [path]   (default dist/main.mobile.js)
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';

/** Modules Geode's mobile `require` shim resolves. Keep in sync with esbuild.config.mjs. */
export const ALLOWED_REQUIRES: readonly string[] = [
  'obsidian',
  'geode',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/autocomplete',
  '@lezer/common',
  '@lezer/highlight',
];

/** Our own budget: well under Geode's hard 16 MiB limit. */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

export async function scanMobileBundle(code: string, bytes = Buffer.byteLength(code)): Promise<string[]> {
  const violations: string[] = [];
  if (bytes > MAX_BUNDLE_BYTES) {
    violations.push(`bundle is ${bytes} bytes; budget is ${MAX_BUNDLE_BYTES}`);
  }

  // require(): only string literals from the allow-list.
  for (const match of code.matchAll(/(?<![\w$.])require\s*\(\s*([^)]*?)\s*\)/g)) {
    const arg = match[1];
    const literal = /^(["'`])([^"'`]*)\1$/.exec(arg);
    if (!literal) {
      violations.push(`non-literal require(${arg.slice(0, 40)})`);
    } else if (!ALLOWED_REQUIRES.includes(literal[2])) {
      violations.push(`forbidden require("${literal[2]}")`);
    }
  }

  // ESM syntax, exactly as Geode's preflight sees it.
  await init;
  try {
    const [imports, exports] = parse(code);
    for (const imp of imports) {
      const kind = imp.d === -1 ? 'static import' : imp.d === -2 ? 'import.meta' : 'dynamic import()';
      violations.push(`${kind} at offset ${imp.ss}: ${code.slice(imp.ss, imp.ss + 40).replace(/\s+/g, ' ')}`);
    }
    for (const exp of exports) violations.push(`ESM export "${exp.n}"`);
  } catch (error) {
    violations.push(`es-module-lexer failed to parse bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  return violations;
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'dist/main.mobile.js';
  const code = readFileSync(file, 'utf8');
  const violations = await scanMobileBundle(code, statSync(file).size);
  if (violations.length > 0) {
    console.error(`${file} failed the Geode mobile bundle check:`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`${file} OK (${(statSync(file).size / 1024).toFixed(0)} KB, requires within allow-list)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
