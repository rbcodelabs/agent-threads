// K2 P5 scaffold: signatures only (behaviour arrives in the implementation commit).
export function keyboardInset(_rootBottom: number, _vvOffsetTop: number, _vvHeight: number): number { return -1; }
export class KeyboardInsetTracker {
  readonly inset = 0;
  constructor(_win: Window, _getRootBottom: () => number, _onChange: (px: number) => void) {}
  start(): void {}
  stop(): void {}
}
