/** Pure error-message helpers. Mobile-safe: no imports. */

/**
 * Splits an error message into a one-line headline and an optional stack
 * trace, so the UI can show a clean, short error card with the noisy
 * technical detail tucked behind a disclosure instead of dumping the whole
 * thing into a `<pre>` block. Errors constructed with a trailing
 * `\n\nStack: ...` suffix (see ClaudeSession.ts) are split there; anything
 * else is returned as-is with no stack.
 */
export function splitErrorMessage(message: string): { headline: string; stack?: string } {
  const idx = message.indexOf('\n\nStack:');
  if (idx === -1) return { headline: message };
  return { headline: message.slice(0, idx), stack: message.slice(idx + 2) }; // keep "Stack: ..." in the details
}
