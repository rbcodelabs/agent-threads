/**
 * Pure parsing for the output of `claude setup-token` (a TUI), shared by every place that drives it: the managed
 * local container (`claudeContainerAuthCli.ts`) and a remote daemon (`daemon/signin.ts`). No Node, DOM or Obsidian
 * dependency, so it stays inside the daemon's core closure.
 */

/** Strips OSC (hyperlinks, titles), CSI (colors, cursor moves), other ESC sequences and CRs so pattern matching sees plain text. */
export function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

/** Long-lived Anthropic OAuth tokens are documented as `sk-ant-oat...`. Picks the LAST match so an earlier, unrelated fragment can never win over the real token printed at the end. */
export const TOKEN_PREFIX_PATTERN = /sk-ant-oat[0-9]*-[A-Za-z0-9_-]+/g;

/**
 * Extracts the setup-token output's long-lived token. Prefers the documented
 * `sk-ant-oat...` prefix; falls back to the last printed line ONLY if it is
 * shaped like a bare token (no whitespace, no punctuation besides `_`/`-`,
 * long enough not to be a stray short word) - never falls back to guessing
 * from an arbitrary line, which would silently hand back garbage.
 */
export function extractToken(output: string): string | undefined {
  const prefixed = output.match(TOKEN_PREFIX_PATTERN);
  if (prefixed && prefixed.length > 0) return prefixed[prefixed.length - 1];
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine && /^[A-Za-z0-9_-]{20,}$/.test(lastLine)) return lastLine;
  return undefined;
}

/** Content-match redaction (never positional). */
export function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join('<redacted>');
}

/**
 * The first sign-in URL in raw (un-stripped) TUI output.
 *
 * Deliberately NOT \S+ - verified live against the real CLI's TUI: it renders the URL as an OSC-8 hyperlink
 * immediately followed by a second, dimmer, width-truncated copy for display, with only control bytes (BEL `\x07`
 * closing the OSC-8 escape, ESC `\x1b` starting the next SGR code) between them, no whitespace. `\S+` treats those
 * control bytes as non-whitespace and happily spans straight through into the second copy, producing one garbled
 * string with raw escape bytes baked in - exactly the string that would go into the "Browser didn't open?" link's
 * `href`. Stopping at the first control byte (0x00-0x1F, 0x7F) keeps the real URL and nothing else.
 */
export function extractSignInUrl(rawOutput: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  return rawOutput.match(/https:\/\/[^\s\x00-\x1f\x7f]+/)?.[0];
}

/**
 * The CLI's server-side rejection of a code (`OAuth error: ...`), cleaned for display, or undefined. The TUI moves
 * the cursor instead of printing newlines, so its "Press Enter to retry." hint lands on the same line; it means
 * nothing in our UI.
 */
export function extractOAuthError(strippedOutput: string): string | undefined {
  const rejected = strippedOutput.match(/OAuth error:[^\n]*/);
  if (!rejected) return undefined;
  return rejected[0].replace(/\s*Press\s+Enter\s+to\s+retry\.?/i, '').trim();
}
