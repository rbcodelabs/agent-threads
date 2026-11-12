import { DocCorpus } from './docIndex';
import type { HelpProviderRegistry } from './HelpRegistry';

/**
 * README.md and docs/*.md (top level only: no adr/, qa/, mockups/ or images), inlined at build time by
 * esbuild.config.mjs via `define`, so the docs ship inside main.js and need no extra release asset.
 * Undefined in unit tests and unbundled runs.
 */
declare const __AGENT_THREADS_HELP_DOCS__: Record<string, string> | undefined;

export function bundledHelpDocs(): Record<string, string> | undefined {
  return typeof __AGENT_THREADS_HELP_DOCS__ !== 'undefined' ? __AGENT_THREADS_HELP_DOCS__ : undefined;
}

/** Registers `agent-threads.docs`. The index is built lazily on the first help call, so startup pays nothing. */
export function registerAgentThreadsDocs(
  registry: HelpProviderRegistry, options: { bundled?: Record<string, string> } = {},
): { dispose: () => void } {
  const bundled = options.bundled ?? bundledHelpDocs();
  let corpus: Promise<DocCorpus> | null = null;
  return registry.registerBuiltInDocs(() => {
    corpus ??= Promise.resolve(new DocCorpus(Object.entries(bundled ?? {}).map(([path, text]) => ({ path, text }))));
    return corpus;
  });
}
