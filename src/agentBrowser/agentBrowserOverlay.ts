/**
 * The agent's visible "hands": a cursor marker, a click ripple and a focus ring
 * drawn INSIDE the guest page, so they are present in every frame captured from
 * it (the Agent Browser pane, the chat card and step screenshots all show
 * `capturePage()` output, where the guest's native caret and focus are not).
 *
 * Pure script builders, like `agentBrowserScript.ts`: strings in, strings out, so
 * the overlay is unit-testable in jsdom without a live guest.
 *
 * Design constraints (each one pinned by test/unit/agent-browser-overlay.test.ts):
 *  - never alters layout: the host is `position: fixed` with zero size;
 *  - never intercepts input: `pointer-events: none` on the host and every child;
 *  - invisible to the agent's own tools: it hangs off <html> (outside <body>),
 *    holds no interactive element, and its content sits in a closed shadow root,
 *    so `querySelectorAll`-based snapshots and `innerText` reads never see it;
 *  - not reachable by page scripts through a known name: its state lives on
 *    <html> under a per-guest random key (same idea as the snapshot ref table);
 *  - idempotent: running the install script again reuses the live host, and a
 *    navigation (new document, no host) simply rebuilds it;
 *  - removable: `buildOverlayRemoveScript` takes down the host and listeners.
 */

/** z-index ceiling; the overlay must sit above whatever the page does. */
const MAX_Z_INDEX = 2147483647;

/** How long a click ripple stays visible, measured from the click. */
export const RIPPLE_VISIBLE_MS = 1500;

export interface OverlayPointer {
  x: number;
  y: number;
  /** Epoch ms of the click that should ripple, or null for a plain move/type. */
  clickAt: number | null;
}

export interface OverlayUpdate {
  pointer: OverlayPointer | null;
  /** Current epoch ms, so the page can age the ripple without its own clock skew. */
  now: number;
}

const CSS = `
:host { all: initial; }
.ring, .caret, .sel, .cursor, .ripple { position: fixed; pointer-events: none; box-sizing: border-box; margin: 0; padding: 0; }
.ring { border-radius: 4px; border: 2px solid #1d4ed8; box-shadow: 0 0 0 2px #ffffff, 0 0 0 5px rgba(29,78,216,.35); background: rgba(59,130,246,.08); }
.caret { width: 2px; background: #1d4ed8; box-shadow: 0 0 0 1px #ffffff; }
.sel { background: rgba(59,130,246,.35); }
.cursor { width: 22px; height: 22px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.55)); }
.ripple { width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 3px solid #ea580c; background: rgba(234,88,12,.25); animation: ct-ripple 700ms ease-out both; }
@keyframes ct-ripple { from { transform: scale(.4); opacity: 1; } to { transform: scale(4); opacity: 0; } }
@media (prefers-color-scheme: dark) {
  .ring { border-color: #93c5fd; box-shadow: 0 0 0 2px #0b1220, 0 0 0 5px rgba(147,197,253,.45); background: rgba(147,197,253,.10); }
  .caret { background: #93c5fd; box-shadow: 0 0 0 1px #0b1220; }
  .sel { background: rgba(147,197,253,.40); }
}
`;

const CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="22" height="22">' +
  '<path d="M3 2 L3 17 L7.2 13.2 L10 19.5 L12.6 18.4 L9.9 12.2 L15.5 12 Z" fill="#111827" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>' +
  '<circle cx="3" cy="2" r="0" fill="#ea580c"/></svg>';

/**
 * Install (or refresh) the overlay and draw the current pointer and focus state.
 * Returns true when drawn, false when the page has no document element yet.
 */
