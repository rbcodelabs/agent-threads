/**
 * Fixtures for the browser session card (docs/mockups/browser-session-card).
 *
 * Screenshots are the SVG artwork from the approved mockup, embedded as
 * base64 `toolResultImages` exactly the way a real browser_screenshot result
 * lands on a message. Timestamps are pinned: never use Date.now() here.
 */
import type { ChatMessage, ToolCallRecord } from '../../src/types';
// esbuild `text` loader (see esbuild.mjs): the SVG source as a string.
import pricingSvg from '../../docs/mockups/browser-session-card/assets/shot-pricing.svg';

const BASE = new Date('2026-01-15T09:50:00Z').getTime();
export const PRICING_IMAGE = { mediaType: 'image/svg+xml', data: btoa(pricingSvg) };

const NAV = 'mcp__claude_threads__browser_navigate';
const B = (short: string) => `mcp__claude_threads__browser_${short}`;

function tool(
  n: number,
  name: string,
  summary: string,
  extra: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return { name, summary, toolUseId: `bt-${n}`, timestamp: BASE + n * 1500, status: 'success', durationMs: 400, ...extra };
}

const PRICING_URL = 'https://acme.io/pricing';

const userMsg = (id: string, text: string): ChatMessage => ({ id, role: 'user', content: text, timestamp: BASE });
const searchMsg: ChatMessage = {
  id: 'bs-search',
  role: 'assistant',
  content: '',
  timestamp: BASE + 500,
  toolCalls: [{ name: 'WebSearch', summary: 'acme.io pricing startup plan', toolUseId: 'bt-0', timestamp: BASE + 500, status: 'success', durationMs: 900 }],
};

/** navigate + click in one tool-only message, read + screenshot in the next (a session across messages). */
function sessionMessages(prefix: string, opts: { close?: boolean; failClick?: boolean; withScreenshot?: boolean } = {}): ChatMessage[] {
  const withShot = opts.withScreenshot !== false;
  const a: ToolCallRecord[] = [
    tool(1, NAV, PRICING_URL, { browser: { pageUrl: PRICING_URL, pageTitle: 'Pricing' }, durationMs: 1200 }),
    opts.failClick
      ? tool(2, B('click'), 'e5', { status: 'error', durationMs: 30_000, browser: { error: 'The page did not finish loading: request timed out after 30 seconds.' } })
      : tool(2, B('click'), 'e5', { durationMs: 900, browser: { pageUrl: PRICING_URL } }),
  ];
  const b: ToolCallRecord[] = opts.failClick ? [] : [
    tool(3, B('read_text'), '', { durationMs: 400, browser: { pageUrl: PRICING_URL, pageTitle: 'Pricing' } }),
    ...(withShot ? [tool(4, B('screenshot'), '', { durationMs: 300 })] : []),
    ...(opts.close ? [tool(5, B('close'), '', { durationMs: 100 })] : []),
  ];
  const messages: ChatMessage[] = [
    { id: `${prefix}-a`, role: 'assistant', content: '', timestamp: BASE + 2000, toolCalls: a },
  ];
  if (b.length > 0) messages.push({ id: `${prefix}-b`, role: 'assistant', content: '', timestamp: BASE + 4000, toolCalls: b });
  return messages;
}

const finalAnswer = (id: string, withImage: boolean): ChatMessage => ({
  id,
  role: 'assistant',
  content: 'Yes — the Startup plan is still listed, now at **$29/mo** (it was $24).',
  timestamp: BASE + 9000,
  // ThreadManager attaches a tool result's image to the NEXT assistant message,
  // which here is the final prose message: the card must claim it from there.
  ...(withImage ? { toolResultImages: [PRICING_IMAGE] } : {}),
  cost: 0.0142,
});

const USER_Q = 'Check acme.io/pricing — is the Startup plan still there?';

/**
 * Message sets for the opt-in `window.__showBrowserFixture(kind)` harness hook,
 * which loads one onto the (otherwise empty) 'thread-new' thread — the same
 * pattern as __showInlineContent — so the shared thread list, and every
 * baseline that renders it, stays exactly as it was.
 */
export type BrowserFixtureKind = 'finished' | 'ended' | 'error' | 'live' | 'handoff';

export const browserFixtureMessages: Record<BrowserFixtureKind, ChatMessage[]> = {
  finished: [userMsg('bf-u', USER_Q), searchMsg, ...sessionMessages('bf'), finalAnswer('bf-z', true)],
  ended: [userMsg('be-u', USER_Q), ...sessionMessages('be', { close: true }), finalAnswer('be-z', true)],
  error: [userMsg('br-u', USER_Q), ...sessionMessages('br', { failClick: true })],
  // Live states are driven with window.__emitEvent on top of just the question.
  live: [userMsg('bl-u', USER_Q)],
  // A running session that reaches a sign-in wall. The screenshot is on the same
  // merged row here (contrast with `finished`, where it lands on the final message).
  handoff: [
    userMsg('bh-u', USER_Q),
    { id: 'bh-a', role: 'assistant', content: '', timestamp: BASE + 2000, toolCalls: [
      tool(1, NAV, PRICING_URL, { browser: { pageUrl: PRICING_URL }, durationMs: 1200 }),
      tool(2, B('click'), 'e4', { durationMs: 900, browser: { pageUrl: PRICING_URL } }),
      tool(3, B('screenshot'), '', { durationMs: 300 }),
    ], toolResultImages: [PRICING_IMAGE] },
  ],
};
