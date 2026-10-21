import { describe, expect, it } from 'vitest';
import { deepLinkScheme, detectHostName } from '../../src/hostEnvironment';

describe('host detection', () => {
  it('detects Geode through the window.geode compatibility marker', () => {
    expect(detectHostName({ geode: {} })).toBe('Geode');
  });

  it('defaults to Obsidian when the Geode marker is absent', () => {
    expect(detectHostName({})).toBe('Obsidian');
  });

  it('mints geode:// pairing links in Geode and obsidian:// in Obsidian', () => {
    expect(deepLinkScheme({ geode: {} })).toBe('geode');
    expect(deepLinkScheme({})).toBe('obsidian');
  });
});
