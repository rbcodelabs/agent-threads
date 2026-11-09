/**
 * dockInputHistory.ts
 *
 * Pure recall history for the Ask field: the last HISTORY_LIMIT sent messages, ArrowUp / ArrowDown through them,
 * and the draft that was being typed restored when ArrowDown walks past the newest. No DOM, no `obsidian`.
 */
export const HISTORY_LIMIT = 20;

export class InputHistory {
  private list: string[] = [];
  /** Index of the entry on show, or -1 when not browsing. */
  private index = -1;
  /** What was in the field when browsing started (restored by walking past the newest entry). */
  private typed = '';

  get entries(): readonly string[] { return this.list; }
  get browsing(): boolean { return this.index >= 0; }
  /** The recalled entry on show, undefined when not browsing. */
  get shown(): string | undefined { return this.index >= 0 ? this.list[this.index] : undefined; }

  /** Records a sent message (trimmed; blanks and consecutive duplicates are dropped) and ends browsing. */
  push(text: string): void {
    const t = text.trim();
    this.reset();
    if (!t || this.list[this.list.length - 1] === t) return;
    this.list.push(t);
    if (this.list.length > HISTORY_LIMIT) this.list.splice(0, this.list.length - HISTORY_LIMIT);
  }

  /** ArrowUp: the next older entry (the newest when not yet browsing). `current` is saved when browsing starts. */
  previous(current: string): string | undefined {
    if (this.list.length === 0) return undefined;
    if (this.index < 0) { this.typed = current; this.index = this.list.length - 1; } else if (this.index > 0) this.index--;
    return this.list[this.index];
  }

  /** ArrowDown: the next newer entry; past the newest, the draft that was being typed. Undefined when not browsing. */
  next(): string | undefined {
    if (this.index < 0) return undefined;
    if (this.index < this.list.length - 1) return this.list[++this.index];
    this.index = -1;
    return this.typed;
  }

  /** Batch 3 scaffold. */
  clear(): void {}

  /** Leave browsing without touching the entries (the user edited the recalled text, or the field was rebuilt). */
  reset(): void { this.index = -1; this.typed = ''; }
}
