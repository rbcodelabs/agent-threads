import { describe, it, expect } from 'vitest';
import { nextKanbanGroupBy, normalizeKanbanGroupBy } from '../../src/kanbanGroupBy';
import { DEFAULT_SETTINGS } from '../../src/types';

describe('kanbanGroupBy', () => {
  it('cycles status -> folder -> project -> gallery -> status', () => {
    const seen = ['status'];
    let cur: unknown = 'status';
    for (let i = 0; i < 4; i++) { cur = nextKanbanGroupBy(cur); seen.push(cur as string); }
    expect(seen).toEqual(['status', 'folder', 'project', 'gallery', 'status']);
  });
  it('coerces unknown or missing values to status', () => {
    for (const bad of [undefined, null, 'grid', 42, {}, '']) expect(normalizeKanbanGroupBy(bad)).toBe('status');
    expect(nextKanbanGroupBy('grid')).toBe('folder');
  });
  it('keeps gallery as a valid stored value', () => {
    expect(normalizeKanbanGroupBy('gallery')).toBe('gallery');
  });
  it('defaults to status', () => {
    expect(DEFAULT_SETTINGS.kanbanGroupBy).toBe('status');
  });
});
