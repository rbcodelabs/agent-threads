/**
 * One short line telling the agent the current local time, sent with every
 * turn.
 *
 * Harness sessions are long-lived: a thread's session can span days, and the
 * system prompt (including Claude Code's own "today's date" line) is fixed at
 * session start. Without a per-turn clock the agent invents timestamps and
 * guesses the time zone. The Claude Agent SDK has no per-turn system-prompt
 * option (`append-system-prompt` applies at session start only), so each
 * harness adapter adds it to the user turn as its own content item (a text
 * block for Claude, an input item for Codex, a text part for OpenCode), after
 * the user's text and images. The user's text is never modified and the line
 * is not stored in the thread transcript.
 *
 * No dependencies; formatting uses the process's local zone.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `+HH:MM` / `-HH:MM` for a Date in the local zone. */
function utcOffset(now: Date): string {
  const minutesEast = -now.getTimezoneOffset();
  const sign = minutesEast >= 0 ? '+' : '-';
  const abs = Math.abs(minutesEast);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function resolvedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * e.g. `[Current local time: 2026-09-25T16:11-04:00 (Friday), time zone America/New_York]`
 * — an ISO 8601 local timestamp with its UTC offset (usable verbatim in
 * written timestamps), the weekday, and the IANA zone.
 */
export function formatCurrentTimeContext(now: Date = new Date(), timeZone: string = resolvedTimeZone()): string {
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `[Current local time: ${local}${utcOffset(now)} (${WEEKDAYS[now.getDay()]}), time zone ${timeZone}]`;
}

/**
 * Whether a turn should carry the time line. Slash-command turns are skipped:
 * the CLI recognises a command only when it is the whole prompt text, and an
 * extra item could be taken as command input.
 */
export function shouldAddCurrentTimeContext(text: string): boolean {
  return !text.trimStart().startsWith('/');
}
