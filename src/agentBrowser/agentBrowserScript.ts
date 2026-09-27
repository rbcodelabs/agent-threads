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
  | { ok: true; url: string; title: string }
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
    var MAX_CHARS = ${MAX_TEXT_CHARS};
    var root = document.body;
    if (!root) {
      return { url: location.href, title: document.title || '', origin: location.origin, truncated: false, text: '' };
    }
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
      if (total + text.length > MAX_CHARS) { truncated = true; break; }
      parts.push(text);
      total += text.length + 1;
    }
    return {
      url: location.href,
      title: document.title || '',
      origin: location.origin,
      truncated: truncated,
      text: parts.join('\\n')
    };
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

    if (KIND === 'click') {
      el.click();
      return { ok: true, url: location.href, title: document.title || '' };
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

    return { ok: true, url: location.href, title: document.title || '' };
  })()`;
}
