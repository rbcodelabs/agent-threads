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
 * with that kind: the first TRAY_COLLAPSE_AT entries, which hold whether the tray is expanded or collapsed. The
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
