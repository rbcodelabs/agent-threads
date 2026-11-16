import * as zlib from 'zlib';
import type {
  WebViewerElementSelection,
  WebViewerFeedbackRequest,
} from '../../../src/webViewerFeedback/contract';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

export function makeValidPngBytes(width = 24, height = 16): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawScanlines = Buffer.alloc(height * (1 + width * 4));
  const idatData = zlib.deflateSync(rawScanlines);

  return new Uint8Array(
    Buffer.concat([
      signature,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', idatData),
      pngChunk('IEND', new Uint8Array(0)),
    ]),
  );
}

export function makeValidSelection(
  overrides: Partial<WebViewerElementSelection> = {},
): WebViewerElementSelection {
  return {
    schemaVersion: 1,
    selectionId: 'sel_0123456789abcdef0123456789abcdef',
    viewSessionId: 'wv_session_1',
    viewportPreset: 'mobile',
    capturedAt: '2026-11-15T22:00:00.000Z',
    route: '/billing/invoices?tab=open',
    tag: 'button',
    selector: '#pay-invoice-btn',
    selectorAlternates: ['[data-testid="pay-btn"]', 'button.invoice-pay'],
    textAnchor: { tag: 'button', text: 'Pay invoice' },
    landmark: 'Billing Summary',
    outerHTML: {
      html: '<button id="pay-invoice-btn" data-testid="pay-btn" class="invoice-pay">Pay invoice</button>',
      truncated: false,
    },
    ancestors: [
      { tag: 'div', id: 'invoice-actions', classes: ['actions-row', 'flex'] },
      { tag: 'section', id: null, classes: ['billing-panel'] },
    ],
    computedStyles: {
      display: 'inline-flex',
      'font-size': '14px',
      'background-color': 'rgb(37, 99, 235)',
      'border-radius': '6px',
    },
    boundingBox: {
      viewport: { x: 24, y: 180, width: 140, height: 40 },
      document: { x: 24, y: 420, width: 140, height: 40 },
    },
    viewport: {
      width: 390,
      height: 844,
      devicePixelRatio: 2,
      scrollX: 0,
      scrollY: 240,
    },
    a11y: {
      role: 'button',
      name: 'Pay invoice',
      tabIndex: 0,
    },
    ...overrides,
  };
}

export function makeValidRequest(
  overrides: Partial<WebViewerFeedbackRequest> = {},
): WebViewerFeedbackRequest {
  const pngBytes = makeValidPngBytes(156, 56);
  return {
    contractVersion: 1,
    page: {
      url: 'http://localhost:3000/billing/invoices?tab=open',
      origin: 'http://localhost:3000',
      title: 'Invoices — Acme App',
    },
    threadId: 'thread-123',
    comment: 'Make this button full width on mobile.',
    selection: makeValidSelection(),
    screenshot: {
      mimeType: 'image/png',
      bytes: pngBytes,
      width: 156,
      height: 56,
      cssRect: { x: 16, y: 172, width: 156, height: 56 },
      devicePixelRatio: 2,
      downscaled: false,
    },
    screenshotOmitted: null,
    stale: false,
    submittedAt: '2026-11-15T22:00:05.000Z',
    ...overrides,
  };
}
