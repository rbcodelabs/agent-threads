import { describe, it, expect } from 'vitest';
import * as zlib from 'zlib';
import {
  COMPUTED_STYLE_ALLOWLIST,
  MAX_COMMENT_LENGTH,
  MAX_SCREENSHOT_BYTES,
  validateWebViewerFeedbackRequest,
  validateWebViewerPageTarget,
} from '../../src/webViewerFeedback/validation';
import type {
  WebViewerElementSelection,
  WebViewerFeedbackRequest,
  WebViewerPageTarget,
} from '../../src/webViewerFeedback/contract';

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
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

describe('validateWebViewerPageTarget', () => {
  it('accepts valid http and https page targets', () => {
    const httpRes = validateWebViewerPageTarget({
      url: 'http://127.0.0.1:5173/dashboard',
      origin: 'http://127.0.0.1:5173',
      title: 'Dashboard',
    });
    expect(httpRes.ok).toBe(true);

    const httpsRes = validateWebViewerPageTarget({
      url: 'https://staging.example.com:8443/app/settings',
      origin: 'https://staging.example.com:8443',
      title: '',
    });
    expect(httpsRes.ok).toBe(true);
  });

  it('rejects non-HTTP(S) URL schemes such as javascript:, file:, and data:', () => {
    for (const bad of [
      { url: 'javascript:alert(1)', origin: 'null', title: 'XSS' },
      { url: 'file:///Users/alice/secret.html', origin: 'null', title: 'Local' },
      { url: 'data:text/html,<h1>hi</h1>', origin: 'null', title: 'Data' },
    ]) {
      const res = validateWebViewerPageTarget(bad);
      expect(res.ok).toBe(false);
    }
  });

  it('rejects origin mismatch or oversized URL / title', () => {
    const mismatch: WebViewerPageTarget = {
      url: 'https://evil.example.com/phish',
      origin: 'http://localhost:3000',
      title: 'Home',
    };
    expect(validateWebViewerPageTarget(mismatch).ok).toBe(false);

    const longUrl = validateWebViewerPageTarget({
      url: `https://example.com/${'a'.repeat(2048)}`,
      origin: 'https://example.com',
      title: 'Home',
    });
    expect(longUrl.ok).toBe(false);

    const longTitle = validateWebViewerPageTarget({
      url: 'https://example.com/',
      origin: 'https://example.com',
      title: 'T'.repeat(501),
    });
    expect(longTitle.ok).toBe(false);
  });
});

