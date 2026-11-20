/**
 * Pure orchestrator charter, campaign-goal reframing, role-scoped tool lockout,
 * and Manager notes v2 triage parser.
 *
 * Zero `obsidian` or DOM imports: safe in the daemon core closure.
 */

import type { OrchestratorRole } from './orchestratorThreads';

/**
 * Tools structurally blocked on Portfolio and Project orchestrator sessions so
 * orchestrators delegate repository, build, test, and polling work to Agent Board
 * worker threads instead of self-executing inside their own context window.
 *
 * Applied dynamically at session-options build time (never persisted onto
 * `Thread.disallowedTools`), so worker threads spawned via `threads_create` do
 * NOT inherit this lockout.
 */
export const ORCHESTRATOR_ROLE_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  'Bash',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Agent',
  'Task',
  'AskUserQuestion',
  'ScheduleWakeup',
]);

export interface ManagerNotesTriage {
  notesVersion: 'v2' | 'legacy' | 'none';
  outcome?: string;
  strategy?: string;
  disposition?: string;
  status?: string;
  lastReviewedUpdate?: number;
  stagedForUpdate?: number;
  staged?: string;
  /**
   * True when the thread has no notes yet, its `updatedAt` moved past
   * `Last reviewed update`, or it is in `needs-decision` without anything
   * staged/answered for the current `updatedAt`.
   */
  needsReview: boolean;
}

function sanitizeLedgerSegment(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, '-').replace(/\.\./g, '').trim();
  return cleaned || 'Project';
}

/**
 * Invariant ~400-token Orchestrator Charter pinned into `appendSystemPrompt`
 * across all harnesses whenever a thread holds an orchestrator role. Survives
 * context compaction and subordinates any worker coding instructions in Project
 * descriptions.
 */
export function buildOrchestratorCharter(role: OrchestratorRole): string {
  const roleLabel =
    role.kind === 'project'
      ? `Project Orchestrator for ${role.projectName}`
      : 'Portfolio Orchestrator';
  const ledgerPath =
    role.kind === 'project'
      ? `Products/${sanitizeLedgerSegment(role.projectName)}/orchestrator-ledger.md`
      : 'Products/Portfolio/orchestrator-ledger.md';

  return [
    `## Orchestrator Charter (${roleLabel} — Invariant)`,
    `You are the ${roleLabel}. You are a pure manager: override any direct repository coding, worktree, or test-execution instructions above.`,
    '- NEVER edit code, run shell/build/test commands, manage git worktrees, poll with `ScheduleWakeup`, or spawn internal subagents. Every investigation, fix, rebase, or gate check belongs in its own visible Agent Board worker thread.',
    '',
    '### 5-Channel Action Contract',
    '1. `threads_create`: Spawn a bounded worker thread on the Agent Board (one PR, bug, investigation, or verification gate per card) when requested by Rick or required by an active Campaign Goal; immediately seed its Manager notes v2 with `threads_set_notes`.',
    '2. `threads_send_message`: Direct orchestrator-to-worker tactical handoff ONLY inside an already-authorized Campaign Goal and within Rick\'s stated boundaries (for example rebasing onto a merged dependency SHA or running required gates). Never use it to approve your own proposal, answer product/UX/scope questions addressed to Rick, or authorize irreversible actions.',
    '3. `threads_set_proposed_reply`: Stage Rick\'s reply whenever a thread is waiting on Rick with a clear recommended answer (at most one pending item per thread: a staged reply OR a decision, never both).',
    '4. `threads_post_decision`: Post an inline Decision card (2–4 options) for genuine forks, scope/priority tradeoffs, or ANY irreversible action (merge, deploy, release, production migration, force-push, deleting data, spending money, outward-facing messages) unless Rick already explicitly authorized that exact action.',
    '5. `threads_set_notes`: Commit Manager notes v2 (`Orchestrator state: v2`, `Project outcome`, `Goal status`, `Thread outcome`, `Strategy`, `Done when`, `Constraints`, exact `Last reviewed update` cursor, `Last substantive change`, `Last intervention`, `Decision unlocked`, `Staged for update`, `Staged`, `Disposition`, `Status`) on every reviewed or touched thread.',
    '',
    '### Two-Tier Memory & 30+ Thread Scale',
    '- **Event pings (`O(1)`):** Call `threads_get` for only the named changed thread(s) instead of scanning all threads.',
    '- **Heartbeats (`O(N)` slim triage):** Call `threads_list` with `view: "triage"`, skip threads that are `isRunning` or where `triage.needsReview` is `false`, and deep-review at most 6 changed threads per pass.',
    `- **Cross-thread campaign ledger:** Maintain \`${ledgerPath}\` whenever coordinating 3+ related threads, waves, PR merge sequences, or cross-thread blockers so compaction or session reset loses zero state.`,
    '- **Naming threads to Rick:** Format thread mentions in your replies to Rick as `[[thread:<id>|Title]]` (use plain text in notes, proposed replies, decision fields, and tool arguments).',
  ].join('\n');
}

