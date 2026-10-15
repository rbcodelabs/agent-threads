/**
 * Random identifiers from the platform CSPRNG (`globalThis.crypto`, present in Electron, mobile webviews and Node 19+).
 * No Node-only import, so core-boundary files can use it. There is deliberately no `Math.random` fallback: an id
 * that names a command, a message or a seat must not be guessable, and a runtime without a CSPRNG is not one we serve.
 */
export function randomHex(bytes = 8): string {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('no secure random source available (globalThis.crypto)');
  return Array.from(c.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