export function buildOverlayScript(key: string, update: OverlayUpdate): string {
  return `(function () {
    var KEY = ${JSON.stringify(key)};
    var UPDATE = ${JSON.stringify(update)};
    var root = document.documentElement;
    if (!root) return false;

    var st = root[KEY];
    if (!st || !st.host || !st.host.isConnected) {
      if (st && st.dispose) { try { st.dispose(); } catch (e) {} }
      var host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:${MAX_Z_INDEX};contain:layout style;';
      var shadow = host.attachShadow({ mode: 'closed' });
      var style = document.createElement('style');
      style.textContent = ${JSON.stringify(CSS)};
      shadow.appendChild(style);
      var layer = document.createElement('div');
      shadow.appendChild(layer);
      st = { host: host, shadow: shadow, layer: layer, pointer: null, now: 0 };
      var rerender = function () { try { draw(st); } catch (e) {} };
      var listeners = [
        [document, 'focusin', rerender],
        [document, 'focusout', rerender],
        [document, 'selectionchange', rerender],
        [window, 'scroll', rerender],
        [window, 'resize', rerender]
      ];
      for (var i = 0; i < listeners.length; i++) listeners[i][0].addEventListener(listeners[i][1], listeners[i][2], true);
      st.dispose = function () {
        for (var j = 0; j < listeners.length; j++) listeners[j][0].removeEventListener(listeners[j][1], listeners[j][2], true);
        if (host.parentNode) host.parentNode.removeChild(host);
        delete root[KEY];
      };
      Object.defineProperty(root, KEY, { value: st, configurable: true, enumerable: false, writable: true });
      root.appendChild(host);
    }

    st.pointer = UPDATE.pointer;
    st.now = UPDATE.now;
    draw(st);
    return true;

    function box(cls, rect) {
      var d = document.createElement('div');
      d.className = cls;
      d.style.left = rect.left + 'px';
      d.style.top = rect.top + 'px';
      d.style.width = rect.width + 'px';
      d.style.height = rect.height + 'px';
      return d;
    }

    function isTextual(el) {
      if (!el || el === document.body || el === document.documentElement) return false;
      var tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (tag === 'INPUT') {
        var t = (el.type || 'text').toLowerCase();
        return t !== 'hidden';
      }
      return el.isContentEditable === true;
    }

    function draw(s) {
      var layer = s.layer;
      while (layer.firstChild) layer.removeChild(layer.firstChild);

      var active = document.activeElement;
      if (isTextual(active)) {
        var r = active.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) layer.appendChild(box('ring', r));
        if (active.isContentEditable) {
          var sel = window.getSelection && window.getSelection();
          if (sel && sel.rangeCount > 0) {
            var range = sel.getRangeAt(0);
            var rects = range.getClientRects();
            if (sel.isCollapsed) {
              var cr = rects.length ? rects[0] : null;
              if (cr) layer.appendChild(box('caret', { left: cr.left, top: cr.top, width: 2, height: cr.height || 16 }));
            } else {
              for (var k = 0; k < rects.length && k < 50; k++) layer.appendChild(box('sel', rects[k]));
            }
          }
        }
      }

      var p = s.pointer;
      if (p) {
        var cursor = document.createElement('div');
        cursor.className = 'cursor';
        cursor.style.left = p.x + 'px';
        cursor.style.top = p.y + 'px';
        cursor.innerHTML = ${JSON.stringify(CURSOR_SVG)};
        layer.appendChild(cursor);
        if (p.clickAt !== null && p.clickAt !== undefined) {
          var age = s.now - p.clickAt;
          if (age >= 0 && age < ${RIPPLE_VISIBLE_MS}) {
            var rip = document.createElement('div');
            rip.className = 'ripple';
            rip.style.left = p.x + 'px';
            rip.style.top = p.y + 'px';
            // Negative delay: a frame captured mid-flight shows the ripple where it
            // really is in its animation instead of restarting it.
            rip.style.animationDelay = (-Math.min(age, 650)) + 'ms';
            layer.appendChild(rip);
          }
        }
      }
    }
  })()`;
}

/** Take the overlay down and detach its listeners. Safe when it was never installed. */
export function buildOverlayRemoveScript(key: string): string {
  return `(function () {
    var st = document.documentElement && document.documentElement[${JSON.stringify(key)}];
    if (st && st.dispose) { try { st.dispose(); } catch (e) {} return true; }
    return false;
  })()`;
}
