/**
 * dockDraftStore.ts
 *
 * The Ask field's draft, kept IN MEMORY ONLY. A draft can hold a secret (a token pasted into a prompt), so it is never
 * written to settings, vault or disk: it lives as long as the app process and is gone on quit. The dock reads and writes
 * through a store injected by the host, so a board re-mount (a fresh OrchestratorDock) keeps what the user was typing.
 * The shared instance is per JS realm, so boards in popout windows of one app share it; a mounted board reads it only
 * when it (re)builds its input, so the last writer wins.
 */
export const MAX_DRAFT_CHARS = 4000;

export interface DraftStore {
  get(key?: string): string;
  set(text: string, key?: string): void;
  clear(): void;
  /** K2 P5 batch 1 scaffold: bumps on every write (behaviour arrives with the fix). */
  readonly version: number;
}

export function createDraftStore(): DraftStore {
  let draft = '';
  return {
    version: 0,
    get: () => draft,
    set: (text) => { draft = text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text; },
    clear: () => { draft = ''; },
  };
}

/** What the Agent Board passes to its dock. */
export const windowDraftStore: DraftStore = createDraftStore();
