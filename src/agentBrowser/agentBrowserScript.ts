/**
 * The JavaScript injected into an agent browser guest.
 *
 * Everything here is emitted as a source string and handed to
 * `executeJavaScript`, so it runs in the page's own JS world. That is worth
 * stating plainly: there is no isolated-world variant on the `<webview>` tag
 * (`executeJavaScriptInIsolatedWorld` is main-process only), so a page can in
 * principle shadow `document.querySelectorAll`, redefine `Array.prototype`, or
 * otherwise lie to the walker below. The measures here — a per-guest random ref
 * table name, `instanceof Element` validation, epoch and origin checks — raise
 * the cost of opportunistic injection. They are not a security boundary, and
 * they should not be described as one.
 *
 * Every limit is applied *inside* the guest so oversized values never cross the
 * bridge into the host renderer.
 *
 * Role and name resolution are deliberately heuristic. The v2 upgrade is to
 * compute accessible names per the W3C accname spec using `dom-accessibility-api`
 * (MIT, zero deps) plus `aria-query` (Apache-2.0, zero deps), both of which are
 * browser-safe. That change is confined to this file, because the source string
 * is the only contract the rest of the system depends on.
 */

import {
  MAX_ELEMENT_NAME_CHARS,
  MAX_SNAPSHOT_CHARS,
  MAX_SNAPSHOT_REFS,
  MAX_TEXT_CHARS,
} from './agentBrowserPolicy';

/** Result of the snapshot script, as returned across the bridge. */
export interface RawSnapshot {
  url: string;
  title: string;
  origin: string;
  epoch: number;
  count: number;
  truncated: boolean;
  snapshot: string;
}

/** Result of the read-text script. */
export interface RawPageText {
  url: string;
  title: string;
  origin: string;
  truncated: boolean;
  text: string;
}

/** Result of an act script. Failures are values, not thrown errors. */
export type RawActResult =
  | { ok: true; url: string; title: string; pointer?: { x: number; y: number } }
  | { ok: false; code: 'stale_snapshot' | 'ref_not_found' | 'not_actionable'; reason: string; origin?: string };

export type ActKind = 'click' | 'type';

export interface ActRequest {
  kind: ActKind;
  ref: string;
  epoch: number;
  text?: string;
  submit?: boolean;
}

/**
 * Per-guest name for the ref table.
 *
 * Randomised so a hostile page cannot pre-seed a known global with elements of
 * its choosing and have the agent act on them believing they came from its own
 * snapshot.
 */
export function makeRefTableKey(random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 0xffffffff).toString(36);
  return `__ctAgentBrowser_${suffix}`;
}

/** Shared helpers, inlined into each script so they carry no cross-call state. */
function helpers(): string {
  return `
    var NAME_CAP = ${MAX_ELEMENT_NAME_CHARS};
    function ctVisible(el) {
      if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true') return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      var style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (!style) return true;
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity || '1') === 0) return false;
      if (parseFloat(style.fontSize || '16') === 0) return false;
      return true;
    }
    function ctRole(el) {
      var explicit = el.getAttribute('role');
      if (explicit) return explicit;
      var tag = el.tagName.toLowerCase();
      if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'summary') return 'button';
      if (tag === 'input') {
        var type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      return 'generic';
    }
    function ctLabelText(el) {
      var id = el.getAttribute('id');
      if (!id) return '';
      try {
        var label = el.ownerDocument.querySelector('label[for="' + CSS.escape(id) + '"]');
        return label ? (label.textContent || '') : '';
      } catch (e) { return ''; }
    }
    /**
     * A link or button whose entire content is an image has no text of its own.
     * Observed live: IANA's logo link came back as \`link ""\`, which tells the
     * agent nothing and makes the ref unusable for reasoning.
     */
    function ctImageName(el) {
      var img = el.querySelector('img[alt], img[aria-label], svg[aria-label], [role="img"][aria-label]');
      if (!img) return '';
      return img.getAttribute('alt') || img.getAttribute('aria-label') || '';
    }
    function ctName(el) {
      var labelledBy = el.getAttribute('aria-labelledby');
      var fromLabelledBy = '';
      if (labelledBy) {
        var ids = labelledBy.split(/\\s+/);
        for (var i = 0; i < ids.length; i++) {
          var target = el.ownerDocument.getElementById(ids[i]);
          if (target) fromLabelledBy += ' ' + (target.textContent || '');
        }
      }
      var raw = el.getAttribute('aria-label')
        || fromLabelledBy.trim()
        || ctLabelText(el)
        || el.getAttribute('placeholder')
        || el.getAttribute('alt')
        // innerText is layout-dependent and is undefined in some engines, so
        // fall back to textContent. Hidden elements are already filtered out
        // before naming, so this cannot surface invisible text on its own.
        || (el.innerText || el.textContent || '')
        || ctImageName(el)
        || el.getAttribute('title')
        || el.getAttribute('name')
        || '';
      return String(raw).replace(/\\s+/g, ' ').trim().slice(0, NAME_CAP);
    }
    function ctState(el) {
      var bits = [];
      if (el.disabled === true) bits.push('disabled');
      if (el.checked === true) bits.push('checked');
      var expanded = el.getAttribute('aria-expanded');
      if (expanded) bits.push('expanded=' + expanded);
      if (typeof el.value === 'string' && el.value && el.type !== 'password') {
        bits.push('value=' + JSON.stringify(String(el.value).slice(0, 40)));
      }
      return bits.length ? ' [' + bits.join(' ') + ']' : '';
    }
  `;
}

