import type { RunEvent, ScheduledItem } from './types';

export interface SchedulePersistenceAdapter {
  saveItem(item: ScheduledItem): Promise<void>;
  removeItem(id: string): Promise<void>;
  saveItems?(items: ScheduledItem[]): Promise<void>;
}

export interface ScheduleCompletion {
  completedAt: number;
  event: RunEvent;
  lastThreadId?: string;
  /** Loop whose target thread was gone: adopt the replacement thread as the new target. */
  targetThreadId?: string;
  lastSkipReason?: ScheduledItem['lastSkipReason'];
  lastGateExitCode?: number;
  lastGateError?: string;
}

export interface ScheduleClaim {
  claimed: boolean;
  item?: ScheduledItem;
}

function copyItem(item: ScheduledItem): ScheduledItem {
  return {
    ...item,
    schedule: { ...item.schedule },
    runHistory: item.runHistory?.map((event) => ({ ...event })),
    _scheduleRevision: item._scheduleRevision ?? 0,
  };
}

/**
 * Renderer-global scheduling authority. Plugin reloads can briefly leave two
 * Scheduler instances alive; keeping the mutation queue and item revisions on
 * globalThis makes those generations share one claim/finalization boundary.
 */
export class ScheduleCoordinator {
  private items = new Map<string, ScheduledItem>();
  private adapter?: SchedulePersistenceAdapter;
  private registrations = new Map<symbol, SchedulePersistenceAdapter>();
  private tail: Promise<void> = Promise.resolve();

  activate(
    items: ScheduledItem[],
    adapter: SchedulePersistenceAdapter,
    registration?: symbol,
  ): symbol {
    const token = registration && this.registrations.has(registration)
      ? registration
      : Symbol('schedule-coordinator-registration');
    if (this.registrations.size === 0) {
      this.items.clear();
    }
    this.registrations.set(token, adapter);
    this.adapter = adapter;
    const reconciled = new Map<string, ScheduledItem>();
    for (const item of items) {
      const incoming = copyItem(item);
      const existing = this.items.get(item.id);
      // A reload can activate while the prior generation is persisting a
      // claim. Do not replace a newer in-renderer revision with the stale
      // data.json snapshot the replacement loaded moments earlier.
      reconciled.set(
        item.id,
        existing && (existing._scheduleRevision ?? 0) > (incoming._scheduleRevision ?? 0)
          ? copyItem(existing)
          : incoming,
      );
    }
    this.items = reconciled;
    return token;
  }

  deactivate(registration: symbol): void {
    if (!this.registrations.delete(registration)) return;
    if (this.registrations.size === 0) {
      this.items.clear();
      this.adapter = undefined;
      return;
    }

    // Keep mutations on the newest still-active plugin generation's adapter.
    for (const adapter of this.registrations.values()) this.adapter = adapter;
  }

  read(id: string): ScheduledItem | undefined {
    const item = this.items.get(id);
    return item ? copyItem(item) : undefined;
  }

  adopt(item: ScheduledItem): Promise<ScheduledItem> {
    return this.enqueue(async () => {
      const adopted = copyItem(item);
      this.items.set(item.id, adopted);
      return copyItem(adopted);
    });
  }

  create(item: ScheduledItem): Promise<ScheduledItem> {
    return this.enqueue(async () => {
      const created = copyItem({ ...item, _scheduleRevision: Math.max(item._scheduleRevision ?? 0, 1) });
      this.items.set(created.id, created);
      await this.requireAdapter().saveItem(copyItem(created));
      return copyItem(created);
    });
  }

  update(id: string, updater: (current: ScheduledItem) => ScheduledItem): Promise<ScheduledItem> {
    return this.enqueue(async () => {
      const current = this.items.get(id);
      if (!current) throw new Error(`Scheduled item not found: ${id}`);
      const proposed = updater(copyItem(current));
      const updated = copyItem({
        ...proposed,
        id: current.id,
        _scheduleRevision: (current._scheduleRevision ?? 0) + 1,
        _scheduleClaimToken: current._scheduleClaimToken,
        _scheduleClaimDueAt: current._scheduleClaimDueAt,
        _scheduleClaimRevision: current._scheduleClaimRevision,
      });
      this.items.set(id, updated);
      await this.requireAdapter().saveItem(copyItem(updated));
      return copyItem(updated);
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.items.delete(id);
      await this.requireAdapter().removeItem(id);
    });
  }