describe('validateWebViewerFeedbackRequest', () => {
  it('accepts a valid request with PNG screenshot and trims surrounding comment whitespace', () => {
    const req = makeValidRequest({ comment: '  Align icon and text vertically.  ' });
    const res = validateWebViewerFeedbackRequest(req);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.comment).toBe('Align icon and text vertically.');
    expect(res.value.screenshot?.width).toBe(156);
    expect(res.value.screenshot?.height).toBe(56);
    // Ensures defensive copy of Uint8Array
    expect(res.value.screenshot?.bytes).not.toBe(req.screenshot?.bytes);
  });

  it('has all 40 allowlisted computed style properties', () => {
    expect(COMPUTED_STYLE_ALLOWLIST).toHaveLength(40);
    const allStyles: Record<string, string> = {};
    for (const prop of COMPUTED_STYLE_ALLOWLIST) {
      allStyles[prop] = 'inherit';
    }
    const res = validateWebViewerFeedbackRequest(
      makeValidRequest({ selection: makeValidSelection({ computedStyles: allStyles }) }),
    );
    expect(res.ok).toBe(true);
  });

  it('rejects own __proto__, constructor, or prototype keys on computedStyles or nested objects', () => {
    const poisonedStyles = JSON.parse('{"display":"flex","__proto__":{"polluted":true}}') as Record<
      string,
      string
    >;
    const resProto = validateWebViewerFeedbackRequest(
      makeValidRequest({ selection: makeValidSelection({ computedStyles: poisonedStyles }) }),
    );
    expect(resProto.ok).toBe(false);

    const constructorStyles: Record<string, string> = Object.create(null);
    constructorStyles.constructor = 'bad';
    const resCtor = validateWebViewerFeedbackRequest(
      makeValidRequest({ selection: makeValidSelection({ computedStyles: constructorStyles }) }),
    );
    expect(resCtor.ok).toBe(false);
  });

  it('rejects unallowlisted computedStyles keys or overly long style values', () => {
    const unallowlisted = validateWebViewerFeedbackRequest(
      makeValidRequest({
        selection: makeValidSelection({
          computedStyles: { display: 'block', 'pointer-events': 'none' },
        }),
      }),
    );
    expect(unallowlisted.ok).toBe(false);

    const tooLong = validateWebViewerFeedbackRequest(
      makeValidRequest({
        selection: makeValidSelection({
          computedStyles: { 'background-image': `url(${'x'.repeat(205)})` },
        }),
      }),
    );
    expect(tooLong.ok).toBe(false);
  });

  it('enforces comment length bounds (1..4000 trimmed UTF-16 units) and threadId bounds', () => {
    expect(validateWebViewerFeedbackRequest(makeValidRequest({ comment: '   \n\t  ' })).ok).toBe(
      false,
    );
    expect(
      validateWebViewerFeedbackRequest(makeValidRequest({ comment: 'a'.repeat(MAX_COMMENT_LENGTH) }))
        .ok,
    ).toBe(true);
    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({ comment: 'a'.repeat(MAX_COMMENT_LENGTH + 1) }),
      ).ok,
    ).toBe(false);

    expect(validateWebViewerFeedbackRequest(makeValidRequest({ threadId: '   ' })).ok).toBe(false);
    expect(
      validateWebViewerFeedbackRequest(makeValidRequest({ threadId: 't'.repeat(257) })).ok,
    ).toBe(false);
  });

  it('enforces mutual exclusivity between screenshot and screenshotOmitted', () => {
    // Both null -> invalid
    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({ screenshot: null, screenshotOmitted: null }),
      ).ok,
    ).toBe(false);

    // Screenshot omitted with valid reason -> valid
    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({ screenshot: null, screenshotOmitted: 'too-large' }),
      ).ok,
    ).toBe(true);

    // Both non-null -> invalid
    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({ screenshotOmitted: 'capture-failed' }),
      ).ok,
    ).toBe(false);
  });

  it('rejects non-PNG magic bytes, IHDR dimension mismatch, or oversized PNG buffers', () => {
    // Bad magic header
    const badMagic = makeValidPngBytes(156, 56);
    badMagic[0] = 0xff;
    badMagic[1] = 0xd8; // JPEG SOI
    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({
          screenshot: {
            ...makeValidRequest().screenshot!,
            bytes: badMagic,
          },
        }),
      ).ok,
    ).toBe(false);

    // IHDR width/height mismatch against declared width/height
    const mismatchedPng = makeValidPngBytes(80, 40);
    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({
          screenshot: {
            ...makeValidRequest().screenshot!,
            bytes: mismatchedPng,
            width: 156,
            height: 56,
          },
        }),
      ).ok,
    ).toBe(false);

    // Oversized buffer > 524288 bytes
    const huge = new Uint8Array(MAX_SCREENSHOT_BYTES + 1);
    huge.set(makeValidPngBytes(156, 56), 0);
    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({
          screenshot: {
            ...makeValidRequest().screenshot!,
            bytes: huge,
          },
        }),
      ).ok,
    ).toBe(false);
  });

  it('rejects malformed selectionId, invalid tag names, non-positive viewport/box dimensions, and out-of-range tabIndex', () => {
    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({
          selection: makeValidSelection({ selectionId: 'sel_NOT_HEX_0123456789abcdef0123' }),
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({
          selection: makeValidSelection({ tag: 'BUTTON' }),
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({
          selection: makeValidSelection({
            viewport: { width: 0, height: 844, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
          }),
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateWebViewerFeedbackRequest(
        makeValidRequest({
          selection: makeValidSelection({
            a11y: { role: 'button', name: 'Pay', tabIndex: -2 },
          }),
        }),
      ).ok,
    ).toBe(false);
  });
});
