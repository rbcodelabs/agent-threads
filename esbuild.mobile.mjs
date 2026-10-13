// Build options for dist/main.mobile.js, the slim Geode-mobile bundle.
//
// Geode's mobile runtime (iOS WKWebView, no Node/Electron) hard-rejects
// entrypoints over 16 MiB and its CommonJS `require` shim only resolves the
// modules listed below, so the desktop main.js (~20 MB, node builtins, Agent
// SDK) cannot run there. This is a separate entry that bundles only the
// relay/pairing/mobile-view path. Obsidian ignores the extra file.
//
// Shared with the unit tests so they build the same bundle without touching
// dist/. scripts/check-mobile-bundle.mts enforces the require allow-list.

/** Must match ALLOWED_REQUIRES in scripts/check-mobile-bundle.mts (a test asserts it). */
export const MOBILE_EXTERNALS = [
  'obsidian',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/autocomplete',
  '@lezer/common',
  '@lezer/highlight',
];

/** @type {import('esbuild').BuildOptions} */
export const mobileBuildOptions = {
  entryPoints: ['src/mobile-main.ts'],
  bundle: true,
  external: MOBILE_EXTERNALS,
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  logLevel: 'info',
  treeShaking: true,
};