const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, summary, [role], ' +
  '[contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * Build the snapshot script.
 *
 * Establishes a fresh epoch on every call. Acting requires presenting that
 * epoch, so a navigation between snapshot and action is detected rather than
 * silently acted through — the "snapshot site A, page redirects, act on site B"
 * case.
 */
export function buildSnapshotScript(refTableKey: string): string {
  return `(function () {
    ${helpers()}
    var KEY = ${JSON.stringify(refTableKey)};
    var MAX_REFS = ${MAX_SNAPSHOT_REFS};
    var MAX_CHARS = ${MAX_SNAPSHOT_CHARS};

    var prior = window[KEY];
    var epoch = (prior && typeof prior.epoch === 'number' ? prior.epoch : 0) + 1;
    var refs = Object.create(null);

    var nodes = document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)});
    var lines = [];
    var chars = 0;
    var truncated = false;
    var n = 0;

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!ctVisible(el)) continue;
      if (n >= MAX_REFS) { truncated = true; break; }
      var ref = 'e' + (n + 1);
      var line = '- ' + ctRole(el) + ' "' + ctName(el) + '" [ref=' + ref + ']' + ctState(el);
      if (chars + line.length > MAX_CHARS) { truncated = true; break; }
      refs[ref] = el;
      lines.push(line);
      chars += line.length + 1;
      n++;
    }

    window[KEY] = { epoch: epoch, origin: location.origin, refs: refs };

    if (truncated) lines.push('- ... (truncated: more interactive elements exist than can be listed)');

    return {
      url: location.href,
      title: document.title || '',
      origin: location.origin,
      epoch: epoch,
      count: n,
      truncated: truncated,
      snapshot: lines.join('\\n')
    };
  })()`;
}

/**
 * Visible-text walker shared by the read-text and save-page scripts.
 *
 * Defines `ctCollectText(maxChars)`, which returns `{ text, truncated }` with
 * `text.length <= maxChars`. A single text node larger than the space left is
 * included as a partial slice rather than skipped: a raw JSON document is one
 * enormous text node inside a <pre>, and skipping it made such pages come back
 * empty even though they rendered fine.
 */
function textWalker(): string {
  return `
    function ctCollectText(maxChars) {
      var root = document.body;
      if (!root) return { text: '', truncated: false };
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          var parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          var tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
            return NodeFilter.FILTER_REJECT;
          }
          if (!ctVisible(parent)) return NodeFilter.FILTER_REJECT;
          return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var parts = [];
      var total = 0;
      var truncated = false;
      var node;
      while ((node = walker.nextNode())) {
        var text = node.nodeValue.replace(/\\s+/g, ' ').trim();
        if (!text) continue;
        if (total + text.length > maxChars) {
          var remaining = maxChars - total;
          if (remaining > 0) parts.push(text.slice(0, remaining));
          truncated = true;
          break;
        }
        parts.push(text);
        total += text.length + 1;
      }
      return { text: parts.join('\\n'), truncated: truncated };
    }
  `;
}

