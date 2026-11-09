/**
 * dockSheetModel.ts
 *
 * Pure, host-free projection helpers for the OrchestratorDock reply sheet: what a message holds
 * that the sheet cannot draw (it then shows a quiet "Open full thread" chip), the sheet transcript
 * built ON `dockTranscript`, and the one-line peek text for an unread reply. No `obsidian` import
 * (guarded by orchestrator-dock-purity.test.ts).
 */
import { dockTranscript, splitThreadLinks, type ThreadRef } from './orchestratorDockModel';
import { TRAY_COLLAPSE_AT } from './dockTrayModel';

export interface SheetSourceMessage {
  id: string;
  role: string;
  content: string;
  images?: readonly unknown[];
  toolResultImages?: readonly unknown[];
  toolCalls?: readonly unknown[];
}

export interface Richness { images: boolean; visualize: boolean; tools: number }

/** A `visualize{...}` content reference on its own line (the Codex visualize skill; see visualizeMarker.ts). */
const VISUALIZE_LINE = /^[ \t]*visualize\{.*\}[ \t]*(?:\n|$)/gm;

export function stripVisualizeLines(content: string): string {
  return content.replace(VISUALIZE_LINE, '').replace(/^\n+|\n+$/g, '');
}

export function richnessOf(m: Pick<SheetSourceMessage, 'content' | 'images' | 'toolResultImages' | 'toolCalls'>): Richness {
  return {
    images: (m.images?.length ?? 0) > 0 || (m.toolResultImages?.length ?? 0) > 0,
    visualize: new RegExp(VISUALIZE_LINE.source, 'm').test(m.content),
    tools: m.toolCalls?.length ?? 0,
  };
}

export interface SheetEntry { id: string; role: 'user' | 'assistant'; text: string; rich: Richness }

const hasRich = (r: Richness): boolean => r.images || r.visualize || r.tools > 0;

/**
 * The sheet transcript, re-derived from the thread's messages on every call (never an append-only
 * log: interrupt() rolls user messages back with no per-message event). Text entries come from
 * `dockTranscript`; a user/assistant message with NO text but rich content (an image-only reply, a
 * bare visualize marker) is kept as a chip-only entry so it is never silently hidden.
 */
export function sheetTranscript(messages: readonly SheetSourceMessage[]): SheetEntry[] {
  const withText = new Set(dockTranscript(messages).map((e) => e.id));
  const out: SheetEntry[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const rich = richnessOf(m);
    const text = stripVisualizeLines(m.content);
    if (withText.has(m.id) ? (text.trim() === '' && !hasRich(rich)) : !hasRich(rich)) continue;
    out.push({ id: m.id, role: m.role, text, rich });
  }
  return out;
}

const MAX_PEEK_CHARS = 240;

/** First non-empty line of a reply as plain text (markdown stripped, thread links -> labels), for the unread peek. */
export function peekLine(markdown: string, threads: readonly ThreadRef[]): string {
  const line = markdown.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const plain = splitThreadLinks(line, threads).map((s) => (s.type === 'text' ? s.text : s.label)).join('')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > MAX_PEEK_CHARS ? plain.slice(0, MAX_PEEK_CHARS) : plain;
}

export type SheetBlockKind = 'plan' | 'question' | 'permission';

/**
 * Which "waiting for you" notice the sheet shows for the orchestrator's OWN pending prompt, or null. The tray already
 * hands off plans / questions ("Review plan…" / "Answer…") and gives the orchestrator's own permission real buttons, so a
 * notice would only repeat them. A plan / question notice is hidden only when the tray visibly lists the orchestrator
 * with that kind: the first TRAY_COLLAPSE_AT entries, which are shown whether the tray is expanded or collapsed. CONSERVATIVE
 * by design: the expanded state is not an input, so an entry past the third is treated as not listed even when the tray is
 * expanded and shows it (the notice may then repeat the card; it is never missing). The
 * permission notice is hidden only by the orchestrator's own permission entry that has buttons (P4 rule).
 * Order plan -> question -> permission; a suppressed notice falls through to the next pending one.
 */
export function sheetBlock(i: {
  ownId: string;
  pendingPlan: boolean;
  pendingQuestion: boolean;
  pendingPermission: boolean;
  tray: readonly { item: { threadId: string; kind: string }; permission?: unknown }[];
}): SheetBlockKind | null {
  const visible = i.tray.slice(0, TRAY_COLLAPSE_AT);
  const listed = (kind: string): boolean => visible.some((e) => e.item.threadId === i.ownId && e.item.kind === kind);
  if (i.pendingPlan && !listed('plan')) return 'plan';
  if (i.pendingQuestion && !listed('question')) return 'question';
  const ownPermissionWithButtons = i.tray.some((e) => e.item.threadId === i.ownId && e.item.kind === 'permission' && !!e.permission);
  if (i.pendingPermission && !ownPermissionWithButtons) return 'permission';
  return null;
}

/** The tray's share of the sheet, the transcript room it tries to leave, and the floor below which it never shrinks. */
export const TRAY_SHARE = 0.55;
export const MIN_TRANSCRIPT_PX = 80;
export const MIN_TRAY_PX = 52; // a 44px button plus its padding: the smallest band a card's buttons can be scrolled into

/**
 * How tall the Needs-you tray may be inside a sheet of `max` px whose fixed chrome (handle, header, composer) is `fixed` px.
 * The COMPOSER WINS: the tray never takes more than `max - fixed` (it scrolls inside that), so the sheet's overflow never
 * clips the composer (below MIN_TRAY_PX of room the tray COLLAPSES to a one-row hand-off and may take 0). Within that room it wants a share of the sheet, at least the first card with its buttons, and leaves
 * the transcript MIN_TRANSCRIPT_PX if it can. When even the first card does not fit, the COMPACT form (title and buttons,
 * detail collapsed, heading not sticky) is used. A first card that is partly clipped but scrollable beats a clipped composer.
 */
export function trayLayout(i: { max: number; fixed: number; needFull: number; needCompact: number }): { cap: number; compact: boolean; collapsed: boolean } {
  const room = i.max - i.fixed;
  // Not even a card's buttons fit: the body collapses to a one-row hand-off (or nothing at all) and the composer keeps its room.
  if (room < MIN_TRAY_PX) return { cap: Math.max(0, room), compact: true, collapsed: true };
  const compact = i.needFull > room;
  const need = compact ? i.needCompact : i.needFull;
  const wanted = Math.max(need, Math.min(i.max * TRAY_SHARE, room - MIN_TRANSCRIPT_PX));
  return { cap: Math.max(MIN_TRAY_PX, Math.min(wanted, room)), compact, collapsed: false };
}

/** Below this much room the reply sheet renders MICRO (header + composer only: no transcript, no tray). */
export const MIN_SHEET_PX = 96;

/**
 * What the sheet does with `max` px of room (the space above the lifted pill / keyboard; it can be 0 or negative): normal
 * at or above the floor; MICRO below it; HIDDEN (it waits until the room returns) when even the header + composer
 * (`chromeNeed`) do not fit. The sheet is never taller than its room, so it never starts above the top of the view.
 */
export function sheetFit(i: { max: number; chromeNeed: number }): { micro: boolean; hidden: boolean } {
  const micro = i.max < MIN_SHEET_PX;
  return { micro, hidden: micro && i.max < i.chromeNeed };
}
