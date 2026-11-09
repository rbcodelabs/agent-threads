/**
 * dockSheetModel.ts
 *
 * Pure, host-free projection helpers for the OrchestratorDock reply sheet: what a message holds
 * that the sheet cannot draw (it then shows a quiet "Open full thread" chip), the sheet transcript
 * built ON `dockTranscript`, and the one-line peek text for an unread reply. No `obsidian` import
 * (guarded by orchestrator-dock-purity.test.ts).
 */
import { dockTranscript, splitThreadLinks, type ThreadRef } from './orchestratorDockModel';

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

// K2 P5 scaffold: signature only.
export function sheetBlock(_i: {
  ownId: string; pendingPlan: boolean; pendingQuestion: boolean; pendingPermission: boolean;
  tray: readonly { item: { threadId: string; kind: string }; permission?: unknown }[];
}): 'plan' | 'question' | 'permission' | null { return null; }
