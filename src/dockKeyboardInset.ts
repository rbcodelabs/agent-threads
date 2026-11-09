/**
 * dockKeyboardInset.ts
 *
 * The soft keyboard. On iOS the layout viewport does not shrink when the keyboard opens; `visualViewport` does. The part
 * of the view that lies below the visual viewport is covered, and the narrow bottom sheet lifts its composer by that much.
 */

/** Pixels of the view (its bottom edge at `rootBottom`, layout-viewport coordinates) that lie below the visual viewport. */
export function keyboardInset(rootBottom: number, vvOffsetTop: number, vvHeight: number, _scale = 1): number {
  const px = rootBottom - (vvOffsetTop + vvHeight);
  return Number.isFinite(px) && px > 0 ? Math.round(px) : 0;
}

export class KeyboardInsetTracker {
  private current = 0;
  private active = false;
  private readonly onViewport = (): void => this.measure();

  constructor(
    private readonly win: Window,
    private readonly getRootBottom: () => number,
    private readonly onChange: (px: number) => void,
  ) {}

  get inset(): number { return this.current; }

  start(): void {
    if (this.active) return;
    this.active = true;
    const vv = this.win.visualViewport;
    vv?.addEventListener('resize', this.onViewport);
    vv?.addEventListener('scroll', this.onViewport);
    this.measure(true);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const vv = this.win.visualViewport;
    vv?.removeEventListener('resize', this.onViewport);
    vv?.removeEventListener('scroll', this.onViewport);
    if (this.current !== 0) { this.current = 0; this.onChange(0); }
  }

  /** Re-read the geometry (the view moved or resized without the visual viewport changing). */
  measure(force = false): void {
    if (!this.active) return;
    const vv = this.win.visualViewport;
    const px = vv ? keyboardInset(this.getRootBottom(), vv.offsetTop, vv.height) : 0;
    if (px === this.current && !force) return;
    const changed = px !== this.current;
    this.current = px;
    if (changed || force) this.onChange(px);
  }
}