  replaceAll(items: ScheduledItem[]): Promise<ScheduledItem[]> {
    return this.enqueue(async () => {
      const adapter = this.requireAdapter();
      if (!adapter.saveItems) throw new Error('Atomic schedule replacement is not available');
      const replacements = items.map(copyItem);
      await adapter.saveItems(replacements.map(copyItem));
      this.items = new Map(replacements.map(item => [item.id, item]));
      return replacements.map(copyItem);
    });
  }

  claim(
    id: string,
    dueAt: number,
    advanceNextRun: (current: ScheduledItem) => number,
    allowEarly = false,
  ): Promise<ScheduleClaim> {
    return this.enqueue(async () => {
      const current = this.items.get(id);
      if (
        !current ||
        !current.enabled ||
        current.nextRun !== dueAt ||
        (!allowEarly && Date.now() < dueAt) ||
        current._scheduleClaimToken
      ) {
        return { claimed: false, item: current ? copyItem(current) : undefined };
      }

      const revision = (current._scheduleRevision ?? 0) + 1;
      const token = crypto.randomUUID();
      const claimed = copyItem({
        ...current,
        nextRun: current.schedule.type === 'once' ? current.nextRun : advanceNextRun(current),
        _scheduleRevision: revision,
        _scheduleClaimToken: token,
        _scheduleClaimDueAt: dueAt,
        _scheduleClaimRevision: revision,
      });
      this.items.set(id, claimed);

      // The claim is durable before a gate, thread creation, or send begins.
      await this.requireAdapter().saveItem(copyItem(claimed));
      return { claimed: true, item: copyItem(claimed) };
    });
  }

  authorize(id: string, claimToken: string): Promise<ScheduleClaim> {
    return this.enqueue(async () => {
      const current = this.items.get(id);
      const authorized = !!current &&
        current.enabled &&
        current._scheduleClaimToken === claimToken &&
        current._scheduleClaimRevision === current._scheduleRevision;
      return { claimed: authorized, item: current ? copyItem(current) : undefined };
    });
  }

  abandon(id: string, claimToken: string): Promise<ScheduledItem | undefined> {
    return this.enqueue(async () => {
      const current = this.items.get(id);
      if (!current || current._scheduleClaimToken !== claimToken) {
        return current ? copyItem(current) : undefined;
      }
      const abandoned = copyItem({
        ...current,
        _scheduleRevision: (current._scheduleRevision ?? 0) + 1,
        _scheduleClaimToken: undefined,
        _scheduleClaimDueAt: undefined,
        _scheduleClaimRevision: undefined,
      });
      this.items.set(id, abandoned);
      await this.requireAdapter().saveItem(copyItem(abandoned));
      return copyItem(abandoned);
    });
  }

  finalize(id: string, claimToken: string, completion: ScheduleCompletion): Promise<ScheduledItem | undefined> {
    return this.enqueue(async () => {
      const current = this.items.get(id);
      if (!current || current._scheduleClaimToken !== claimToken) {
        return current ? copyItem(current) : undefined;
      }

      const claimWasNotSuperseded = current._scheduleClaimRevision === current._scheduleRevision;
      if (current.schedule.type === 'once' && current.enabled && claimWasNotSuperseded) {
        this.items.delete(id);
        await this.requireAdapter().removeItem(id);
        return undefined;
      }

      const history = [...(current.runHistory ?? []), completion.event];
      if (history.length > 50) history.splice(0, history.length - 50);
      const finalized = copyItem({
        ...current,
        lastRun: completion.completedAt,
        lastThreadId: completion.lastThreadId,
        ...(completion.targetThreadId ? { targetThreadId: completion.targetThreadId } : {}),
        lastSkipReason: completion.lastSkipReason,
        lastGateExitCode: completion.lastGateExitCode,
        lastGateError: completion.lastGateError,
        runHistory: history,
        _scheduleRevision: (current._scheduleRevision ?? 0) + 1,
        _scheduleClaimToken: undefined,
        _scheduleClaimDueAt: undefined,
        _scheduleClaimRevision: undefined,
      });
      this.items.set(id, finalized);
      await this.requireAdapter().saveItem(copyItem(finalized));
      return copyItem(finalized);
    });
  }

  private requireAdapter(): SchedulePersistenceAdapter {
    if (!this.adapter) throw new Error('Schedule coordinator is not active');
    return this.adapter;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const COORDINATOR_KEY = Symbol.for('claude-threads.schedule-coordinator');
type CoordinatorGlobal = typeof globalThis & { [COORDINATOR_KEY]?: ScheduleCoordinator };

export function sharedScheduleCoordinator(): ScheduleCoordinator {
  const state = globalThis as CoordinatorGlobal;
  return state[COORDINATOR_KEY] ??= new ScheduleCoordinator();
}
