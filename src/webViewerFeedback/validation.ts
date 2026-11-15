import type {
  WebViewerElementScreenshot,
  WebViewerElementSelection,
  WebViewerFeedbackRequest,
  WebViewerPageTarget,
  WebViewerRect,
  WebViewerScreenshotOmittedReason,
  WebViewerViewportPreset,
} from './contract';

/**
 * Independent defensive runtime validation for Web Viewer element feedback.
 *
 * Even though Geode validates payloads on the embedder side, the plugin re-validates
 * every field and rebuilds clean plain objects from allowlisted keys so unknown
 * properties, prototype-pollution keys, bad URL schemes, or malformed PNG buffers
 * never reach prompt construction or session image attachments.
 */

export const SELECTION_ID_PATTERN = /^sel_[0-9a-f]{32}$/;
export const TAG_PATTERN = /^[a-z][a-z0-9:-]{0,31}$/;
export const MAX_URL_LENGTH = 2048;
export const MAX_PAGE_TITLE_LENGTH = 500;
export const MAX_THREAD_ID_LENGTH = 256;
export const MAX_COMMENT_LENGTH = 4000;
export const MAX_SCREENSHOT_BYTES = 524_288;

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_NUMBER_MAGNITUDE = 1e6;
const MAX_SCAN_NODES = 2000;
const MAX_ARRAY_LENGTH = 64;
const MAX_OBJECT_KEYS = 256;
const MAX_SCAN_DEPTH = 8;
const MAX_RAW_COMMENT_LENGTH = 65_536;

const VIEWPORT_PRESETS: readonly WebViewerViewportPreset[] = [
  'desktop',
  'tablet',
  'mobile',
  'custom',
  'fill',
];

const SCREENSHOT_OMITTED_REASONS: readonly WebViewerScreenshotOmittedReason[] = [
  'too-large',
  'capture-failed',
  'empty-rect',
];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52] as const; // "IHDR"
const MIN_PNG_HEADER_BYTES = 24; // 8-byte signature + 4-byte length + 4-byte "IHDR" + 4-byte width + 4-byte height

/** Exact 40-property inspector computed-style allowlist shared with Geode. */
export const COMPUTED_STYLE_ALLOWLIST: readonly string[] = [
  'display', 'position', 'z-index', 'opacity', 'overflow', 'visibility',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap', 'grid-template-columns',
  'width', 'height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'box-sizing',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'text-align', 'text-transform', 'text-decoration-line', 'color', 'background-color', 'background-image',
  'border-top-width', 'border-top-style', 'border-top-color', 'border-radius', 'box-shadow', 'transform',
];

const COMPUTED_STYLE_SET: ReadonlySet<string> = new Set(COMPUTED_STYLE_ALLOWLIST);

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

class ValidationError extends Error {}

function fail(message: string): never {
  throw new ValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || ArrayBuffer.isView(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${name} must be a plain object.`);
  return value;
}

function str(value: unknown, name: string, max: number, min = 0): string {
  if (typeof value !== 'string') fail(`${name} must be a string.`);
  if (value.length < min) fail(`${name} must be at least ${min} character(s).`);
  if (value.length > max) fail(`${name} exceeds maximum length of ${max}.`);
  return value;
}

function nullableStr(value: unknown, name: string, max: number): string | null {
  return value === null ? null : str(value, name, max);
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean.`);
  return value;
}