/**
 * Build the page-text script.
 *
 * Kept separate from the snapshot so an ordinary act loop never carries page
 * prose. Most turns only need roles and refs, and prose is both the bulkiest
 * part of a page and the part most likely to contain injected instructions.
 *
 * Reads rendered text only — never `innerHTML`, script/style contents, comments,
 * or anything the visibility filter rejects. Invisible text is where injection
 * hides.
 */
export function buildReadTextScript(): string {
  return `(function () {
    ${helpers()}
    ${textWalker()}
    var collected = ctCollectText(${MAX_TEXT_CHARS});
    return {
      url: location.href,
      title: document.title || '',
      origin: location.origin,
      truncated: collected.truncated,
      text: collected.text
    };
  })()`;
}

/** Metadata returned by the stash script. The content itself stays in the guest. */
export interface RawStashMeta {
  url: string;
  title: string;
  origin: string;
  contentType: string;
  length: number;
  truncated: boolean;
}

export type SaveFormat = 'text' | 'html';

/**
 * Per-save name for the guest-side stash.
 *
 * Randomised for the same reason as the ref table: a hostile page must not be
 * able to pre-seed a known global and have its own string saved as the page.
 */
export function makeStashKey(random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 0xffffffff).toString(36);
  return `__ctAgentBrowserSave_${suffix}`;
}

/**
 * Build the stash script.
 *
 * Builds the page content inside the guest, keeps it under `window[key]`, and
 * returns only metadata. The content then crosses the bridge in bounded chunks
 * (see buildChunkScript) so no single structured clone is large enough to
 * threaten the host renderer.
 *
 * `text` is the rendered visible text; for JSON and plain-text documents it is
 * the raw document text instead, so a saved JSON page is still valid JSON.
 * `html` is the serialised document element.
 */
export function buildStashScript(key: string, format: SaveFormat, maxChars: number): string {
  return `(function () {
    ${helpers()}
    ${textWalker()}
    var KEY = ${JSON.stringify(key)};
    var FORMAT = ${JSON.stringify(format)};
    var MAX = ${JSON.stringify(maxChars)};
    var contentType = document.contentType || '';
    var content = '';
    var truncated = false;
    if (FORMAT === 'html') {
      content = document.documentElement ? document.documentElement.outerHTML : '';
      if (content.length > MAX) { content = content.slice(0, MAX); truncated = true; }
    } else if (/json|text\\/plain/i.test(contentType) && document.body) {
      var pre = document.querySelector('body > pre');
      content = (pre || document.body).textContent || '';
      if (content.length > MAX) { content = content.slice(0, MAX); truncated = true; }
    } else {
      var collected = ctCollectText(MAX);
      content = collected.text;
      truncated = collected.truncated;
    }
    window[KEY] = content;
    return {
      url: location.href,
      title: document.title || '',
      origin: location.origin,
      contentType: contentType,
      length: content.length,
      truncated: truncated
    };
  })()`;
}

/**
 * Build a chunk-read script: returns one slice of the stash, or null if the
 * stash is gone (the page navigated or reloaded).
 *
 * The slice never ends on a lone high surrogate, so a chunk boundary cannot
 * split an astral character and corrupt it when the host encodes to UTF-8. The
 * host advances by the length actually returned, not the size requested.
 */
export function buildChunkScript(key: string, offset: number, size: number): string {
  return `(function () {
    var content = window[${JSON.stringify(key)}];
    if (typeof content !== 'string') return null;
    var start = ${JSON.stringify(offset)};
    var end = Math.min(start + ${JSON.stringify(size)}, content.length);
    if (end < content.length && end - start > 1) {
      var last = content.charCodeAt(end - 1);
      if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
    }
    return content.slice(start, end);
  })()`;
}

/** Build the script that drops the stash. Idempotent. */
export function buildReleaseScript(key: string): string {
  return `(function () {
    try { delete window[${JSON.stringify(key)}]; } catch (e) { window[${JSON.stringify(key)}] = undefined; }
    return true;
  })()`;
}

