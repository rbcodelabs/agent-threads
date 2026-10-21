// esbuild `inject`: free `Buffer` references resolve here. Real Node/Electron Buffer wins; the
// pure-JS `buffer` package is only a fallback for the mobile WebView, which has no Buffer.
import { Buffer as PolyfillBuffer } from '../node_modules/buffer/index.js';
export const Buffer = globalThis.Buffer || PolyfillBuffer;
