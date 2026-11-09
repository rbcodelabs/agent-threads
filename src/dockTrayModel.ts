/**
 * dockTrayModel.ts
 *
 * Pure model for the reply sheet's Needs-you tray: which attention items it lists, the collapse beyond
 * three, the hand-off labels and the screen-reader text. No `obsidian` import and no manager access.
 *
 * The tray lists exactly what the dot and the board's Needs-you lane count (attentionItems minus failures),
 * so the heading number can never disagree with them.
 */
import type { AttentionItem } from './orchestratorDockModel';

export type TrayKind = Exclude<AttentionItem['kind'], 'failed'>;
export type TrayItem = AttentionItem & { kind: TrayKind };

/** More than this many items collapse behind "Show N more". */
export const TRAY_COLLAPSE_AT = 3;

/** Everything awaiting the user, in attentionItems (board) order. Failures are triage, not approvals. */
export function trayItems(items: readonly AttentionItem[]): TrayItem[] {
  return items.filter((i): i is TrayItem => i.kind !== 'failed');
}

export function visibleTrayItems<T>(items: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || items.length <= TRAY_COLLAPSE_AT) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, TRAY_COLLAPSE_AT), hidden: items.length - TRAY_COLLAPSE_AT };
}

/** The ONE button a card without inline buttons gets (never an inline answer / approval). */
export function handoffLabel(kind: TrayKind): string {
  return kind === 'question' ? 'Answer…' : kind === 'plan' ? 'Review plan…' : 'Open thread…';
}

/** Accessible names start with the visible label and carry the thread title. */
export function handoffAriaLabel(kind: TrayKind, title: string): string {
  if (kind === 'question') return `Answer ${title} in its thread`;
  if (kind === 'plan') return `Review plan for ${title}`;
  return `Open ${title} to resolve its permission request`;
}

/** Polite announcement for a card that just arrived. */
export function announcementFor(item: TrayItem): string {
  if (item.kind === 'question') return `${item.title} has a question`;
  if (item.kind === 'plan') return `${item.title} has a plan to review`;
  return `${item.title} needs approval`;
}