/**
 * Build an act script.
 *
 * The epoch and origin checks and the action itself run in a single
 * `executeJavaScript` call, deliberately. Verifying from the host and then
 * acting in a second call leaves a window in which the page can navigate between
 * the two, so the check would describe one page and the action land on another.
 */
export function buildActScript(refTableKey: string, request: ActRequest): string {
  const { kind, ref, epoch, text = '', submit = false } = request;
  return `(function () {
    var KEY = ${JSON.stringify(refTableKey)};
    var REF = ${JSON.stringify(ref)};
    var EPOCH = ${JSON.stringify(epoch)};
    var KIND = ${JSON.stringify(kind)};
    var TEXT = ${JSON.stringify(text)};
    var SUBMIT = ${JSON.stringify(submit)};

    var table = window[KEY];
    if (!table || typeof table !== 'object') {
      return { ok: false, code: 'stale_snapshot', reason: 'The page has navigated or reloaded since the last snapshot.', origin: location.origin };
    }
    if (table.epoch !== EPOCH) {
      return { ok: false, code: 'stale_snapshot', reason: 'A newer snapshot has replaced the one these refs came from.', origin: location.origin };
    }
    if (table.origin !== location.origin) {
      return { ok: false, code: 'stale_snapshot', reason: 'The page changed origin after the snapshot was taken.', origin: location.origin };
    }

    var el = table.refs[REF];
    if (!el || !(el instanceof Element)) {
      return { ok: false, code: 'ref_not_found', reason: 'No element is registered for ' + REF + '.' };
    }
    if (!el.isConnected) {
      return { ok: false, code: 'ref_not_found', reason: REF + ' is no longer attached to the page.' };
    }
    if (el.disabled === true) {
      return { ok: false, code: 'not_actionable', reason: REF + ' is disabled.' };
    }

    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}

    // Where the agent "pointed", for the visible cursor marker. Read after the
    // scroll and before the action (a click may remove or move the element).
    var pointer;
    try {
      var rect = el.getBoundingClientRect();
      if (rect && isFinite(rect.left) && isFinite(rect.top)) {
        pointer = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      }
    } catch (e) {}

    if (KIND === 'click') {
      el.click();
      return { ok: true, url: location.href, title: document.title || '', pointer: pointer };
    }

    if (el.isContentEditable) {
      el.focus();
      el.textContent = TEXT;
    } else {
      el.focus();
      // Assign through the native setter so frameworks that patch the value
      // property (React and friends) still observe the change.
      var proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) { descriptor.set.call(el, TEXT); }
      else { el.value = TEXT; }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    if (SUBMIT) {
      var opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (el.form && typeof el.form.requestSubmit === 'function') {
        try { el.form.requestSubmit(); } catch (e) {}
      }
    }

    return { ok: true, url: location.href, title: document.title || '', pointer: pointer };
  })()`;
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** Either a direction (page scroll) or a ref+epoch (scroll that element into view). */
export interface ScrollRequest {
  direction?: ScrollDirection;
  /** Pixels. Defaults to 80% of the viewport along the scrolled axis. */
  amount?: number;
  ref?: string;
  epoch?: number;
}

/** Largest single scroll the tool will perform, in CSS pixels. */
export const MAX_SCROLL_AMOUNT = 20000;

/** Result of a scroll script. Failures are values, not thrown errors. */
export type RawScrollResult =
  | {
      ok: true;
      url: string;
      title: string;
      /** False when the target was already at its limit in that direction. */
      moved: boolean;
      scrollX: number;
      scrollY: number;
      maxScrollX: number;
      maxScrollY: number;
    }
  | { ok: false; code: 'stale_snapshot' | 'ref_not_found' | 'not_actionable'; reason: string; origin?: string };

/**
 * Build a scroll script.
 *
 * Scrolling is a built-in primitive rather than something the agent composes
 * through `browser_eval`: it only moves the viewport (no click, no input, no
 * navigation), so it needs no per-call approval. By ref it reuses the act
 * script's epoch and origin checks in a single call, for the same reason.
 * By direction it scrolls the nearest scrollable ancestor of the viewport
 * centre (single-page apps usually scroll an inner container), else the window.
 */
export function buildScrollScript(refTableKey: string, request: ScrollRequest): string {
  const { direction, amount, ref, epoch } = request;
  return `(function () {
    var KEY = ${JSON.stringify(refTableKey)};
    var DIRECTION = ${JSON.stringify(direction ?? null)};
    var AMOUNT = ${JSON.stringify(amount ?? null)};
    var REF = ${JSON.stringify(ref ?? null)};
    var EPOCH = ${JSON.stringify(epoch ?? null)};

    function report(moved, target) {
      var isWindow = !target || target === window;
      var se = document.scrollingElement || document.documentElement;
      var x = isWindow ? (window.scrollX || 0) : target.scrollLeft;
      var y = isWindow ? (window.scrollY || 0) : target.scrollTop;
      var maxX = isWindow ? Math.max(0, se.scrollWidth - window.innerWidth) : Math.max(0, target.scrollWidth - target.clientWidth);
      var maxY = isWindow ? Math.max(0, se.scrollHeight - window.innerHeight) : Math.max(0, target.scrollHeight - target.clientHeight);
      return { ok: true, url: location.href, title: document.title || '', moved: moved,
        scrollX: Math.round(x), scrollY: Math.round(y), maxScrollX: Math.round(maxX), maxScrollY: Math.round(maxY) };
    }

    if (REF !== null) {
      var table = window[KEY];
      if (!table || typeof table !== 'object') {
        return { ok: false, code: 'stale_snapshot', reason: 'The page has navigated or reloaded since the last snapshot.', origin: location.origin };
      }
      if (table.epoch !== EPOCH) {
        return { ok: false, code: 'stale_snapshot', reason: 'A newer snapshot has replaced the one these refs came from.', origin: location.origin };
      }
      if (table.origin !== location.origin) {
        return { ok: false, code: 'stale_snapshot', reason: 'The page changed origin after the snapshot was taken.', origin: location.origin };
      }
      var el = table.refs[REF];
      if (!el || !(el instanceof Element)) {
        return { ok: false, code: 'ref_not_found', reason: 'No element is registered for ' + REF + '.' };
      }
      if (!el.isConnected) {
        return { ok: false, code: 'ref_not_found', reason: REF + ' is no longer attached to the page.' };
      }
      var beforeX = window.scrollX || 0, beforeY = window.scrollY || 0;
      var before = el.getBoundingClientRect();
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      var after = el.getBoundingClientRect();
      var movedRef = Math.abs(after.top - before.top) > 0.5 || Math.abs(after.left - before.left) > 0.5
        || (window.scrollX || 0) !== beforeX || (window.scrollY || 0) !== beforeY;
      return report(movedRef, window);
    }

    var horizontal = DIRECTION === 'left' || DIRECTION === 'right';
    var sign = (DIRECTION === 'up' || DIRECTION === 'left') ? -1 : 1;

    function scrollable(node) {
      if (!(node instanceof Element)) return false;
      var style = node.ownerDocument.defaultView.getComputedStyle(node);
      if (!style) return false;
      var overflow = horizontal ? style.overflowX : style.overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') return false;
      return horizontal ? node.scrollWidth > node.clientWidth : node.scrollHeight > node.clientHeight;
    }

    var target = window;
    var node = null;
    try { node = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2); } catch (e) {}
    while (node && node !== document.body && node !== document.documentElement) {
      if (scrollable(node)) { target = node; break; }
      node = node.parentElement;
    }

    var span = target === window ? (horizontal ? window.innerWidth : window.innerHeight) : (horizontal ? target.clientWidth : target.clientHeight);
    var distance = (AMOUNT !== null ? AMOUNT : Math.round(span * 0.8)) * sign;
    var startX = target === window ? (window.scrollX || 0) : target.scrollLeft;
    var startY = target === window ? (window.scrollY || 0) : target.scrollTop;
    var dx = horizontal ? distance : 0;
    var dy = horizontal ? 0 : distance;
    // Instant, not smooth: the position is read straight back below.
    if (target === window) window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    else target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    var endX = target === window ? (window.scrollX || 0) : target.scrollLeft;
    var endY = target === window ? (window.scrollY || 0) : target.scrollTop;
    return report(endX !== startX || endY !== startY, target);
  })()`;
}
