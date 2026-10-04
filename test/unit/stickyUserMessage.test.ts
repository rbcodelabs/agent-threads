import { describe, it, expect } from 'vitest';
import { pickStickyUserIndex, truncateStickyText } from '../../src/stickyUserMessage';

describe('pickStickyUserIndex', () => {
  const bottoms = [100, 400, 900];
  it('returns -1 with no user messages', () => {
    expect(pickStickyUserIndex(0, () => 0, 0)).toBe(-1);
  });
  it('returns -1 when the first user message is still visible', () => {
    expect(pickStickyUserIndex(3, i => bottoms[i], 50)).toBe(-1);
  });
  it('picks the last message scrolled above the viewport', () => {
    expect(pickStickyUserIndex(3, i => bottoms[i], 500)).toBe(1);
    expect(pickStickyUserIndex(3, i => bottoms[i], 100)).toBe(0);
    expect(pickStickyUserIndex(3, i => bottoms[i], 5000)).toBe(2);
  });
  it('stops scanning at the first hit from the end', () => {
    const seen: number[] = [];
    pickStickyUserIndex(3, i => { seen.push(i); return bottoms[i]; }, 500);
    expect(seen).toEqual([2, 1]);
  });
});

describe('pickStickyUserIndex with getTop (straddling message)', () => {
  const tops = [0, 300, 800];
  const bottoms = [100, 400, 900];
  const pick = (vt: number) => pickStickyUserIndex(3, i => bottoms[i], vt, i => tops[i]);
  it('hides when a later message straddles the top edge', () => {
    expect(pick(350)).toBe(-1);
    expect(pick(300)).toBe(-1);
    expect(pick(297)).toBe(0); // beyond the 2px tolerance: msg 1 is still below the edge
  });
  it('tolerates sub-pixel rest positions', () => {
    expect(pick(298.5)).toBe(-1);
  });
  it('still shows the prompt of the turn being read', () => {
    expect(pick(500)).toBe(1);
    expect(pick(100)).toBe(0);
  });
});

describe('truncateStickyText', () => {
  it('collapses whitespace', () => {
    expect(truncateStickyText('  a\n\n b\t c ')).toBe('a b c');
  });
  it('returns empty for blank input', () => {
    expect(truncateStickyText('  \n ')).toBe('');
  });
  it('truncates with an ellipsis at max length', () => {
    const out = truncateStickyText('x'.repeat(50), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });
  it('leaves short text untouched', () => {
    expect(truncateStickyText('hello', 10)).toBe('hello');
  });
});
