import type { ScheduledItem } from './types';

/**
 * Orchestrator wake-up and heartbeat scheduling moved to the Threads Orchestrator plugin. Older
 * versions of core created hourly `isOrchestratorHeartbeat` cron items; drop any that remain so they
 * do not keep firing. Returns the same array when there is nothing to remove.
 */
export function stripLegacyOrchestratorHeartbeats(items: ScheduledItem[]): { items: ScheduledItem[]; removed: number } {
  const kept = items.filter(item => !item.isOrchestratorHeartbeat);
  return kept.length === items.length ? { items, removed: 0 } : { items: kept, removed: items.length - kept.length };
}
