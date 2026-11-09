// K2 P5 scaffold: signatures only (behaviour arrives in the implementation commit).
export const HISTORY_LIMIT = 20;
export class InputHistory {
  readonly entries: string[] = [];
  get browsing(): boolean { return false; }
  get shown(): string | undefined { return undefined; }
  push(_text: string): void {}
  previous(_current: string): string | undefined { return undefined; }
  next(): string | undefined { return undefined; }
  reset(): void {}
}
