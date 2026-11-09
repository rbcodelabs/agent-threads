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
  get(): string;
  set(text: string): void;
  clear(): void;
}

export function createDraftStore(): DraftStore {
  let draft = '';
  return {
    get: () => draft,
    set: (text) => { draft = text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text; },
    clear: () => { draft = ''; },
  };
}

/** What the Agent Board passes to its dock. */
export const windowDraftStore: DraftStore = createDraftStore();
