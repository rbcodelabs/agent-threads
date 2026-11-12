import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractToken, renderTerminal, stripAnsi, TOKEN_PREFIX_PATTERN } from '../../src/setupTokenParse';

describe('renderTerminal', () => {
  it('recovers a character the TUI skipped repainting (cursor-forward over an unchanged cell)', () => {
    // Previous frame had an "o" in that cell; the repaint moves the cursor over it instead of resending it.
    const raw = '\x1b[2Bxxxxxxxo\r' + '\x1b[1Csk-ant-\x1b[1C' + 'at01-AbC_d-e\x1b[K';
    const stripped = stripAnsi(raw);
    expect(stripped.match(TOKEN_PREFIX_PATTERN)).toBeNull();
    expect(extractToken(renderTerminal(raw))).toBe('sk-ant-oat01-AbC_d-e');
  });
  it('handles absolute columns, erase, OSC, charset and one-char escapes', () => {
    const raw = '\x1b]0;title\x07\x1b(B\x1b7Store\x1b[8Gthis\x1b8\x1b[2K\x1b[1;1Hhello\x1b[3Gey\x1b[K';
    expect(renderTerminal(raw)).toBe('heey');
  });
  it('reads a real captured setup-token run when present (optional fixture)', () => {
    const f = '/tmp/st.raw';
    if (!existsSync(f)) return;
    const token = extractToken(renderTerminal(readFileSync(f, 'latin1')));
    expect(token).toMatch(TOKEN_PREFIX_PATTERN);
  });
});
