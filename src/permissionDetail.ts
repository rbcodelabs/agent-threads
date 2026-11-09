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
  /**
   * Plain-text details that span several lines (e.g. the cross-project spawn
   * request) keep their line breaks here, each line capped. Only set when the
   * detail is non-JSON and has more than one non-empty line; the card prefers
   * it over `summary`, compact surfaces keep using the flattened `summary`.
   */
  multiline?: string;
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

/** Remote host-tool cards read `Run <tool> for a remote thread: <JSON input>`; the JSON is shown as fields, in full. */
const REMOTE_CALL_DETAIL = /^Run (\S+) for a remote thread: (\{[\s\S]*\})$/;

export function parsePermissionDetail(detail: string): ParsedPermissionDetail {
  const text = (detail ?? '').trim();
  if (!text) return { summary: '', fields: null };
  const remote = REMOTE_CALL_DETAIL.exec(text);
  if (remote) {
    const inner = parsePermissionDetail(remote[2]);
    if (inner.fields) return { ...inner, summary: truncate(`${remote[1]}: ${inner.summary}`, SUMMARY_MAX) };
  }

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
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    return {
      summary: truncate(text, SUMMARY_MAX),
      fields: null,
      multiline: lines.map(l => truncate(l, SUMMARY_MAX)).join("\n"),
    };
  }
  return { summary: truncate(text, SUMMARY_MAX), fields: null };
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Does the one-line summary show EVERYTHING the user would be approving? Length is not the only way to hide something:
 * a JSON detail with a primary key summarises to that field's value alone (`{"command":"ls","dangerouslyDisableSandbox":
 * true}` reads "ls"). Small approval surfaces only offer inline Allow / Always when this is true; otherwise the request
 * is reviewed in its thread. True for: plain text that is not cut, and a SINGLE-field JSON object whose summary is
 * exactly that field (value for a primary key, `key: value` otherwise) without truncation. Remote-call details
 * (`Run <tool> for a remote thread: {...}`) are judged on their inner object.
 */
export function isFullyShownDetail(detail: string): boolean {
  const text = (detail ?? '').trim();
  if (!text) return true;
  const parsed = parsePermissionDetail(detail);
  if (!parsed.fields) return flat(parsed.summary) === flat(text);
  if (parsed.fields.length !== 1) return false;
  const only = parsed.fields[0];
  const remote = REMOTE_CALL_DETAIL.exec(text);
  const prefix = remote ? `${remote[1]}: ` : '';
  const expected = PRIMARY_KEYS.includes(only.key) ? only.value : `${only.key}: ${only.value}`;
  return flat(parsed.summary) === flat(`${prefix}${expected}`);
}

/** One-line summary for compact surfaces (dashboard, kanban). */
export function summarizePermissionDetail(detail: string): string {
  return parsePermissionDetail(detail).summary;
}

export { HOST_EXEC_PERMISSION_TOOL, isHostExecPermission, canAlwaysAllow } from './toolNameUtils';
