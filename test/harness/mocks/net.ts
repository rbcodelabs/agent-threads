/**
 * Stub for Node's net module in the Playwright browser harness.
 *
 * vmPortForward require('net') lazily to open host loopback listeners for the
 * sandbox VM, but esbuild still resolves the specifier when the bundle pulls
 * ObsidianTools in. The harness has no sandbox container, so any call here is
 * a bug and fails loudly.
 */
function unavailable(): never {
  throw new Error('net is unavailable in the screenshot harness');
}

export const createServer = unavailable;
export const connect = unavailable;
export const createConnection = unavailable;
export default { createServer, connect, createConnection };
