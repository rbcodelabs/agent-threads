/**
 * dockTargetModel.ts
 *
 * Pure, host-free model for the dock's orchestrator menu: which orchestrators the dock can talk to (the Portfolio
 * orchestrator and every Project orchestrator), which one it opens on, the per-target labels, the unread count, the
 * needs-you attribution and the rows of the menu. No `obsidian` import and no manager access (guarded by
 * orchestrator-dock-purity.test.ts); callers pass live values in.
 *
 * Project names are USER DATA: this module only ever returns strings. Whoever renders them must use textContent.
 */
import type { AttentionItem } from './orchestratorDockModel';

export interface DockTarget {
  /** The orchestrator thread the dock reads and writes. */
  threadId: string;
  kind: 'portfolio' | 'project';
  /** Set for a Project orchestrator. */
  projectId?: string;
  /** "Portfolio", or the project's name. */
  name: string;
}

export interface TargetSource {
  /** `settings.orchestratorThreadId`. */
  portfolioThreadId: string | undefined;
  projects: ReadonlyArray<{ id: string; name: string; orchestratorThreadId?: string }>;
  /** manager.getThread(id) !== undefined: a stale or archived thread id must not become a menu row. */
  threadExists(threadId: string): boolean;
}

/**
 * DECIDED DEFAULT (2): a project with no orchestrator thread yet, or with a stale / archived thread id, is HIDDEN. Creating one
 * stays in Settings, Orchestrators. A missing Portfolio orchestrator is simply absent from the list.
 * Portfolio first, then the projects in the order the manager lists them; a thread is never listed twice.
 */
export function buildDockTargets(src: TargetSource): DockTarget[] {
  const out: DockTarget[] = [];
  const seen = new Set<string>();
  const push = (t: DockTarget): void => {
    if (seen.has(t.threadId) || !src.threadExists(t.threadId)) return;
    seen.add(t.threadId);
    out.push(t);
  };
  if (src.portfolioThreadId) push({ threadId: src.portfolioThreadId, kind: 'portfolio', name: 'Portfolio' });
  for (const p of src.projects) {
    if (p.orchestratorThreadId) push({ threadId: p.orchestratorThreadId, kind: 'project', projectId: p.id, name: p.name });
  }
  return out;
}

/**
 * DECIDED DEFAULT (2, cont.): the title is a menu only when at least one Project orchestrator exists. With none, the sheet title
 * is the plain heading (DOM and screenshots identical to before this feature).
 */
export function hasTargetMenu(targets: readonly DockTarget[]): boolean {
  return targets.some((t) => t.kind === 'project');
}

/** DECIDED DEFAULT (1): the dock rests on the Portfolio orchestrator; without one, on the first Project orchestrator. */
export function defaultTargetId(targets: readonly DockTarget[]): string | undefined {
  return (targets.find((t) => t.kind === 'portfolio') ?? targets[0])?.threadId;
}

/** The selected target if it is still one, else the default (a target that went away mid-session never strands the dock). */
export function resolveTargetId(targets: readonly DockTarget[], selected: string | undefined): string | undefined {
  if (selected && targets.some((t) => t.threadId === selected)) return selected;
  return defaultTargetId(targets);
}

/**
 * DECIDED DEFAULT (1, cont.): every time the sheet opens it starts on the default target, EXCEPT when it is opened from an unread
 * peek, which opens on the target the reply came from (`requested`). An invalid request falls back to the default.
 */
export function targetOnOpen(targets: readonly DockTarget[], requested?: string): string | undefined {
  return resolveTargetId(targets, requested);
}

export interface TargetLabels {
  /** Sheet title / menu button text. */
  title: string;
  /** aria-label of the Ask field and the orb. */
  askLabel: string;
  /** aria-label of the sheet's scrolling transcript region. */
  regionLabel: string;
  /** Composer placeholder while the sheet is open. */
  replyPlaceholder: string;
  /** Composer placeholder while it is closed. */
  askPlaceholder: string;
  /** aria-label of the Stop button. */
  stopLabel: string;
  /** Bold lead-in of the unread peek. */
  peekName: string;
  /** Who owns a Needs-you card, as shown on the card. */
  ownerName: string;
  /** Subject of the screen-reader announcements: "Orchestrator replied: ..." / "Compass orchestrator replied: ...". */
  voice: string;
}