function num(
  value: unknown,
  name: string,
  opts: {
    min?: number;
    exclusiveMin?: number;
    max?: number;
    integer?: boolean;
  } = {},
): number {
  const min = opts.min ?? -MAX_NUMBER_MAGNITUDE;
  const max = opts.max ?? MAX_NUMBER_MAGNITUDE;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${name} must be a finite number.`);
  }
  if (value < min || value > max) {
    fail(`${name} is out of range.`);
  }
  if (opts.exclusiveMin !== undefined && value <= opts.exclusiveMin) {
    fail(`${name} must be greater than ${opts.exclusiveMin}.`);
  }
  if (opts.integer && !Number.isInteger(value)) {
    fail(`${name} must be an integer.`);
  }
  return value;
}

function parseTag(value: unknown, name: string): string {
  const text = str(value, name, 32, 1);
  if (!TAG_PATTERN.test(text)) fail(`${name} is not a valid HTML/SVG tag name.`);
  return text;
}

function parseIsoTimestamp(value: unknown, name: string): string {
  const text = str(value, name, 64, 1);
  if (!ISO_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    fail(`${name} must be a valid ISO 8601 timestamp.`);
  }
  return text;
}

function parsePositiveRect(value: unknown, name: string): WebViewerRect {
  const r = record(value, name);
  return {
    x: num(r.x, `${name}.x`),
    y: num(r.y, `${name}.y`),
    width: num(r.width, `${name}.width`, { exclusiveMin: 0 }),
    height: num(r.height, `${name}.height`, { exclusiveMin: 0 }),
  };
}

function isUint8ArrayView(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]')
  );
}

/**
 * Bounded structural scan rejecting deep nesting, oversized containers, non-plain
 * prototypes, and prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
 */
function assertSafeStructure(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 1;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) continue;
    if (depth > MAX_SCAN_DEPTH) fail('Input is nested too deeply.');
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) fail('Input contains an array that is too long.');
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          if (++visited > MAX_SCAN_NODES) fail('Input contains too many nodes.');
          stack.push({ value: item, depth: depth + 1 });
        }
      }
      continue;
    }
    if (!isPlainObject(value)) fail('Input contains a non-plain object.');
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length > MAX_OBJECT_KEYS) fail('Input contains an object with too many keys.');
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) fail(`Forbidden key "${key}" is not allowed.`);
      const child = value[key];
      if (typeof child === 'object' && child !== null) {
        if (++visited > MAX_SCAN_NODES) fail('Input contains too many nodes.');
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

function parsePageTarget(input: unknown): WebViewerPageTarget {
  const p = record(input, 'page');
  const url = str(p.url, 'page.url', MAX_URL_LENGTH, 1);
  if (/[\u0000-\u001f\u007f]/.test(url)) fail('page.url contains control characters.');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail('page.url is not a valid URL.');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    fail('page.url must use http: or https: protocol.');
  }
  const origin = str(p.origin, 'page.origin', 512, 1);
  if (origin === 'null' || origin !== parsedUrl.origin) {
    fail('page.origin does not match page.url origin.');
  }
  const title = str(p.title, 'page.title', MAX_PAGE_TITLE_LENGTH, 0);
  return { url, origin, title };
}

function parseComputedStyles(value: unknown): Readonly<Record<string, string>> {
  const raw = record(value, 'selection.computedStyles');
  const out: Record<string, string> = {};
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`Forbidden computedStyles key "${key}".`);
    if (!COMPUTED_STYLE_SET.has(key)) {
      fail(`selection.computedStyles key "${key}" is not in the allowlist.`);
    }
    out[key] = str(raw[key], `selection.computedStyles.${key}`, 200);
  }
  return out;
}

function parseAncestors(value: unknown): WebViewerElementSelection['ancestors'] {
  if (!Array.isArray(value) || value.length > 3) {
    fail('selection.ancestors must be an array of at most 3 items.');
  }
  return value.map((entry, index) => {
    const a = record(entry, `selection.ancestors[${index}]`);
    if (!Array.isArray(a.classes) || a.classes.length > 8) {
      fail(`selection.ancestors[${index}].classes must be an array of at most 8 items.`);
    }
    return {
      tag: parseTag(a.tag, `selection.ancestors[${index}].tag`),
      id: nullableStr(a.id, `selection.ancestors[${index}].id`, 128),
      classes: a.classes.map((cls, cIdx) =>
        str(cls, `selection.ancestors[${index}].classes[${cIdx}]`, 64),
      ),
    };
  });
}

function parseSelection(value: unknown): WebViewerElementSelection {
  const s = record(value, 'selection');
  if (s.schemaVersion !== 1) fail('Unsupported selection.schemaVersion.');
  const selectionId = str(s.selectionId, 'selection.selectionId', 64, 1);
  if (!SELECTION_ID_PATTERN.test(selectionId)) {
    fail('selection.selectionId does not match expected format.');
  }
  const viewSessionId = str(s.viewSessionId, 'selection.viewSessionId', 256, 1);
  if (viewSessionId.trim().length === 0) {
    fail('selection.viewSessionId must not be blank.');
  }
  const preset = s.viewportPreset;
  if (!VIEWPORT_PRESETS.includes(preset as WebViewerViewportPreset)) {
    fail('Unsupported selection.viewportPreset.');
  }
  const capturedAt = parseIsoTimestamp(s.capturedAt, 'selection.capturedAt');
  const route = str(s.route, 'selection.route', 512);
  const tag = parseTag(s.tag, 'selection.tag');
  const selector = str(s.selector, 'selection.selector', 512, 1);
  if (selector.trim().length === 0) fail('selection.selector must not be blank.');

  if (!Array.isArray(s.selectorAlternates) || s.selectorAlternates.length > 3) {
    fail('selection.selectorAlternates must be an array of at most 3 items.');
  }
  const selectorAlternates = s.selectorAlternates.map((alt, idx) =>
    str(alt, `selection.selectorAlternates[${idx}]`, 512),
  );

  const textAnchorRaw = record(s.textAnchor, 'selection.textAnchor');
  const textAnchor = {
    tag: parseTag(textAnchorRaw.tag, 'selection.textAnchor.tag'),
    text: str(textAnchorRaw.text, 'selection.textAnchor.text', 80),
  };

  const landmark = nullableStr(s.landmark, 'selection.landmark', 120);

  const outerRaw = record(s.outerHTML, 'selection.outerHTML');
  const outerHTML = {
    html: str(outerRaw.html, 'selection.outerHTML.html', 4096),
    truncated: bool(outerRaw.truncated, 'selection.outerHTML.truncated'),
  };

  const ancestors = parseAncestors(s.ancestors);
  const computedStyles = parseComputedStyles(s.computedStyles);

  const boxRaw = record(s.boundingBox, 'selection.boundingBox');
  const boundingBox = {
    viewport: parsePositiveRect(boxRaw.viewport, 'selection.boundingBox.viewport'),
    document: parsePositiveRect(boxRaw.document, 'selection.boundingBox.document'),
  };

  const viewportRaw = record(s.viewport, 'selection.viewport');
  const viewport = {
    width: num(viewportRaw.width, 'selection.viewport.width', { exclusiveMin: 0 }),
    height: num(viewportRaw.height, 'selection.viewport.height', { exclusiveMin: 0 }),
    devicePixelRatio: num(viewportRaw.devicePixelRatio, 'selection.viewport.devicePixelRatio', {
      exclusiveMin: 0,
      max: 16,
    }),
    scrollX: num(viewportRaw.scrollX, 'selection.viewport.scrollX'),
    scrollY: num(viewportRaw.scrollY, 'selection.viewport.scrollY'),
  };

  const a11yRaw = record(s.a11y, 'selection.a11y');
  const tabIndex =
    a11yRaw.tabIndex === null
      ? null
      : num(a11yRaw.tabIndex, 'selection.a11y.tabIndex', {
          min: -1,
          max: 32767,
          integer: true,
        });
  const a11y = {
    role: nullableStr(a11yRaw.role, 'selection.a11y.role', 64),
    name: nullableStr(a11yRaw.name, 'selection.a11y.name', 200),
    tabIndex,
  };

  return {
    schemaVersion: 1,
    selectionId,
    viewSessionId,
    viewportPreset: preset as WebViewerViewportPreset,
    capturedAt,
    route,
    tag,
    selector,
    selectorAlternates,
    textAnchor,
    landmark,
    outerHTML,
    ancestors,
    computedStyles,
    boundingBox,
    viewport,
    a11y,
  };
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset, false);
}

function parseScreenshot(value: unknown): WebViewerElementScreenshot {
  const s = record(value, 'screenshot');
  if (s.mimeType !== 'image/png') fail('screenshot.mimeType must be "image/png".');
  if (!isUint8ArrayView(s.bytes)) fail('screenshot.bytes must be a Uint8Array.');
  const rawBytes = new Uint8Array(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength);
  if (rawBytes.byteLength < 1 || rawBytes.byteLength > MAX_SCREENSHOT_BYTES) {
    fail('screenshot.bytes length is out of bounds (1..524288).');
  }
  if (rawBytes.byteLength < MIN_PNG_HEADER_BYTES) {
    fail('screenshot.bytes is too short to contain a valid PNG IHDR header.');
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (rawBytes[i] !== PNG_SIGNATURE[i]) {
      fail('screenshot.bytes does not start with a valid PNG signature.');
    }
  }
  const ihdrLength = readUint32BE(rawBytes, 8);
  if (ihdrLength !== 13) {
    fail('screenshot.bytes has an invalid PNG IHDR chunk length.');
  }
  for (let i = 0; i < IHDR_TYPE.length; i++) {
    if (rawBytes[12 + i] !== IHDR_TYPE[i]) {
      fail('screenshot.bytes is missing a PNG IHDR chunk.');
    }
  }
  const width = num(s.width, 'screenshot.width', { min: 1, max: 16384, integer: true });
  const height = num(s.height, 'screenshot.height', { min: 1, max: 16384, integer: true });
  const ihdrWidth = readUint32BE(rawBytes, 16);
  const ihdrHeight = readUint32BE(rawBytes, 20);
  if (ihdrWidth !== width || ihdrHeight !== height) {
    fail('screenshot PNG IHDR dimensions do not match screenshot.width and screenshot.height.');
  }
  const cssRect = parsePositiveRect(s.cssRect, 'screenshot.cssRect');
  const devicePixelRatio = num(s.devicePixelRatio, 'screenshot.devicePixelRatio', {
    exclusiveMin: 0,
    max: 16,
  });
  const downscaled = bool(s.downscaled, 'screenshot.downscaled');

  return {
    mimeType: 'image/png',
    bytes: rawBytes.slice(),
    width,
    height,
    cssRect,
    devicePixelRatio,
    downscaled,
  };
}

function parseRequest(input: unknown): WebViewerFeedbackRequest {
  const r = record(input, 'request');
  assertSafeStructure(r);
  if (r.contractVersion !== 1) fail('Unsupported contractVersion.');

  const page = parsePageTarget(r.page);

  const threadId = str(r.threadId, 'threadId', MAX_THREAD_ID_LENGTH, 1);
  if (threadId.trim().length === 0 || /\s/.test(threadId) || /[\u0000-\u001f\u007f]/.test(threadId)) {
    fail('threadId must be a 1..256 non-whitespace string.');
  }

  const rawComment = str(r.comment, 'comment', MAX_RAW_COMMENT_LENGTH);
  const comment = rawComment.trim();
  if (comment.length < 1 || comment.length > MAX_COMMENT_LENGTH) {
    fail('comment must be between 1 and 4000 characters after trimming.');
  }

  const selection = parseSelection(r.selection);

  let screenshot: WebViewerElementScreenshot | null = null;
  let screenshotOmitted: WebViewerScreenshotOmittedReason | null = null;
  if (r.screenshot === null) {
    if (!SCREENSHOT_OMITTED_REASONS.includes(r.screenshotOmitted as WebViewerScreenshotOmittedReason)) {
      fail('screenshotOmitted must specify a valid reason when screenshot is null.');
    }
    screenshotOmitted = r.screenshotOmitted as WebViewerScreenshotOmittedReason;
  } else {
    if (r.screenshotOmitted !== null) {
      fail('screenshotOmitted must be null when screenshot is provided.');
    }
    screenshot = parseScreenshot(r.screenshot);
  }

  const stale = bool(r.stale, 'stale');
  const submittedAt = parseIsoTimestamp(r.submittedAt, 'submittedAt');

  return {
    contractVersion: 1,
    page,
    threadId,
    comment,
    selection,
    screenshot,
    screenshotOmitted,
    stale,
    submittedAt,
  };
}

export function validateWebViewerPageTarget(input: unknown): ValidationResult<WebViewerPageTarget> {
  try {
    assertSafeStructure(input);
    return { ok: true, value: parsePageTarget(input) };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, message: error.message };
    return { ok: false, message: 'Invalid Web Viewer page target.' };
  }
}

export function validateWebViewerFeedbackRequest(
  input: unknown,
): ValidationResult<WebViewerFeedbackRequest> {
  try {
    return { ok: true, value: parseRequest(input) };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, message: error.message };
    return { ok: false, message: 'Invalid Web Viewer feedback request.' };
  }
}
