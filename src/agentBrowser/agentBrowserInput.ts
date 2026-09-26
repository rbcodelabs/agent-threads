/**
 * Coordinate and key mapping for the login-handoff "take control" input path
 * (ADR-0014).
 *
 * Pure by design, matching `agentBrowserPolicy.ts`/`agentBrowserScript.ts`: no
 * DOM, no Electron imports, plain numbers/strings in and out, so the mapping
 * logic — the thing most likely to have an off-by-one or a missed key — is
 * directly unit-testable without a browser or a live guest.
 *
 * Scope is deliberately narrow. The surface this feeds is a login/MFA form
 * during a short, human-driven handoff, not general page interaction: no
 * hover, drag, wheel, or right-click, and the keyboard map covers printable
 * characters plus a small set of control keys. Anything outside that returns
 * `null` so the caller can simply skip forwarding it, rather than guessing.
 */

/** A rectangle in the same coordinate space as a `PointerEvent`'s `clientX/clientY`. */
export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A guest's actual viewport size, from `AgentBrowserGuest.facts().viewport`. */
export interface ViewportSize {
  width: number;
  height: number;
}

export interface GuestPoint {
  x: number;
  y: number;
}

/**
 * Electron's `sendInputEvent`-shaped mouse event.
 *
 * Declared locally rather than imported from `electron` — this repo has no
 * dependency on Electron's types (see `AgentBrowserGuest.ts`'s `WebviewLike`),
 * and this module in particular must stay import-free to remain unit-testable
 * without a DOM.
 */
export interface MouseInputEvent {
  type: 'mouseDown' | 'mouseUp';
  x: number;
  y: number;
  button: 'left';
  clickCount: number;
}

export type KeyboardModifier = 'shift' | 'control' | 'alt' | 'meta';

export interface KeyboardInputEvent {
  type: 'keyDown' | 'keyUp';
  keyCode: string;
  modifiers: KeyboardModifier[];
}

export type GuestInputEvent = MouseInputEvent | KeyboardInputEvent;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Map a pointer event's client coordinates into guest-viewport space.
 *
 * Simple ratio scaling from the `<img>`'s rendered box to the guest's actual
 * viewport, clamped so a click right at the edge of the frame (or a stale
 * rect from a resize race) can never send a coordinate outside the guest's
 * viewport.
 */
export function mapClientPointToViewport(
  clientX: number,
  clientY: number,
  imgRect: ClientRect,
  viewport: ViewportSize,
): GuestPoint {
  if (imgRect.width <= 0 || imgRect.height <= 0) {
    return { x: 0, y: 0 };
  }
  const ratioX = (clientX - imgRect.left) / imgRect.width;
  const ratioY = (clientY - imgRect.top) / imgRect.height;
  const x = clamp(Math.round(ratioX * viewport.width), 0, viewport.width);
  const y = clamp(Math.round(ratioY * viewport.height), 0, viewport.height);
  return { x, y };
}

/** Build a synthetic left-click mouse event at a guest-viewport-space point. */
export function buildMouseInputEvent(type: 'mouseDown' | 'mouseUp', point: GuestPoint): MouseInputEvent {
  return { type, x: point.x, y: point.y, button: 'left', clickCount: 1 };
}

/**
 * DOM `KeyboardEvent`'s minimal shape this module needs.
 *
 * Plain fields rather than a live `KeyboardEvent`, so tests can construct one
 * without jsdom.
 */
export interface DomKeyboardEventLike {
  key: string;
  type: 'keydown' | 'keyup';
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Non-printable keys the handoff supports, mapped to the key names Electron's
 * `sendInputEvent` expects (the same vocabulary as its `Accelerator` strings).
 *
 * Deliberately small: this exists for filling in a login/MFA form, not general
 * page navigation. IME/composition input, function keys, and most
 * non-US-layout symbol keys are out of scope — see ADR-0014's Limitations.
 */
const SPECIAL_KEY_MAP: Readonly<Record<string, string>> = {
  Enter: 'Return',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
};

/**
 * Map a DOM keyboard event to an Electron `KeyboardInputEvent`-shaped object.
 *
 * Returns `null` for anything unmapped (composition/IME keys like `Dead` or
 * `Process`, function keys, modifier-only presses such as a bare `Shift`,
 * multi-character keys not in `SPECIAL_KEY_MAP`) so the caller can simply drop
 * it rather than forward something Electron cannot interpret.
 */
export function mapKeyboardEvent(event: DomKeyboardEventLike): KeyboardInputEvent | null {
  const keyCode = event.key.length === 1 ? event.key : SPECIAL_KEY_MAP[event.key];
  if (!keyCode) return null;

  const modifiers: KeyboardModifier[] = [];
  if (event.shiftKey) modifiers.push('shift');
  if (event.ctrlKey) modifiers.push('control');
  if (event.altKey) modifiers.push('alt');
  if (event.metaKey) modifiers.push('meta');

  return {
    type: event.type === 'keydown' ? 'keyDown' : 'keyUp',
    keyCode,
    modifiers,
  };
}
