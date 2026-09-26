/**
 * `agentBrowserInput.ts` is the small, pure module ADR-0014 calls out as the
 * place coordinate/key-mapping bugs would live — "clicks landing in the wrong
 * place, keys not registering" without being a security issue. Kept
 * DOM-free/Electron-free on purpose, so these tests need nothing but plain
 * values.
 */

import { describe, expect, it } from 'vitest';

import {
  buildMouseInputEvent,
  mapClientPointToViewport,
  mapKeyboardEvent,
  type DomKeyboardEventLike,
} from '../../src/agentBrowser/agentBrowserInput';

describe('mapClientPointToViewport', () => {
  it('scales a point at the top-left of the image to the top-left of the viewport', () => {
    const point = mapClientPointToViewport(100, 200, { left: 100, top: 200, width: 640, height: 400 }, { width: 1280, height: 800 });
    expect(point).toEqual({ x: 0, y: 0 });
  });

  it('scales a point at the center of the image to the center of the viewport', () => {
    const point = mapClientPointToViewport(420, 400, { left: 100, top: 200, width: 640, height: 400 }, { width: 1280, height: 800 });
    expect(point).toEqual({ x: 640, y: 400 });
  });

  it('scales a point at the bottom-right of the image to the bottom-right of the viewport', () => {
    const point = mapClientPointToViewport(740, 600, { left: 100, top: 200, width: 640, height: 400 }, { width: 1280, height: 800 });
    expect(point).toEqual({ x: 1280, y: 800 });
  });

  it('clamps a point outside the image bounds instead of extrapolating', () => {
    const point = mapClientPointToViewport(-500, -500, { left: 100, top: 200, width: 640, height: 400 }, { width: 1280, height: 800 });
    expect(point).toEqual({ x: 0, y: 0 });

    const overshoot = mapClientPointToViewport(5000, 5000, { left: 100, top: 200, width: 640, height: 400 }, { width: 1280, height: 800 });
    expect(overshoot).toEqual({ x: 1280, y: 800 });
  });

  it('never divides by zero for a degenerate (not-yet-laid-out) image rect', () => {
    const point = mapClientPointToViewport(50, 50, { left: 0, top: 0, width: 0, height: 0 }, { width: 1280, height: 800 });
    expect(point).toEqual({ x: 0, y: 0 });
  });
});

describe('buildMouseInputEvent', () => {
  it('builds a mouseDown event shape', () => {
    expect(buildMouseInputEvent('mouseDown', { x: 10, y: 20 })).toEqual({
      type: 'mouseDown',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1,
    });
  });

  it('builds a mouseUp event shape', () => {
    expect(buildMouseInputEvent('mouseUp', { x: 10, y: 20 })).toEqual({
      type: 'mouseUp',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1,
    });
  });
});

function key(overrides: Partial<DomKeyboardEventLike> & Pick<DomKeyboardEventLike, 'key'>): DomKeyboardEventLike {
  return {
    type: 'keydown',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe('mapKeyboardEvent', () => {
  it('maps a printable character as-is', () => {
    expect(mapKeyboardEvent(key({ key: 'a' }))).toEqual({ type: 'keyDown', keyCode: 'a', modifiers: [] });
    expect(mapKeyboardEvent(key({ key: 'A', shiftKey: true }))).toEqual({
      type: 'keyDown',
      keyCode: 'A',
      modifiers: ['shift'],
    });
    expect(mapKeyboardEvent(key({ key: '1' }))).toEqual({ type: 'keyDown', keyCode: '1', modifiers: [] });
  });

  it('maps keyup the same way as keydown, just with the other type', () => {
    expect(mapKeyboardEvent(key({ key: 'a', type: 'keyup' }))).toEqual({
      type: 'keyUp',
      keyCode: 'a',
      modifiers: [],
    });
  });

  it.each([
    ['Enter', 'Return'],
    ['Backspace', 'Backspace'],
    ['Tab', 'Tab'],
    ['Escape', 'Escape'],
    ['Delete', 'Delete'],
    ['ArrowUp', 'Up'],
    ['ArrowDown', 'Down'],
    ['ArrowLeft', 'Left'],
    ['ArrowRight', 'Right'],
    ['Home', 'Home'],
    ['End', 'End'],
  ])('maps the special key %s to Electron keyCode %s', (domKey, expectedKeyCode) => {
    const mapped = mapKeyboardEvent(key({ key: domKey }));
    expect(mapped).not.toBeNull();
    expect(mapped?.keyCode).toBe(expectedKeyCode);
  });

  it('collects every held modifier', () => {
    expect(
      mapKeyboardEvent(key({ key: 'a', shiftKey: true, ctrlKey: true, altKey: true, metaKey: true })),
    ).toEqual({
      type: 'keyDown',
      keyCode: 'a',
      modifiers: ['shift', 'control', 'alt', 'meta'],
    });
  });

  it('returns null for an unmapped key rather than guessing', () => {
    // Composition/IME markers, function keys, and modifier-only presses are all
    // deliberately out of scope (ADR-0014's Limitations).
    expect(mapKeyboardEvent(key({ key: 'Dead' }))).toBeNull();
    expect(mapKeyboardEvent(key({ key: 'Process' }))).toBeNull();
    expect(mapKeyboardEvent(key({ key: 'F1' }))).toBeNull();
    expect(mapKeyboardEvent(key({ key: 'Shift' }))).toBeNull();
    expect(mapKeyboardEvent(key({ key: 'CapsLock' }))).toBeNull();
  });
});
