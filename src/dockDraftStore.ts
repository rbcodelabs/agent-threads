/**
 * dockDraftStore.ts
 *
 * The Ask field's draft, kept IN MEMORY ONLY. A draft can hold a secret (a token pasted into a prompt), so it is never
 * written to settings, vault or disk: it lives as long as the app window's JS realm and is gone on quit. The dock reads and
 * writes through a store injected by the host, so a board re-mount (a fresh OrchestratorDock) keeps what the user was typing.
 *
 * Scope: one store per JS realm (module instance). Boards of the same window, including popouts that share its realm, share
 * it; whether Obsidian/Geode give each vault window its own module realm is an assumption that was NOT verified.
 *
 * Two safeguards against a stale writer resurrecting a SENT draft (two boards mounted, one still holding the old text):
 *  - the draft is KEYED by the orchestrator thread id, so a swapped / re-set-up orchestrator never reads another's draft;
 *  - every write bumps `version`; a dock only writes back what it holds when the version is the one it last wrote.
 */
export const MAX_DRAFT_CHARS = 4000;

export interface DraftStore {
  /** The draft for `key` (the orchestrator thread id); '' when the stored draft belongs to another key. */
  get(key?: string): string;
  set(text: string, key?: string): void;
  clear(): void;
  /** Bumps on every set and clear. */
  readonly version: number;
}

export function createDraftStore(): DraftStore {
  let draft = '';
  let owner = '';
  let version = 0;
  return {
    get version() { return version; },
    get: (key = '') => (key === owner ? draft : ''),
    set: (text, key = '') => {
      draft = text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text;
      owner = key;
      version++;
    },
    clear: () => { draft = ''; owner = ''; version++; },
  };
}

/** What the Agent Board passes to its dock. */
export const windowDraftStore: DraftStore = createDraftStore();
