import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const isWatch = process.argv.includes('--watch');
const outdir = path.join(__dirname, 'dist');

if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [{
    name: 'claude-agent-sdk-core',
    setup(build) {
      // The root SDK bundle inlines its MCP implementation. This plugin already
      // bundles @modelcontextprotocol/sdk for the host bridge, so resolve the
      // exact root import to the documented peer-dependency-aware core entry
      // and avoid shipping two copies. Subpaths such as /browser are untouched.
      build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
        path: require.resolve('@anthropic-ai/claude-agent-sdk/core'),
      }));
    },
  }],
  external: [
    'obsidian',
    'electron',
    'codemirror',
    '@codemirror/autocomplete',
    '@codemirror/closebrackets',
    '@codemirror/commands',
    '@codemirror/fold',
    '@codemirror/gutter',
    '@codemirror/highlight',
    '@codemirror/history',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/matchbrackets',
    '@codemirror/panel',
    '@codemirror/rangeset',
    '@codemirror/rectangular-selection',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/stream-parser',
    '@codemirror/text',
    '@codemirror/tooltip',
    '@codemirror/view',
  ],
  format: 'cjs',
  target: 'es2020',
  platform: 'node',
  logLevel: 'info',
  sourcemap: 'inline',
  treeShaking: true,
  outfile: 'dist/main.js',
  // The claude-agent-sdk calls createRequire(import.meta.url) at the top level of sdk.mjs.
  // When bundled to CJS, esbuild sets import_meta={} so import_meta.url===undefined,
  // crashing the plugin on load. Define import.meta.url at runtime via __filename.
  banner: {
    js: 'var __importMetaUrl = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : "file:///plugin/main.js";',
  },
  define: {
    'import.meta.url': '__importMetaUrl',
  },
});

// Copy static assets
fs.copyFileSync('manifest.json', 'dist/manifest.json');
if (fs.existsSync('styles.css')) fs.copyFileSync('styles.css', 'dist/styles.css');

// Bundle the thread-orchestrator skill (and any future resources/skills/*) into
// dist/ so it ships with the plugin and is discoverable with nothing manually
// copied into ~/.claude/skills/. See ThreadManager.buildSessionOptions().
if (fs.existsSync('resources/skills')) {
  fs.cpSync('resources/skills', 'dist/resources/skills', { recursive: true });
}

if (isWatch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Build complete');
}
