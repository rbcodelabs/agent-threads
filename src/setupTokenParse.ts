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

/**
 * Renders raw TUI output the way a terminal would show it, so text the TUI never re-sent is still read.
 *
 * Why stripping escapes is not enough: the CLI's renderer repaints only what changed, skipping unchanged cells with
 * cursor moves (`ESC[1C`, `ESC[nG`). A character that happened to equal what the previous frame had in that cell is
 * simply not sent, so the byte stream reads `sk-ant-at01-...` while the screen shows `sk-ant-oat01-...`. Replaying the
 * cursor moves over a grid recovers the screen. Handles printable text, CR/LF/BS, CSI A/B/C/D/G/H/f/d/K/J (anything
 * else, such as colors and modes, is ignored), OSC and charset escapes. No scrolling: rows only grow, which keeps
 * relative moves consistent. Returns the non-empty trailing-trimmed rows joined by newlines.
 */
export function renderTerminal(raw: string, cols = 500): string {
  const rows: string[][] = [[]];
  let r = 0;
  let c = 0;
  const row = (i: number): string[] => { while (rows.length <= i) rows.push([]); return rows[i]!; };
  const put = (ch: string): void => {
    if (c >= cols) { r += 1; c = 0; }
    const line = row(r);
    while (line.length < c) line.push(' ');
    line[c] = ch;
    c += 1;
  };
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const ch = raw[i]!;
    if (ch === '\x1b') {
      const next = raw[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < n && /[0-?]/.test(raw[j]!)) j++;
        const params = raw.slice(i + 2, j);
        while (j < n && /[ -/]/.test(raw[j]!)) j++;
        const final = raw[j];
        i = j;
        if (final === undefined || params.startsWith('?') || params.startsWith('>')) continue;
        const nums = params.split(';').map((p) => (p === '' ? NaN : Number(p)));
        const a = Number.isFinite(nums[0]!) ? nums[0]! : undefined;
        switch (final) {
          case 'A': r = Math.max(0, r - (a || 1)); break;
          case 'B': r += a || 1; break;
          case 'C': c += a || 1; break;
          case 'D': c = Math.max(0, c - (a || 1)); break;
          case 'G': c = Math.max(0, (a || 1) - 1); break;
          case 'd': r = Math.max(0, (a || 1) - 1); break;
          case 'H': case 'f': r = Math.max(0, (a || 1) - 1); c = Math.max(0, ((Number.isFinite(nums[1]!) ? nums[1]! : 1) || 1) - 1); break;
          case 'K': {
            const line = row(r);
            if (!a) line.length = Math.min(line.length, c);
            else if (a === 1) for (let k = 0; k <= c && k < line.length; k++) line[k] = ' ';
            else line.length = 0;
            break;
          }
          case 'J':
            if (a === 2 || a === 3) { rows.length = 1; rows[0] = []; r = 0; c = 0; }
            else if (!a) { row(r).length = Math.min(row(r).length, c); rows.length = r + 1; }
            break;
          default: break;
        }
        continue;
      }
      if (next === ']') {
        let j = i + 2;
        while (j < n && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++;
        i = raw[j] === '\x1b' ? j + 1 : j;
        continue;
      }
      if (next !== undefined && '()*+'.includes(next)) { i += 2; continue; }
      i += 1; // ESC 7, ESC 8, ESC =, ... : one-character escapes
      continue;
    }
    if (ch === '\r') { c = 0; continue; }
    if (ch === '\n') { r += 1; c = 0; continue; }
    if (ch === '\b') { c = Math.max(0, c - 1); continue; }
    if (ch < ' ' || ch === '\x7f') continue;
    put(ch);
  }
  return rows.map((line) => line.join('').replace(/\s+$/, '')).filter((l) => l.length > 0).join('\n');
}
