/**
 * Pure filter / sort / keyboard logic for the searchable Project picker
 * (`ProjectPicker.ts`). No Obsidian or DOM dependencies so it is unit-testable.
 */

export type ProjectSortMode = 'recent' | 'alphabetical';

export const DEFAULT_PROJECT_SORT: ProjectSortMode = 'recent';

export function normalizeProjectSort(value: unknown): ProjectSortMode {
  return value === 'alphabetical' ? 'alphabetical' : DEFAULT_PROJECT_SORT;
}

export interface PickerProject {
  id: string;
  name: string;
  description?: string;
  vaultFolder?: string;
  createdAt?: number;
}

/**
 * Last-used time per project: the newest of the latest thread activity in that
 * project and any explicit selection recorded by the picker itself.
 */
export function computeProjectLastUsed(
  threads: ReadonlyArray<{ projectId?: string; updatedAt: number }>,
  recorded: Readonly<Record<string, number>> = {},
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, at] of Object.entries(recorded)) {
    if (Number.isFinite(at)) out.set(id, at);
  }
  for (const thread of threads) {
    if (!thread.projectId) continue;
    const at = Number.isFinite(thread.updatedAt) ? thread.updatedAt : 0;
    if (at > (out.get(thread.projectId) ?? -Infinity)) out.set(thread.projectId, at);
  }
  return out;
}

const byName = (a: PickerProject, b: PickerProject): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id);

/** Returns a new array; never mutates the input. Never-used projects sort after used ones, by name. */
export function sortProjects<T extends PickerProject>(
  projects: readonly T[],
  mode: ProjectSortMode,
  lastUsed: ReadonlyMap<string, number> = new Map(),
): T[] {
  const list = [...projects];
  if (mode === 'alphabetical') return list.sort(byName);
  return list.sort((a, b) => {
    const diff = (lastUsed.get(b.id) ?? -Infinity) - (lastUsed.get(a.id) ?? -Infinity);
    // -Infinity - -Infinity is NaN; treat two never-used projects as a tie.
    if (diff !== 0 && !Number.isNaN(diff)) return diff > 0 ? 1 : -1;
    return byName(a, b);
  });
}

/**
 * Case-insensitive filter. Every whitespace-separated term must appear in the
 * name or vault folder. Name-prefix matches are promoted ahead of other matches
 * (stable, so the chosen sort order still decides ties).
 */
export function filterProjects<T extends PickerProject>(projects: readonly T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...projects];
  const matches = projects.filter((project) => {
    const haystack = `${project.name}\n${project.vaultFolder ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const joined = terms.join(' ');
  const prefix = matches.filter((project) => project.name.toLowerCase().startsWith(joined));
  return [...prefix, ...matches.filter((project) => !prefix.includes(project))];
}

export type PickerEntry =
  | { kind: 'none' }
  | { kind: 'project'; project: PickerProject }
  | { kind: 'new' };

export interface PickerEntryInput {
  projects: readonly PickerProject[];
  query: string;
  mode: ProjectSortMode;
  lastUsed?: ReadonlyMap<string, number>;
  /** Offer a "No Project" row (default true). */
  allowNone?: boolean;
}

const NONE_TERMS = ['no project', 'none', 'unassigned'];

/**
 * The rows the picker shows, in order: "No Project" (while it matches the
 * filter), the filtered + sorted projects, and always "New Project…" last.
 */
export function buildPickerEntries(input: PickerEntryInput): PickerEntry[] {
  const entries: PickerEntry[] = [];
  const q = input.query.trim().toLowerCase();
  if (input.allowNone !== false && (q === '' || NONE_TERMS.some((term) => term.includes(q)))) {
    entries.push({ kind: 'none' });
  }
  const sorted = sortProjects(input.projects, input.mode, input.lastUsed);
  for (const project of filterProjects(sorted, input.query)) entries.push({ kind: 'project', project });
  entries.push({ kind: 'new' });
  return entries;
}

/** Wrapping arrow-key movement. `current` of -1 means nothing is highlighted yet. */
export function moveHighlight(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** Index to highlight when the list is (re)built: the selected row if shown, else the first real match. */
export function initialHighlight(entries: readonly PickerEntry[], selectedId: string | null, query: string): number {
  if (query.trim() === '') {
    const selected = entries.findIndex((entry) =>
      selectedId === null ? entry.kind === 'none' : entry.kind === 'project' && entry.project.id === selectedId);
    if (selected >= 0) return selected;
  }
  const firstProject = entries.findIndex((entry) => entry.kind === 'project');
  if (query.trim() !== '' && firstProject >= 0) return firstProject;
  return entries.length > 0 ? 0 : -1;
}
