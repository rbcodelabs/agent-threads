// K2 P5 scaffold: signatures only (behaviour arrives in the implementation commit).
export const MAX_DRAFT_CHARS = 4000;
export interface DraftStore { get(): string; set(text: string): void; clear(): void }
export function createDraftStore(): DraftStore { return { get: () => '', set: () => {}, clear: () => {} }; }
export const windowDraftStore: DraftStore = createDraftStore();
