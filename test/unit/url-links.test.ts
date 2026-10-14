import { describe, it, expect } from 'vitest';
import { splitTextWithUrls, extractUrls, urlChipLabel } from '../../src/urlLinks';

describe('urlLinks', () => {
  it('splits text and restores input', () => {
    const t = 'see https://a.com/x?y=1, then (https://b.org/p_(1)).';
    const segs = splitTextWithUrls(t);
    expect(segs.map(s => s.text).join('')).toBe(t);
    expect(segs.filter(s => s.url).map(s => s.url)).toEqual(['https://a.com/x?y=1', 'https://b.org/p_(1)']);
  });
  it('trims sentence punctuation', () => {
    expect(extractUrls('go to http://x.dev/a.')).toEqual(['http://x.dev/a']);
  });
  it('dedupes and ignores bare schemes', () => {
    expect(extractUrls('https:// https://a.io https://a.io')).toEqual(['https://a.io']);
  });
  it('labels', () => {
    expect(urlChipLabel('https://www.github.com/a/b/')).toBe('github.com/a/b');
  });
});
