import { build } from 'esbuild';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolve = (...parts) => path.resolve(__dirname, ...parts);

// Regenerate the Lucide icon map before bundling so it can never drift from
// src/. The generator hard-fails on an icon name it cannot resolve, which is
// deliberate: a silent fallback is what let 46 icons render as placeholder
// circles in the baselines for months.
execFileSync(
  process.execPath,
  [resolve('../../scripts/gen-harness-icons.mts')],
  { stdio: 'inherit' },
);

const sharedConfig = {
  format: 'iife',
  platform: 'browser',
  sourcemap: true,
  bundle: true,
  alias: {
    'obsidian':                         resolve('./obsidian-mock.ts'),
    'fs':                               resolve('./mocks/fs.ts'),
    'fs/promises':                      resolve('./mocks/fs-promises.ts'),
    'path':                             resolve('./mocks/path.ts'),
    'os':                               resolve('./mocks/os.ts'),
    // child_process is statically imported by ThreadsView — stub it so the
    // IIFE bundle doesn't crash at load time in the browser harness.
    'child_process':                    resolve('./mocks/child-process.ts'),
    // crypto is statically imported by skillManager (createHash, for the
    // deterministic skill-source id) — stub it for the same reason.
    'crypto':                           resolve('./mocks/crypto.ts'),
    // http is required lazily by OpenCodeSession / OpenCodeHostTools, which
    // HarnessFactory pulls in; the harness never starts an OpenCode session.
    'http':                             resolve('./mocks/http.ts'),
    // electron is used in dynamic require() calls inside click handlers;
    // inject a no-op so those code paths don't crash when reached in tests.
    'electron':                         resolve('./mocks/electron.ts'),
    // adm-zip pulls in Node's zlib/crypto internally, which the browser
    // platform target can't resolve — stub it out (see mocks/adm-zip.ts).
    'adm-zip':                          resolve('./mocks/adm-zip.ts'),
    '@anthropic-ai/claude-agent-sdk':   resolve('./mocks/claude-sdk.ts'),
  },
  define: {
    'process.env':          '{}',
    'process.env.HOME':     '"/Users/mock"',
    'process.env.PATH':     '"/usr/local/bin"',
  },
};

await build({
  ...sharedConfig,
  entryPoints: [resolve('./index.ts')],
  outfile: resolve('./dist/bundle.js'),
});

await build({
  ...sharedConfig,
  entryPoints: [resolve('./mobile-index.ts')],
  outfile: resolve('./dist/mobile-bundle.js'),
});

await build({
  ...sharedConfig,
  entryPoints: [resolve('./skills-index.ts')],
  outfile: resolve('./dist/skills-bundle.js'),
});

await build({
  ...sharedConfig,
  entryPoints: [resolve('./settings-index.ts')],
  outfile: resolve('./dist/settings-bundle.js'),
});

await build({
  ...sharedConfig,
  entryPoints: [resolve('./kanban-index.ts')],
  outfile: resolve('./dist/kanban-bundle.js'),
});

console.log('[harness] bundles built → test/harness/dist/ (bundle.js, mobile-bundle.js, skills-bundle.js, settings-bundle.js, kanban-bundle.js)');
