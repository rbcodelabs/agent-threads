import { describe, expect, it } from 'vitest';
import { buildComposerContextLabel } from '../../src/dashboardUtils';

describe('buildComposerContextLabel', () => {
  it('combines an assigned project with the working-directory basename', () => {
    expect(buildComposerContextLabel('Compass', '/Users/me/projects/obsidian-claude-threads'))
      .toBe('Compass · obsidian-claude-threads');
  });

  it('shows only the working-directory basename without a project', () => {
    expect(buildComposerContextLabel(undefined, '/Users/me/projects/obsidian-claude-threads'))
      .toBe('obsidian-claude-threads');
  });

  it('does not repeat equivalent project and folder names', () => {
    expect(buildComposerContextLabel('Compass', '/Users/me/projects/compass'))
      .toBe('Compass');
  });

  it('handles a trailing path separator', () => {
    expect(buildComposerContextLabel('Compass', '/Users/me/projects/compass/'))
      .toBe('Compass');
  });
});
