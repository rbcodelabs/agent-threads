/**
 * PNG encoding shared by the MCP screenshot tool and the preview pane.
 *
 * Deliberately avoids Node's `Buffer`: both callers are reachable from the
 * renderer bundle, which `test/unit/bundle-safety.test.ts` guards against Node
 * built-ins being pulled into module-init scope.
 */

/**
 * Base64-encode bytes using `btoa` over a chunked binary string.
 *
 * The chunking is not incidental. `String.fromCharCode(...bytes)` spreads every
 * byte into an argument list, and a full-size screenshot is large enough to blow
 * the engine's argument limit and throw.
 */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** A `data:` URL suitable for assigning straight to an `<img>` src. */
export function pngDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${base64FromBytes(bytes)}`;
}
