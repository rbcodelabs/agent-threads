/**
 * Chief of Staff first-run onboarding (Chief of Staff Pack Spec §10).
 *
 * Pure decision logic plus a dependency-injected orchestration function, so the
 * whole flow is unit-testable without an Obsidian App. `main.ts` supplies the
 * real side effects (clone, ThreadManager, Chat view, settings persistence).
 *
 * No Obsidian or Node imports on purpose.
 */
import type { AgentHarness, SkillSource } from './types';
import { stripTrailingPathSeparators, stripTrailingSlashes } from './trailingSlashes';

export const CHIEF_OF_STAFF_REPO_URL = 'https://github.com/rbcodelabs/chief-of-staff';
/**
 * Tag of the Chief of Staff pack that first run and "Set up Chief of Staff"
 * clone (`--branch <ref> --depth 1`). Bumped per plugin release so a given
 * plugin version always installs a known pack version. The tag must exist on
 * rbcodelabs/chief-of-staff before a release that references it ships.
 */
export const CHIEF_OF_STAFF_REF = 'v0.1.0';
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
  /**
   * True only when the plugin had no saved data at all (`loadData()` returned
   * null). A pre-flag install with saved settings but no threads is not fresh
   * and keeps the old static-guide first run.
   */
  isFreshInstall: boolean;
}): FirstRunDecision {
  if (input.hasSeenWelcome) return 'none';
  if (input.threadCount > 0) return 'mark-seen';
  return input.offerChiefOfStaff && input.isFreshInstall ? 'chief-of-staff' : 'static-guide';
}

/** A genuinely new install has no saved plugin data at all (`loadData()` → null/undefined). */
export function isFreshInstallData(saved: unknown): boolean {
  return saved == null;
}

/**
 * Harness for the Chief of Staff thread: the selected one if it can load skill
 * sources and resolves, else Claude, else Codex. OpenCode is never chosen —
 * its sessions do not receive skill sources, so `cos-setup` would not exist.
 */
export function chooseChiefOfStaffHarness(
  selected: AgentHarness,
  canResolve: (harness: AgentHarness) => boolean,
): AgentHarness | undefined {
  const skillCapable: AgentHarness[] = ['claude', 'codex'];
  const order = skillCapable.includes(selected) ? [selected, ...skillCapable.filter(h => h !== selected)] : skillCapable;
  return order.find(h => canResolve(h));
}

function normalizeRepoUrl(url: string): string {
  const withoutScheme = url.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  return stripTrailingSlashes(withoutScheme).replace(/\.git$/, '');
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
    .some(dir => env.exists(`${stripTrailingPathSeparators(dir)}${dirSep}${value}`));
}

/** Appends the one-line pointer to the command, used by the fallback guide. */
export function withChiefOfStaffPointer(guide: string, failureReason?: string): string {
  const base = guide.endsWith('\n') ? guide : `${guide}\n`;
  const reasonLine = failureReason ? `> Chief of Staff setup couldn\u2019t finish: ${failureReason}.\n>\n` : '';
  return `${base}\n> [!tip] Chief of Staff\n${reasonLine}> Run **"${CHIEF_OF_STAFF_COMMAND_NAME}"** from the command palette (\`Cmd+P\`) any time to add the Chief of Staff skills and start your Chief of Staff thread.\n`;
}

export interface ChiefOfStaffDeps {
  getSkillSources(): readonly SkillSource[];
  /** Checked before any clone, so a missing git falls back without a clone attempt. */
  isGitAvailable(): Promise<boolean>;
  /** Clone (pinned to `ref`) + add the source and persist it. Throws on failure. */
  addGithubSkillSource(repoUrl: string, ref: string): Promise<void>;
  /** A skill-capable harness to run the thread on, or undefined when none resolves. */
  resolveHarness(): AgentHarness | undefined;
  /**
   * Makes an existing thread pick up newly added skills. Returns true when a
   * live session was scheduled to restart (skills load on its next turn).
   */
  reloadThreadSkills(threadId: string): boolean;
  listThreads(): readonly { id: string; title: string }[];
  getStoredThreadId(): string | undefined;
  setStoredThreadId(id: string | undefined): void;
  /** Creates a persistent thread on `harness`. Throws on failure. */
  createThread(title: string, harness: AgentHarness): { id: string };
  /** Starts the first turn. Fire-and-forget. */
  sendPrompt(threadId: string, prompt: string): void;
  openThread(threadId: string): Promise<void>;
  saveSettings(): Promise<void>;
}