/** Portfolio keeps today's exact strings; a Project target names itself. No target (nothing set up) reads as the Portfolio. */
export function targetLabels(target: Pick<DockTarget, 'kind' | 'name'> | undefined): TargetLabels {
  if (!target || target.kind === 'portfolio') {
    return {
      title: 'Portfolio orchestrator',
      askLabel: 'Ask the portfolio orchestrator',
      regionLabel: 'Conversation with the portfolio orchestrator',
      replyPlaceholder: 'Reply…',
      askPlaceholder: 'Ask the orchestrator…',
      stopLabel: 'Stop the orchestrator',
      peekName: 'Orchestrator',
      ownerName: 'Portfolio',
      voice: 'Orchestrator',
    };
  }
  const noun = `${target.name} orchestrator`;
  return {
    title: noun,
    askLabel: `Ask the ${noun}`,
    regionLabel: `Conversation with the ${noun}`,
    replyPlaceholder: `Reply to ${noun}…`,
    askPlaceholder: `Ask the ${noun}…`,
    stopLabel: `Stop the ${noun}`,
    peekName: target.name,
    ownerName: target.name,
    voice: noun,
  };
}

/**
 * Assistant replies after the last one the user has seen. `lastSeenId` undefined means the thread's history was never looked at
 * yet: the dock seeds it on first sight, so that is read, not unread. A last-seen message that was rolled back out of the
 * transcript counts the latest reply as one unread.
 */
export function unreadCount(messages: ReadonlyArray<{ id: string; role: string }>, lastSeenId: string | undefined): number {
  if (lastSeenId === undefined) return 0;
  const at = messages.findIndex((x) => x.id === lastSeenId);
  if (at < 0) return messages.some((x) => x.role === 'assistant') ? 1 : 0;
  let n = 0;
  for (let i = at + 1; i < messages.length; i++) if (messages[i].role === 'assistant') n++;
  return n;
}

/**
 * How many threads that need the user belong to each orchestrator (the menu's needs-you badge). An orchestrator's own prompt counts
 * for itself; a thread of a project counts for that project's orchestrator; everything else (no project, or a project without a
 * visible orchestrator) belongs to the Portfolio orchestrator, and to nobody when there is none. Failures never count (they are
 * triage, as for the dot). The dot itself counts every awaiting thread regardless of this attribution.
 */
export function attributeNeedsYou(
  items: readonly AttentionItem[],
  targets: readonly DockTarget[],
  projectIdOf: (threadId: string) => string | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (id: string | undefined): void => { if (id) out.set(id, (out.get(id) ?? 0) + 1); };
  for (const item of items) {
    if (item.kind === 'failed') continue;
    bump(ownerOf(item.threadId, targets, projectIdOf)?.threadId);
  }
  return out;
}

/** The orchestrator an arbitrary thread belongs to (see attributeNeedsYou), or undefined when nobody owns it. */
export function ownerOf(threadId: string, targets: readonly DockTarget[], projectIdOf: (threadId: string) => string | undefined): DockTarget | undefined {
  const own = targets.find((t) => t.threadId === threadId);
  if (own) return own;
  const projectId = projectIdOf(threadId);
  const byProject = projectId ? targets.find((t) => t.kind === 'project' && t.projectId === projectId) : undefined;
  return byProject ?? targets.find((t) => t.kind === 'portfolio');
}

export interface TargetFacts {
  running: boolean;
  /** Errored, signed out or offline: anything the Ask field would show as a reason instead of an input. */
  error: boolean;
  unread: number;
  needsYou: number;
  hasDraft: boolean;
}

export type TargetStatus = 'running' | 'idle' | 'error';

export interface TargetRow extends TargetFacts {
  id: string;
  name: string;
  kind: DockTarget['kind'];
  status: TargetStatus;
  selected: boolean;
}

export function targetRows(targets: readonly DockTarget[], facts: (threadId: string) => TargetFacts, selectedId: string | undefined): TargetRow[] {
  return targets.map((t) => {
    const f = facts(t.threadId);
    return {
      ...f,
      id: t.threadId,
      name: t.name,
      kind: t.kind,
      status: f.error ? 'error' : f.running ? 'running' : 'idle',
      selected: t.threadId === selectedId,
    };
  });
}

/** The row's accessible name: the visible pieces, in words (the dot and the badges are decorative). */
export function rowAriaLabel(r: TargetRow): string {
  const parts = [r.name, r.status];
  if (r.unread > 0) parts.push(`${r.unread} unread ${r.unread === 1 ? 'reply' : 'replies'}`);
  if (r.needsYou > 0) parts.push(`${r.needsYou} ${r.needsYou === 1 ? 'needs' : 'need'} you`);
  if (r.hasDraft) parts.push('draft');
  return parts.join(', ');
}
