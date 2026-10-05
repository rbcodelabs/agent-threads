/**
 * sandboxVmSweep.ts — startup sweep of orphaned per-thread sandbox containers.
 *
 * `ThreadManager.deleteThread()` tears a thread's container down, but a plugin
 * reload / Obsidian restart can lose that chance (and older versions never
 * did it), leaving `claude-threads-vm-<threadId>` containers whose writable
 * layers pile up on disk. This sweep removes the ones whose thread no longer
 * exists. It is deliberately conservative: anything ambiguous is skipped, and
 * only names that `containerNameForThread` could have produced are considered.
 */
import {
  buildRemoveArgs,
  containerNameForThread,
  VM_CONTAINER_NAME_PREFIX,
  VM_LIFECYCLE_TIMEOUT_MS,
  type VmCommandRunner,
} from './sandboxVm';

/** Shape `containerNameForThread` guarantees: prefix + sanitized id (lowercase alnum and dashes). */
const THREAD_CONTAINER_NAME = new RegExp(`^${VM_CONTAINER_NAME_PREFIX}[a-z0-9][a-z0-9-]*$`);

export interface OrphanSweepResult {
  /** Containers that were removed. */
  removed: string[];
  /** Orphans whose removal failed (left in place). */
  failed: string[];
  /** Why nothing was attempted, when the sweep bailed out early. */
  skippedReason?: string;
}

/** `container list --all --quiet` — one container ID (== name) per line, stopped containers included. */
export function buildContainerListArgs(): string[] {
  return ['list', '--all', '--quiet'];
}

/**
 * Pure: picks the containers to remove from a `list --quiet` listing. A
 * container qualifies only if its name matches the thread-container pattern
 * exactly AND it is not the container name of any live thread.
 */
export function selectOrphanedThreadContainers(listing: string, liveThreadIds: Iterable<string>): string[] {
  const liveNames = new Set<string>();
  for (const id of liveThreadIds) liveNames.add(containerNameForThread(id));
  const orphans: string[] = [];
  for (const line of listing.split('\n')) {
    const name = line.trim();
    if (!THREAD_CONTAINER_NAME.test(name)) continue;
    if (liveNames.has(name)) continue;
    orphans.push(name);
  }
  return orphans;
}

/**
 * Removes thread containers with no live thread. Never throws; every failure
 * mode degrades to "skip" and is reported in the result.
 */
export async function sweepOrphanedThreadContainers(deps: {
  run: VmCommandRunner;
  liveThreadIds: Iterable<string>;
  log?: (message: string) => void;
}): Promise<OrphanSweepResult> {
  const log = deps.log ?? (() => undefined);
  const result: OrphanSweepResult = { removed: [], failed: [] };
  try {
    const liveThreadIds = [...deps.liveThreadIds];
    // An empty thread set more likely means state failed to load than that
    // every thread was archived; never risk removing every container on that.
    if (liveThreadIds.length === 0) {
      result.skippedReason = 'no live threads loaded';
      return result;
    }

    const listing = await deps.run(buildContainerListArgs(), { timeoutMs: VM_LIFECYCLE_TIMEOUT_MS });
    if (listing.exitCode !== 0) {
      // Runtime missing/stopped is the common case on machines without it; not an error.
      result.skippedReason = `container list exited ${listing.exitCode}`;
      return result;
    }

    for (const name of selectOrphanedThreadContainers(listing.stdout, liveThreadIds)) {
      try {
        const removed = await deps.run(buildRemoveArgs({ containerName: name, force: true }), {
          timeoutMs: VM_LIFECYCLE_TIMEOUT_MS,
        });
        if (removed.exitCode === 0) result.removed.push(name);
        else result.failed.push(name);
      } catch {
        result.failed.push(name);
      }
    }
    if (result.removed.length || result.failed.length) {
      log(`Orphan sandbox sweep: removed ${result.removed.length}, failed ${result.failed.length}`);
    }
  } catch (err) {
    result.skippedReason = err instanceof Error ? err.message : String(err);
  }
  return result;
}
