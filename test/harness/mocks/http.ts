/**
 * Stub for Node's http module in the Playwright browser harness.
 *
 * OpenCodeSession and its host-tool MCP bridge require('http') lazily, but
 * esbuild still resolves the specifier when ThreadManager pulls HarnessFactory
 * into the bundle. The harness never starts an OpenCode session, so any call
 * here is a bug and fails loudly.
 */
function unavailable(): never {
  throw new Error('http is unavailable in the screenshot harness');
}

export const createServer = unavailable;
export const request = unavailable;
export const get = unavailable;
export default { createServer, request, get };