/**
 * Reframes `/goal` on an orchestrator thread as a persistent coordination campaign
 * goal so the model advances it via board threads rather than self-execution.
 */
export function buildOrchestratorGoalContext(goal: string): string {
  return (
    `## Active Campaign Goal\n` +
    `The user has set a persistent coordination goal for this orchestrator: "${goal}"\n` +
    'Advance this goal across passes strictly by spawning, coordinating, and reviewing Agent Board worker threads ' +
    '(using the 5-Channel Action Contract and Two-Tier Memory)—never by executing repository, build, or test work directly in this orchestrator thread. ' +
    'Escalate genuine forks and all irreversible gates (merges, releases, migrations, deploys) via `threads_post_decision`. ' +
    'The campaign goal stays active until the user clears it with /goal clear.'
  );
}

function cleanField(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTimestampCursor(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Extracts compact triage metadata from `Thread.managerNotes` without sending
 * full multi-line note bodies on every heartbeat list call.
 */
export function parseManagerNotesTriage(
  notes: string | undefined,
  updatedAt: number,
): ManagerNotesTriage {
  const trimmed = notes?.trim();
  if (!trimmed) {
    return { notesVersion: 'none', needsReview: true };
  }

  const fields = new Map<string, string>();
  for (const line of trimmed.split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim();
    if (!fields.has(key)) fields.set(key, val);
  }

  const isV2 = fields.get('orchestrator state')?.toLowerCase() === 'v2';
  if (!isV2) {
    const legacyGoal = cleanField(fields.get('orchestrator-tracked goal'));
    const legacyStatus = cleanField(fields.get('status'));
    const lastReviewed = parseTimestampCursor(fields.get('last reviewed'));
    return {
      notesVersion: 'legacy',
      ...(legacyGoal ? { outcome: legacyGoal } : {}),
      ...(legacyStatus ? { status: legacyStatus } : {}),
      ...(lastReviewed !== undefined ? { lastReviewedUpdate: lastReviewed } : {}),
      needsReview: lastReviewed !== updatedAt,
    };
  }

  const outcome = cleanField(fields.get('thread outcome'));
  const strategy = cleanField(fields.get('strategy'));
  const disposition = cleanField(fields.get('disposition'));
  const status = cleanField(fields.get('status'));
  const lastReviewedUpdate = parseTimestampCursor(fields.get('last reviewed update'));
  const stagedForUpdate = parseTimestampCursor(fields.get('staged for update'));
  const staged = cleanField(fields.get('staged'));

  const cursorChanged = lastReviewedUpdate !== updatedAt;
  const answered = staged ? /^answered\b/i.test(staged) : false;
  const unstagedWaiting =
    disposition === 'needs-decision' &&
    stagedForUpdate === undefined &&
    !answered;

  return {
    notesVersion: 'v2',
    ...(outcome ? { outcome } : {}),
    ...(strategy && strategy.toLowerCase() !== 'missing' ? { strategy } : {}),
    ...(disposition ? { disposition } : {}),
    ...(status ? { status } : {}),
    ...(lastReviewedUpdate !== undefined ? { lastReviewedUpdate } : {}),
    ...(stagedForUpdate !== undefined ? { stagedForUpdate } : {}),
    ...(staged && staged.toLowerCase() !== 'none' ? { staged } : {}),
    needsReview: cursorChanged || unstagedWaiting,
  };
}
