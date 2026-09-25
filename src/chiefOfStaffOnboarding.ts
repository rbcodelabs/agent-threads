/**
 * Chief of Staff first-run onboarding (Chief of Staff Pack Spec §10).
 *
 * Pure decision logic plus a dependency-injected orchestration function, so the
 * whole flow is unit-testable without an Obsidian App. `main.ts` supplies the
 * real side effects (clone, ThreadManager, Chat view, settings persistence).
 *
 * No Obsidian or Node imports on purpose.
 */
import type { SkillSource } from './types';

export const CHIEF_OF_STAFF_REPO_URL = 'https://github.com/rbcodelabs/chief-of-staff';
export const CHIEF_OF_STAFF_THREAD_TITLE = 'Chief of Staff';
export const CHIEF_OF_STAFF_SETUP_PROMPT = 'Run the cos-setup skill to set me up with my Chief of Staff.';
export const CHIEF_OF_STAFF_COMMAND_ID = 'set-up-chief-of-staff';
export const CHIEF_OF_STAFF_COMMAND_NAME = 'Set up Chief of Staff';

/**
 * - `none`: onboarding already happened.
 * - `mark-seen`: an upgrading user (already has threads) — flip the flag, touch nothing else.
 * - `chief-of-staff`: brand-new install with the offer enabled.
 * - `static-guide`: brand-new install with the offer disabled (the original first run).
 */
export type FirstRunDecision = 'none' | 'mark-seen' | 'chief-of-staff' | 'static-guide';

export function decideFirstRun(input: {
  hasSeenWelcome: boolean;
  threadCount: number;
  offerChiefOfStaff: boolean;
}): FirstRunDecision {
  if (input.hasSeenWelcome) return 'none';
  if (input.threadCount > 0) return 'mark-seen';
  return input.offerChiefOfStaff ? 'chief-of-staff' : 'static-guide';
}

function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

/** True when a GitHub-type source for `repoUrl` is already configured. */
export function hasSkillSourceForRepo(sources: readonly SkillSource[] | undefined, repoUrl: string): boolean {
  const target = normalizeRepoUrl(repoUrl);
  return (sources ?? []).some(s => s.type === 'github' && !!s.repoUrl && normalizeRepoUrl(s.repoUrl) === target);
}

/**
 * The Chief of Staff home thread: the stored id if that thread still exists
 * (it may have been renamed), else a thread titled "Chief of Staff".
 */
export function findChiefOfStaffThreadId(
  threads: readonly { id: string; title: string }[],
  storedId: string | undefined,
): string | undefined {
  if (storedId && threads.some(t => t.id === storedId)) return storedId;
  return threads.find(t => t.title === CHIEF_OF_STAFF_THREAD_TITLE)?.id;
}

/**
 * Whether a configured harness binary can be launched: an absolute path must
 * exist; a bare command name must be found on PATH.
 */
export function isBinaryResolvable(
  binary: string,
  env: { exists: (path: string) => boolean; pathEnv: string | undefined; pathSeparator?: string; dirSeparator?: string },
): boolean {
  const value = binary.trim();
  if (!value) return false;
  const dirSep = env.dirSeparator ?? '/';
  if (value.includes('/') || value.includes('\\')) return env.exists(value);
  const sep = env.pathSeparator ?? ':';
  return (env.pathEnv ?? '')
    .split(sep)
    .filter(Boolean)
    .some(dir => env.exists(`${dir.replace(/[\\/]+$/, '')}${dirSep}${value}`));
}

/** Appends the one-line pointer to the command, used by the fallback guide. */
export function withChiefOfStaffPointer(guide: string): string {
  const base = guide.endsWith('\n') ? guide : `${guide}\n`;
  return `${base}\n> [!tip] Chief of Staff\n> Run **"${CHIEF_OF_STAFF_COMMAND_NAME}"** from the command palette (\`Cmd+P\`) any time to add the Chief of Staff skills and start your Chief of Staff thread.\n`;
}

export interface ChiefOfStaffDeps {
  getSkillSources(): readonly SkillSource[];
  /** Clone + add the source and persist it. Throws on failure. */
  addGithubSkillSource(repoUrl: string): Promise<void>;
  isHarnessReady(): boolean;
  listThreads(): readonly { id: string; title: string }[];
  getStoredThreadId(): string | undefined;
  setStoredThreadId(id: string | undefined): void;
  /** Creates a persistent thread. Throws on failure. */
  createThread(title: string): { id: string };
  /** Starts the first turn. Fire-and-forget. */
  sendPrompt(threadId: string, prompt: string): void;
  openThread(threadId: string): Promise<void>;
  saveSettings(): Promise<void>;
}

export type ChiefOfStaffFailureReason = 'clone-failed' | 'harness-unavailable' | 'thread-failed';

export type ChiefOfStaffResult =
  | { status: 'created'; threadId: string; sourceAdded: boolean }
  | { status: 'focused-existing'; threadId: string; sourceError?: string }
  | { status: 'failed'; reason: ChiefOfStaffFailureReason; error: string };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ensures the skill source, then focuses the existing home thread or creates
 * one and starts `cos-setup`. Idempotent: a second run focuses the thread the
 * first run created. Never throws for the expected failures — they come back
 * as `status: 'failed'` so the caller can fall back to the static guide.
 */
export async function setUpChiefOfStaff(deps: ChiefOfStaffDeps): Promise<ChiefOfStaffResult> {
  const existingId = findChiefOfStaffThreadId(deps.listThreads(), deps.getStoredThreadId());

  let sourceAdded = false;
  let sourceError: string | undefined;
  if (!hasSkillSourceForRepo(deps.getSkillSources(), CHIEF_OF_STAFF_REPO_URL)) {
    try {
      await deps.addGithubSkillSource(CHIEF_OF_STAFF_REPO_URL);
      sourceAdded = true;
    } catch (err) {
      sourceError = message(err);
    }
  }

  if (existingId) {
    if (deps.getStoredThreadId() !== existingId) {
      deps.setStoredThreadId(existingId);
      await deps.saveSettings();
    }
    await deps.openThread(existingId);
    return sourceError === undefined
      ? { status: 'focused-existing', threadId: existingId }
      : { status: 'focused-existing', threadId: existingId, sourceError };
  }

  if (sourceError !== undefined) return { status: 'failed', reason: 'clone-failed', error: sourceError };
  if (!deps.isHarnessReady()) {
    return { status: 'failed', reason: 'harness-unavailable', error: 'The selected agent harness is not installed or configured.' };
  }

  let threadId: string;
  try {
    threadId = deps.createThread(CHIEF_OF_STAFF_THREAD_TITLE).id;
  } catch (err) {
    return { status: 'failed', reason: 'thread-failed', error: message(err) };
  }

  // Persist the home-thread id before the first turn starts, so a reload
  // mid-turn still finds it and the command stays idempotent.
  deps.setStoredThreadId(threadId);
  await deps.saveSettings();
  deps.sendPrompt(threadId, CHIEF_OF_STAFF_SETUP_PROMPT);
  await deps.openThread(threadId);
  return { status: 'created', threadId, sourceAdded };
}
