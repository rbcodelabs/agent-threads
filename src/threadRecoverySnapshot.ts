import { isAgentHarness } from './types';
import type { ChatMessage, Thread } from './types';
import { serializeThreadForSave } from './imageExternalization';

export const THREAD_RECOVERY_SNAPSHOT_VERSION = 1;

interface ThreadRecoverySnapshotV1 {
  version: typeof THREAD_RECOVERY_SNAPSHOT_VERSION;
  thread: Thread;
}

export function recoverySnapshotPath(markdownPath: string): string {
  return markdownPath.replace(/\.md$/i, '') + '.recovery.json';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && (value.role === 'user' || value.role === 'assistant' || value.role === 'compact' || value.role === 'notice')
    && typeof value.content === 'string'
    && typeof value.timestamp === 'number'
    && Number.isFinite(value.timestamp)
    && (value.agentHarness === undefined || isAgentHarness(value.agentHarness))
    && (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every((tool) => (
      isRecord(tool) && typeof tool.name === 'string' && typeof tool.summary === 'string'
    ))));
}

function isCanonicalThread(value: unknown): value is Thread {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.cwd === 'string'
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && Array.isArray(value.messages)
    && value.messages.every(isCanonicalMessage)
    && (value.sessionId === undefined || typeof value.sessionId === 'string')
    && (value.sessionGeneration === undefined || (typeof value.sessionGeneration === 'number' && Number.isInteger(value.sessionGeneration) && value.sessionGeneration >= 0))
    && (value.pendingHarnessHandoff === undefined || (
      isRecord(value.pendingHarnessHandoff)
      && isAgentHarness(value.pendingHarnessHandoff.sourceHarness)
      && isAgentHarness(value.pendingHarnessHandoff.targetHarness)
      && typeof value.pendingHarnessHandoff.summary === 'string'
      && typeof value.pendingHarnessHandoff.threadId === 'string'
      && typeof value.pendingHarnessHandoff.createdAt === 'number'
    ))
    && (value.agentHarness === undefined || isAgentHarness(value.agentHarness));
}

/** Serialize only the canonical persisted Thread projection; rendered prose is never included. */
export function encodeThreadRecoverySnapshot(thread: Thread): string {
  const snapshot: ThreadRecoverySnapshotV1 = {
    version: THREAD_RECOVERY_SNAPSHOT_VERSION,
    thread: serializeThreadForSave(thread),
  };
  return JSON.stringify(snapshot);
}

/** Strictly decode the current schema. Unknown versions and malformed payloads are unrecoverable. */
export function decodeThreadRecoverySnapshot(content: string): Thread | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || parsed.version !== THREAD_RECOVERY_SNAPSHOT_VERSION) return null;
    return isCanonicalThread(parsed.thread) ? parsed.thread : null;
  } catch {
    return null;
  }
}
