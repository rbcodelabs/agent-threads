import type { Thread } from './types';

export type AgentsGroupBy = 'project' | 'status' | 'project-status';
export type AgentsGroupingDimension = 'project' | 'status';

export function normalizeAgentsGroupBy(value: unknown): AgentsGroupBy {
  return value === 'project' || value === 'status' || value === 'project-status'
    ? value
    : 'project-status';
}

export function toggleAgentsGrouping(
  currentValue: unknown,
  dimension: AgentsGroupingDimension,
): AgentsGroupBy {
  const current = normalizeAgentsGroupBy(currentValue);
  const project = current !== 'status';
  const status = current !== 'project';
  const nextProject = dimension === 'project' ? !project : project;
  const nextStatus = dimension === 'status' ? !status : status;
  if (!nextProject && !nextStatus) return current;
  if (nextProject && nextStatus) return 'project-status';
  return nextProject ? 'project' : 'status';
}

export interface DashboardProjectGroup {
  key: string;
  label: string;
  threads: Thread[];
}

export function groupDashboardThreads(
  threads: Thread[],
  resolveGroup: (thread: Thread) => Omit<DashboardProjectGroup, 'threads'>,
): DashboardProjectGroup[] {
  const groups = new Map<string, DashboardProjectGroup>();
  for (const thread of threads) {
    const identity = resolveGroup(thread);
    const current = groups.get(identity.key);
    if (current) current.threads.push(thread);
    else groups.set(identity.key, { ...identity, threads: [thread] });
  }
  return Array.from(groups.values()).map(group => ({
    ...group,
    threads: group.threads.sort((a, b) => b.updatedAt - a.updatedAt),
  })).sort((a, b) => {
    if (a.key === 'unassigned') return 1;
    if (b.key === 'unassigned') return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
  });
}

/** Archived threads matching the (already lower-cased) search query, newest first. */
export function filterArchivedThreads(threads: Thread[], liveIds: ReadonlySet<string>, query: string): Thread[] {
  return threads
    .filter(thread => thread.status === 'archived' && !liveIds.has(thread.id))
    .filter(thread => !query
      || thread.title.toLowerCase().includes(query)
      || (thread.summary ?? '').toLowerCase().includes(query)
      || (thread.recap ?? '').toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
