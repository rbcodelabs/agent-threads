/**
 * Recovery helpers for a failed `claude --resume`.
 *
 * When the persisted session id can't be resumed (transcript missing after a
 * restart, moved config dir/HOME, changed project dir), the CLI exits with
 * code 1 before emitting a single message. The SDK surfaces that as a generic
 * "Claude Code process exited with code 1" and drops stderr, so the user just
 * sees an opaque crash every time they reopen the thread.
 */

/** Max stderr characters retained per session for error enrichment. */
export const MAX_STDERR_TAIL_CHARS = 4000;

/** Appends a chunk to a bounded stderr tail buffer. */
export function appendStderrTail(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length > MAX_STDERR_TAIL_CHARS ? next.slice(next.length - MAX_STDERR_TAIL_CHARS) : next;
}

/**
 * True when an error looks like a failed resume: the process died with exit
 * code 1 (or explicitly reported a missing conversation) before producing any
 * output, on a session that was launched with a resume id.
 */
export function isResumeFailure(
  errorMessage: string,
  stderrTail: string,
  ctx: { resumed: boolean; sawMessage: boolean },
): boolean {
  if (!ctx.resumed || ctx.sawMessage) return false;
  if (/no conversation found/i.test(stderrTail) || /no conversation found/i.test(errorMessage)) return true;
  return /process exited with code 1\b/i.test(errorMessage);
}

/** Appends the captured stderr tail to an error message, when there is one. */
export function withStderr(message: string, stderrTail: string): string {
  const trimmed = stderrTail.trim();
  return trimmed ? `${message}\n\nClaude Code stderr:\n${trimmed}` : message;
}
