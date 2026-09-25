import { agentHarnessLabel, type AgentHarness } from './types';
import type { ScheduledItem, Thread } from './types';

export interface ScheduledWorkGroups {
  recurring: ScheduledItem[];
  threadSpecific: ScheduledItem[];
}

export interface ScheduledExecutionDisplay {
  summary: string;
  detail: string;
  missingTarget: boolean;
}

export interface NextOccurrenceDisplay {
  label: 'Next run' | 'Next check';
  relative: string;
  exact: string;
  overdue: boolean;
}

/** Builds the dashboard's user-visible groups without exposing system heartbeats. */
export function classifyScheduledItems(items: ScheduledItem[]): ScheduledWorkGroups {
  const visible = items.filter((item) => !item.isOrchestratorHeartbeat);
  const sorted = (group: ScheduledItem[]) => group.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (!a.enabled) return 0;
    return (a.nextRun ?? Number.POSITIVE_INFINITY) - (b.nextRun ?? Number.POSITIVE_INFINITY);
  });

  return {
    recurring: sorted(visible.filter((item) => !item.targetThreadId && item.origin !== 'wakeup')),
    threadSpecific: sorted(visible.filter((item) => !!item.targetThreadId || item.origin === 'wakeup')),
  };
}

function harnessLabel(harness: AgentHarness): string {
  return agentHarnessLabel(harness);
}

function modelLabel(model: string | undefined): string {
  return model || 'CLI default model';
}

export function describeScheduledExecution(
  item: ScheduledItem,
  globalHarness: AgentHarness,
  globalModel: string,
  targetThread?: Pick<Thread, 'agentHarness' | 'model'>,
): ScheduledExecutionDisplay {
  const globalHarnessName = harnessLabel(globalHarness);
  const globalModelName = modelLabel(globalModel);
  const globalModelPhrase = globalModel ? `${globalModelName} model` : 'the CLI default model';

  if (!item.targetThreadId) {
    return {
      summary: `New thread · ${globalHarnessName} · ${globalModelName}`,
      detail: `Creates a new thread using the current global ${globalHarnessName} harness and ${globalModelPhrase} at fire time.`,
      missingTarget: false,
    };
  }

  if (!targetThread) {
    return {
      summary: 'Target thread missing · falls back to new thread',
      detail: `The target thread is missing. At fire time this item falls back to a new thread using the current global ${globalHarnessName} harness and ${globalModelPhrase}.`,
      missingTarget: true,
    };
  }

  const targetHarnessName = harnessLabel(targetThread.agentHarness ?? 'claude');
  const targetModelName = modelLabel(targetThread.model ?? globalModel);
  const targetModelPhrase = targetThread.model
    ? `its persisted ${targetModelName} model`
    : globalModel
      ? `the current global ${targetModelName} model`
      : 'the CLI default model';
  return {
    summary: `Existing thread · ${targetHarnessName} · ${targetModelName}`,
    detail: `Resumes the target thread using its persisted ${targetHarnessName} harness and ${targetModelPhrase}.`,
    missingTarget: false,
  };
}

export function formatRelativeTime(targetMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((targetMs - nowMs) / 1_000));
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)}d`;
}

export function formatNextOccurrence(
  item: ScheduledItem,
  nowMs = Date.now(),
): NextOccurrenceDisplay | null {
  if (!item.enabled || !Number.isFinite(item.nextRun)) return null;
  const nextRun = item.nextRun as number;
  const overdue = nextRun <= nowMs;
  return {
    label: item.gate?.command ? 'Next check' : 'Next run',
    relative: overdue ? 'Overdue — catching up' : formatRelativeTime(nextRun, nowMs),
    exact: new Date(nextRun).toLocaleString(),
    overdue,
  };
}
