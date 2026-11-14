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
 *  - the draft is KEYED by the orchestrator thread id (one slot per orchestrator), so a swapped / re-set-up orchestrator never
 *    reads another's draft;
 *  - every write bumps `version`; a dock only writes back what it holds when the version is the one it last wrote.
 */
export const MAX_DRAFT_CHARS = 4000;

export interface DraftStore {
  /** The draft for `key` (the orchestrator thread id); '' when that key holds none. */
  get(key?: string): string;
  /** Sets `key`'s draft; an empty text removes it. Other keys' drafts are untouched. */
  set(text: string, key?: string): void;
  /** Drops `key`'s draft, or every draft when no key is given. */
  clear(key?: string): void;
  /** Whether `key` holds a non-empty draft (the orchestrator menu's draft mark). */
  has(key: string): boolean;
  /** Every key that holds a non-empty draft (the dock drops those of orchestrators that no longer exist). */
  keys(): string[];
  /** Bumps on every set and clear. */
  readonly version: number;
}

export function createDraftStore(): DraftStore {
  // One draft per orchestrator thread id: the dock talks to the Portfolio orchestrator AND every Project orchestrator.
  const drafts = new Map<string, string>();
  let version = 0;
  return {
    get version() { return version; },
    get: (key = '') => drafts.get(key) ?? '',
    has: (key) => (drafts.get(key) ?? '') !== '',
    keys: () => [...drafts.keys()],
    set: (text, key = '') => {
      const capped = text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text;
      if (capped) drafts.set(key, capped); else drafts.delete(key);
      version++;
    },
    clear: (key) => {
      if (key === undefined) drafts.clear(); else drafts.delete(key);
      version++;
    },
  };
}

/** What the Agent Board passes to its dock. */
export const windowDraftStore: DraftStore = createDraftStore();