export type ChiefOfStaffFailureReason = 'git-unavailable' | 'clone-failed' | 'harness-unavailable' | 'thread-failed';

const NETWORK_ERROR = /could not resolve host|unable to access|failed to connect|timed out|timeout|connection (?:reset|refused|closed)|network is unreachable|could not read from remote|ssl|tls|early eof|rpc failed/i;
const MISSING_REMOTE = /repository not found|remote branch .* not found|could not find remote branch|couldn't find remote ref|not found in upstream/i;

/**
 * A short, human reason for a failed setup, safe to show in a Notice or the
 * guide. Deliberately a fixed set of phrases: the raw error (git output, URLs,
 * stack frames) only ever goes to the console.
 */
export function describeChiefOfStaffFailure(reason: ChiefOfStaffFailureReason | 'unexpected', error: string): string {
  switch (reason) {
    case 'git-unavailable':
      return 'git isn\u2019t installed';
    case 'harness-unavailable':
      return 'no Claude Code or Codex found';
    case 'thread-failed':
      return 'couldn\u2019t start the thread';
    case 'clone-failed':
      if (/not on a local filesystem/i.test(error)) return 'this vault isn\u2019t on a local disk, so skills can\u2019t be downloaded';
      if (MISSING_REMOTE.test(error)) return 'the Chief of Staff skills aren\u2019t available to download yet';
      if (NETWORK_ERROR.test(error)) return 'couldn\u2019t download the Chief of Staff skills \u2014 check your internet connection';
      return 'couldn\u2019t download the Chief of Staff skills';
    default:
      return 'something went wrong during setup';
  }
}

export type ChiefOfStaffResult =
  | { status: 'created'; threadId: string; sourceAdded: boolean; harness: AgentHarness }
  | { status: 'focused-existing'; threadId: string; sourceAdded: boolean; skillsReloadPending: boolean; sourceError?: string; sourceFailure?: ChiefOfStaffFailureReason }
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
  let sourceFailure: ChiefOfStaffFailureReason | undefined;
  if (!hasSkillSourceForRepo(deps.getSkillSources(), CHIEF_OF_STAFF_REPO_URL)) {
    if (!(await deps.isGitAvailable())) {
      sourceFailure = 'git-unavailable';
      sourceError = 'git is not installed, so the Chief of Staff skills cannot be downloaded.';
    } else {
      try {
        await deps.addGithubSkillSource(CHIEF_OF_STAFF_REPO_URL, CHIEF_OF_STAFF_REF);
        sourceAdded = true;
      } catch (err) {
        sourceFailure = 'clone-failed';
        sourceError = message(err);
      }
    }
  }

  if (existingId) {
    if (deps.getStoredThreadId() !== existingId) {
      deps.setStoredThreadId(existingId);
      await deps.saveSettings();
    }
    // Skills are resolved when a session starts, so a live session would not
    // see a source added just now until it restarts.
    const skillsReloadPending = sourceAdded ? deps.reloadThreadSkills(existingId) : false;
    await deps.openThread(existingId);
    const result: ChiefOfStaffResult = { status: 'focused-existing', threadId: existingId, sourceAdded, skillsReloadPending };
    if (sourceError !== undefined) {
      result.sourceError = sourceError;
      result.sourceFailure = sourceFailure;
    }
    return result;
  }

  if (sourceFailure) return { status: 'failed', reason: sourceFailure, error: sourceError ?? sourceFailure };
  const harness = deps.resolveHarness();
  if (!harness) {
    return {
      status: 'failed',
      reason: 'harness-unavailable',
      error: 'Chief of Staff needs Claude Code or Codex installed (OpenCode sessions do not load skill sources yet).',
    };
  }

  let threadId: string;
  try {
    threadId = deps.createThread(CHIEF_OF_STAFF_THREAD_TITLE, harness).id;
  } catch (err) {
    return { status: 'failed', reason: 'thread-failed', error: message(err) };
  }

  // Persist the home-thread id before the first turn starts, so a reload
  // mid-turn still finds it and the command stays idempotent.
  deps.setStoredThreadId(threadId);
  await deps.saveSettings();
  deps.sendPrompt(threadId, CHIEF_OF_STAFF_SETUP_PROMPT);
  await deps.openThread(threadId);
  return { status: 'created', threadId, sourceAdded, harness };
}
