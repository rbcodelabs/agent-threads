import type { KanbanGroupBy } from './types';

/** Agent Board group-by cycle: status -> folder -> project -> gallery -> status. */
const NEXT: Record<KanbanGroupBy, KanbanGroupBy> = {
  status: 'folder',
  folder: 'project',
  project: 'gallery',
  gallery: 'status',
};

const KNOWN = new Set<string>(Object.keys(NEXT));

/** Persisted settings may hold anything (older/newer builds): unknown values mean 'status'. */
export function normalizeKanbanGroupBy(value: unknown): KanbanGroupBy {
  return typeof value === 'string' && KNOWN.has(value) ? (value as KanbanGroupBy) : 'status';
}

export function nextKanbanGroupBy(value: unknown): KanbanGroupBy {
  return NEXT[normalizeKanbanGroupBy(value)];
}
