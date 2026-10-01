// @vitest-environment jsdom
/**
 * The in-page overlay (cursor marker, click ripple, focus ring). The script is
 * executed for real in jsdom; we read its state through the per-guest key the
 * way the guest never needs to, since the shadow root is closed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildOverlayRemoveScript, buildOverlayScript, RIPPLE_VISIBLE_MS } from '../../src/agentBrowser/agentBrowserOverlay';
import { buildSnapshotScript } from '../../src/agentBrowser/agentBrowserScript';

const KEY = '__ct_overlay_test';

function run(code: string): unknown {
  return (0, eval)(code);
}

function draw(pointer: { x: number; y: number; clickAt: number | null } | null, now = 1000): void {
  run(buildOverlayScript(KEY, { pointer, now }));
}

function state(): { host: HTMLElement; shadow: ShadowRoot; layer: HTMLElement } | undefined {
  return (document.documentElement as unknown as Record<string, never>)[KEY];
}

function layerClasses(): string[] {
  return Array.from(state()!.layer.children).map((c) => c.className);
}

afterEach(() => {
  run(buildOverlayRemoveScript(KEY));
  document.body.innerHTML = '';
});

describe('overlay host', () => {
  it('is zero-size, fixed, input-transparent, top of the stack and outside <body>', () => {
    draw(null);
    const host = state()!.host;
    expect(host.parentElement).toBe(document.documentElement);
    expect(document.body.contains(host)).toBe(false);
    expect(host.style.position).toBe('fixed');
    expect(host.style.pointerEvents).toBe('none');
    expect(host.style.zIndex).toBe('2147483647');
    expect(host.style.width).toBe('0px');
    expect(host.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps its content in a closed shadow root', () => {
    draw(null);
    expect(state()!.host.shadowRoot).toBeNull();
  });

  it('is idempotent: a second install reuses the same host', () => {
    draw(null);
    const first = state()!.host;
    draw({ x: 5, y: 5, clickAt: null });
    expect(state()!.host).toBe(first);
    expect(document.documentElement.querySelectorAll(':scope > div').length).toBe(1);
  });

  it('rebuilds after the host is lost (a navigation produces a fresh document)', () => {
    draw(null);
    state()!.host.remove();
    draw(null);
    expect(state()!.host.isConnected).toBe(true);
  });

  it('does not appear in an agent snapshot or in page text', () => {
    document.body.innerHTML = '<button>Go</button>';
    const without = JSON.stringify(run(buildSnapshotScript('__ct_refs_a')));
    draw({ x: 10, y: 10, clickAt: 1000 });
    const withOverlay = JSON.stringify(run(buildSnapshotScript('__ct_refs_b')));
    expect(withOverlay).toBe(without);
    expect(document.body.textContent).toBe('Go');
    expect(document.querySelectorAll('[class*="cursor"], [class*="ripple"], [class*="ring"]')).toHaveLength(0);
  });

  it('can be removed, and removal is safe when never installed', () => {
    draw(null);
    expect(run(buildOverlayRemoveScript(KEY))).toBe(true);
    expect(state()).toBeUndefined();
    expect(document.documentElement.querySelector(':scope > div')).toBeNull();
    expect(run(buildOverlayRemoveScript(KEY))).toBe(false);
  });
});

describe('pointer marker', () => {
  it('draws a cursor at the pointer position', () => {
    draw({ x: 40, y: 60, clickAt: null });
    const cursor = state()!.layer.querySelector('.cursor') as HTMLElement;
    expect(cursor.style.left).toBe('40px');
    expect(cursor.style.top).toBe('60px');
    expect(layerClasses()).not.toContain('ripple');
  });

  it('draws nothing for the pointer when there is none', () => {
    draw(null);
    expect(layerClasses()).toEqual([]);
  });

  it('adds a ripple for a recent click and drops it once it is old', () => {
    draw({ x: 1, y: 2, clickAt: 900 }, 1000);
    expect(layerClasses()).toContain('ripple');
    draw({ x: 1, y: 2, clickAt: 900 }, 900 + RIPPLE_VISIBLE_MS + 1);
    expect(layerClasses()).not.toContain('ripple');
    expect(layerClasses()).toContain('cursor');
  });
});

describe('focus ring', () => {
  function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }): void {
    el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) });
  }

  it('rings the focused text input, at its rect', () => {
    document.body.innerHTML = '<input id="a" type="text">';
    const input = document.getElementById('a') as HTMLInputElement;
    stubRect(input, { left: 10, top: 20, width: 200, height: 30 });
    draw(null);
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const ring = state()!.layer.querySelector('.ring') as HTMLElement;
    expect(ring.style.left).toBe('10px');
    expect(ring.style.width).toBe('200px');
  });

  it('rings a textarea, and clears the ring when focus leaves', () => {
    document.body.innerHTML = '<textarea id="t"></textarea><button id="b">x</button>';
    const ta = document.getElementById('t') as HTMLTextAreaElement;
    stubRect(ta, { left: 0, top: 0, width: 50, height: 50 });
    draw(null);
    ta.focus();
    ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(layerClasses()).toContain('ring');
    (document.getElementById('b') as HTMLButtonElement).focus();
    document.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(layerClasses()).not.toContain('ring');
  });

  it('does not ring a plain button', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    draw(null);
    (document.getElementById('b') as HTMLButtonElement).focus();
    document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(layerClasses()).not.toContain('ring');
  });

  it('stops reacting to focus after removal', () => {
    document.body.innerHTML = '<input id="a" type="text">';
    const input = document.getElementById('a') as HTMLInputElement;
    stubRect(input, { left: 0, top: 0, width: 10, height: 10 });
    draw(null);
    const layer = state()!.layer;
    run(buildOverlayRemoveScript(KEY));
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(layer.querySelector('.ring')).toBeNull();
  });
});
