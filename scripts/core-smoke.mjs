#!/usr/bin/env node
/**
 * Core smoke test: bundle every daemon entry module for plain Node with
 * `obsidian` aliased to a stub that throws on load, then load the bundle in a
 * fresh Node process (no vitest, no Obsidian, no DOM). Prints
 * `core loads without obsidian` on success; exits non-zero otherwise.
 *
 * Complements tsconfig.core.json (compile time) and core-boundary.test.ts
 * (static closure): this proves the closure actually evaluates.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entries = [
  'ThreadManager', 'ThreadSession', 'ClaudeSession', 'CodexSession',
  'OpenCodeSession', 'Scheduler', 'HarnessFactory',
];

const out = mkdtempSync(join(tmpdir(), 'core-smoke-'));
try {
  const outfile = join(out, 'core.cjs');
  const contents = [
    ...entries.map((name, i) => `import * as m${i} from './src/${name}.ts';`),
    `const mods = { ${entries.map((name, i) => `${name}: m${i}`).join(', ')} };`,
    'for (const [name, mod] of Object.entries(mods)) {',
    '  if (Object.keys(mod).length === 0) throw new Error(`${name} exported nothing`);',
    '}',
    "console.log('core loads without obsidian');",
  ].join('\n');

  await esbuild.build({
    stdin: { contents, resolveDir: root, sourcefile: 'core-smoke-entry.ts', loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2020',
    outfile,
    logLevel: 'error',
    alias: { obsidian: join(root, 'scripts/core/obsidian-throwing-stub.cjs') },
    // Same shim as esbuild.config.mjs: the Agent SDK reads import.meta.url at top level.
    banner: { js: 'var __importMetaUrl = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : "file:///core/core.cjs";' },
    define: { 'import.meta.url': '__importMetaUrl' },
    plugins: [{
      name: 'claude-agent-sdk-core',
      setup(build) {
        build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
          path: createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk/core'),
        }));
      },
    }],
  });

  // A fresh Node process with no Obsidian/DOM globals; inherit stdout so the
  // success line comes from the loaded bundle itself.
  execFileSync(process.execPath, [outfile], { stdio: 'inherit', cwd: out });
} finally {
  rmSync(out, { recursive: true, force: true });
}
