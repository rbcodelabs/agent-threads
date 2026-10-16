import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Second esbuild entry (design section 5.3): the headless daemon as one CJS
// file that runs with plain `node dist/agent-threads.cjs serve`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

await esbuild.build({
  entryPoints: ['daemon/main.ts'],
  outfile: 'dist/agent-threads.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'info',
  // Optional native accelerators of `ws`; it falls back to pure JS without them.
  external: ['bufferutil', 'utf-8-validate'],
  // `obsidian` and `electron` must never be reachable. If an import sneaks in,
  // fail the build loudly instead of shipping a bundle that throws at runtime.
  plugins: [
    {
      name: 'forbid-host-modules',
      setup(build) {
        build.onResolve({ filter: /^(obsidian|electron)$/ }, (args) => ({
          errors: [{ text: `daemon bundle must not import "${args.path}" (imported from ${path.relative(__dirname, args.importer)})` }],
        }));
      },
    },
    {
      // Same as esbuild.config.mjs: the root SDK bundle inlines its MCP implementation; the
      // /core entry is the documented peer-dependency-aware one, so there is one copy.
      name: 'claude-agent-sdk-core',
      setup(build) {
        build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
          path: require.resolve('@anthropic-ai/claude-agent-sdk/core'),
        }));
      },
    },
  ],
  // The Agent SDK reads import.meta.url at top level, which is empty in a CJS bundle
  // (same shim as esbuild.config.mjs / scripts/core-smoke.mjs).
  banner: {
    js: 'var __importMetaUrl = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : "file:///daemon/agent-threads.cjs";',
  },
  define: { __DAEMON_VERSION__: JSON.stringify(pkg.version), 'import.meta.url': '__importMetaUrl' },
});

// Executable launcher next to the bundle's package for `npm i -g` / PATH use.
fs.chmodSync(path.join(__dirname, 'bin/agent-threads'), 0o755);
console.log('Daemon build complete: dist/agent-threads.cjs');
