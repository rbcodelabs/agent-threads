/**
 * dock-keyboard-inset.test.ts
 * @vitest-environment jsdom
 *
 * K2 P5: the soft keyboard. visualViewport (resize/scroll) says how much of the bottom of the view the keyboard
 * covers; the narrow bottom sheet lifts its composer by that amount.
 */
import { describe, it, expect, vi } from 'vitest';
import { keyboardInset, KeyboardInsetTracker } from '../../src/dockKeyboardInset';

describe('keyboardInset(rootBottom, vvOffsetTop, vvHeight)', () => {
  it('is 0 when the visual viewport reaches the bottom of the view', () => {
    expect(keyboardInset(800, 0, 800)).toBe(0);
  });
  it('is the part of the view below the visual viewport (keyboard height)', () => {
    expect(keyboardInset(844, 0, 508)).toBe(336);
  });
  it('accounts for the visual viewport being scrolled (offsetTop)', () => {
    expect(keyboardInset(844, 40, 508)).toBe(296);
  });
  it('never negative (view ends above the visual viewport bottom) and never NaN', () => {
    expect(keyboardInset(600, 0, 800)).toBe(0);
    expect(keyboardInset(Number.NaN, 0, 800)).toBe(0);
  });
  it('is 0 while pinch-zoomed (scale > 1.01): the zoom shrinks the visual viewport, it is not a keyboard', () => {
    expect(keyboardInset(844, 0, 508, 2)).toBe(0);
    expect(keyboardInset(844, 0, 508, 1.02)).toBe(0);
    expect(keyboardInset(844, 0, 508, 1.005)).toBe(336);
    expect(keyboardInset(844, 0, 508, 1)).toBe(336);
  });
  it('never under-lifts: a fractional inset rounds UP (a half pixel short leaves the composer 1px under the keyboard)', () => {
    expect(keyboardInset(800, 0, 499.6)).toBe(301);
  });
  it('ignores sub-pixel noise (rounds)', () => {
    expect(keyboardInset(800.4, 0, 799.9)).toBe(1);
  });
});

function fakeViewport(height: number, offsetTop = 0) {
  const target = new EventTarget();
  const vv = Object.assign(target, { height, offsetTop, width: 390, scale: 1 });
  return vv;
}

describe('KeyboardInsetTracker', () => {
  it('reports the current inset on start, then on visualViewport resize and scroll, and stops listening on stop()', () => {
    const vv = fakeViewport(844);
    const win = { visualViewport: vv } as unknown as Window;
    const seen: number[] = [];
    const t = new KeyboardInsetTracker(win, () => 844, (px) => seen.push(px));
    t.start();
    expect(seen).toEqual([0]);
    vv.height = 508; vv.dispatchEvent(new Event('resize'));
    expect(seen.at(-1)).toBe(336);
    vv.offsetTop = 20; vv.dispatchEvent(new Event('scroll'));
    expect(seen.at(-1)).toBe(316);
    const n = seen.length;
    t.stop();
    vv.height = 400; vv.dispatchEvent(new Event('resize'));
    expect(seen).toHaveLength(n + 1); // stop() reports the reset to 0 once, then nothing
    expect(seen.at(-1)).toBe(0);
  });

  it('a pinch-zoom (scale > 1) reports no inset and un-zooming brings the keyboard back', () => {
    const vv = Object.assign(fakeViewport(500), { scale: 1 });
    const seen: number[] = [];
    const t = new KeyboardInsetTracker({ visualViewport: vv } as unknown as Window, () => 800, (px) => seen.push(px));
    t.start();
    expect(seen.at(-1)).toBe(300);
    vv.scale = 2; vv.dispatchEvent(new Event('resize'));
    expect(seen.at(-1)).toBe(0);
    vv.scale = 1; vv.dispatchEvent(new Event('resize'));
    expect(seen.at(-1)).toBe(300);
  });

  it('measure() re-reads the geometry (the view moved without the visual viewport changing)', () => {
    const vv = fakeViewport(500);
    let bottom = 800;
    const seen: number[] = [];
    const t = new KeyboardInsetTracker({ visualViewport: vv } as unknown as Window, () => bottom, (px) => seen.push(px));
    t.start();
    bottom = 700; t.measure();
    expect(seen.at(-1)).toBe(200);
  });

  it('does not call back for an unchanged inset', () => {
    const vv = fakeViewport(500);
    const seen: number[] = [];
    const t = new KeyboardInsetTracker({ visualViewport: vv } as unknown as Window, () => 800, (px) => seen.push(px));
    t.start();
    vv.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('scroll'));
    expect(seen).toEqual([300]);
  });

  it('is inert (inset 0, no throw) when the window has no visualViewport', () => {
    const cb = vi.fn();
    const t = new KeyboardInsetTracker({} as unknown as Window, () => 800, cb);
    expect(() => { t.start(); t.stop(); }).not.toThrow();
    expect(cb.mock.calls.every(([px]) => px === 0)).toBe(true);
    expect(t.inset).toBe(0);
  });

  it('start() twice does not double-subscribe', () => {
    const vv = fakeViewport(500);
    const add = vi.spyOn(vv, 'addEventListener');
    const t = new KeyboardInsetTracker({ visualViewport: vv } as unknown as Window, () => 800, () => {});
    t.start(); t.start();
    expect(add).toHaveBeenCalledTimes(2); // resize + scroll, once
  });
});
