/**
 * Turns the raw `detail` string of a permission request into something
 * readable. Sessions fall back to `JSON.stringify(toolInput)` when the SDK
 * gives no description, which used to be dumped verbatim into the card.
 */

export interface PermissionDetailField {
  key: string;
  value: string;
}

export interface ParsedPermissionDetail {
  /** One-line, human-friendly summary (always present when detail is non-empty). */
  summary: string;
  /** Structured key/value rows when detail was a JSON object; otherwise null. */
  fields: PermissionDetailField[] | null;
}

/** Input keys that best describe "what is this call about", in priority order. */
const PRIMARY_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt'];

const SUMMARY_MAX = 120;

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function stringifyValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

export function parsePermissionDetail(detail: string): ParsedPermissionDetail {
  const text = (detail ?? '').trim();
  if (!text) return { summary: '', fields: null };

  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const entries = Object.entries(obj as Record<string, unknown>);
        if (entries.length > 0) {
          const fields = entries.map(([key, value]) => ({ key, value: stringifyValue(value) }));
          const primary = PRIMARY_KEYS.map(k => fields.find(f => f.key === k)).find(Boolean);
          const summary = primary
            ? truncate(primary.value, SUMMARY_MAX)
            : truncate(fields.map(f => `${f.key}: ${f.value}`).join(', '), SUMMARY_MAX);
          return { summary, fields };
        }
      }
    } catch {
      // not JSON — fall through to plain text
    }
  }
  return { summary: truncate(text, SUMMARY_MAX), fields: null };
}

/** One-line summary for compact surfaces (dashboard, kanban). */
export function summarizePermissionDetail(detail: string): string {
  return parsePermissionDetail(detail).summary;
}
