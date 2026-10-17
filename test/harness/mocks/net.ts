/**
 * Stub for Node's net module in the Playwright browser harness.
 *
 * localDaemon/wiring require('net') lazily to probe a host loopback port, but
 * esbuild still resolves the specifier when the bundle pulls main in. The
 * harness has no local daemon, so any call here is a bug and fails loudly.
 */
function unavailable(): never {
  throw new Error('net is unavailable in the screenshot harness');
}

export const createServer = unavailable;
export const connect = unavailable;
export const createConnection = unavailable;
export default { createServer, connect, createConnection };
