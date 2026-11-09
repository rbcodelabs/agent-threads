/**
 * dock-input-history.test.ts
 *
 * K2 P5: the Ask field's ArrowUp / ArrowDown recall. Pure: no DOM, no obsidian.
 */
import { describe, it, expect } from 'vitest';
import { InputHistory, HISTORY_LIMIT } from '../../src/dockInputHistory';

const filled = (...texts: string[]): InputHistory => {
  const h = new InputHistory();
  texts.forEach((t) => h.push(t));
  return h;
};

describe('InputHistory', () => {
  it('previous() on an empty history recalls nothing and does not start browsing', () => {
    const h = new InputHistory();
    expect(h.previous('')).toBeUndefined();
    expect(h.browsing).toBe(false);
  });

  it('repeated previous() walks back from the newest and stops at the oldest', () => {
    const h = filled('one', 'two', 'three');
    expect(h.previous('')).toBe('three');
    expect(h.previous('three')).toBe('two');
    expect(h.previous('two')).toBe('one');
    expect(h.previous('one')).toBe('one'); // already at the oldest: stays
    expect(h.browsing).toBe(true);
  });

  it('next() walks forward and finally restores the draft that was being typed', () => {
    const h = filled('one', 'two');
    expect(h.previous('half typed')).toBe('two');
    expect(h.previous('two')).toBe('one');
    expect(h.next()).toBe('two');
    expect(h.next()).toBe('half typed');
    expect(h.browsing).toBe(false);
    expect(h.next()).toBeUndefined(); // not browsing: nothing to do
  });

  it('an empty draft is restored as the empty string (not undefined)', () => {
    const h = filled('one');
    h.previous('');
    expect(h.next()).toBe('');
  });

  it('keeps the last 20 messages, oldest dropped', () => {
    expect(HISTORY_LIMIT).toBe(20);
    const h = new InputHistory();
    for (let i = 1; i <= 25; i++) h.push(`m${i}`);
    expect(h.entries).toHaveLength(20);
    expect(h.entries[0]).toBe('m6');
    expect(h.entries[19]).toBe('m25');
  });

  it('drops CONSECUTIVE duplicates only, ignores blanks, stores trimmed text', () => {
    const h = new InputHistory();
    h.push('a'); h.push('a'); h.push('  a  '); h.push('b'); h.push('a'); h.push('   '); h.push('');
    expect(h.entries).toEqual(['a', 'b', 'a']);
  });

  it('a new push ends browsing (the next ArrowUp starts again from the newest)', () => {
    const h = filled('one', 'two');
    h.previous('');
    h.previous('two');
    h.push('three');
    expect(h.browsing).toBe(false);
    expect(h.previous('')).toBe('three');
  });

  it('reset() leaves browsing without changing the entries', () => {
    const h = filled('one');
    h.previous('x');
    h.reset();
    expect(h.browsing).toBe(false);
    expect(h.entries).toEqual(['one']);
    expect(h.previous('y')).toBe('one');
    expect(h.next()).toBe('y');
  });

  it('shown is the recalled entry while browsing, undefined otherwise', () => {
    const h = filled('one', 'two');
    expect(h.shown).toBeUndefined();
    h.previous('');
    expect(h.shown).toBe('two');
    h.next();
    expect(h.shown).toBeUndefined();
  });

  it('clear() forgets everything (secrets typed into a message do not outlive the dock)', () => {
    const h = filled('token abc', 'two');
    h.previous('x');
    h.clear();
    expect(h.entries).toEqual([]);
    expect(h.browsing).toBe(false);
    expect(h.previous('')).toBeUndefined();
  });
});
