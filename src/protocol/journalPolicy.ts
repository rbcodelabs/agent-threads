/**
 * journalPolicy.ts
 *
 * Teaches the generic Journal how to read daemon wire events: which are
 * tokens (compactable once their turn is finished and acked), which finish a
 * turn, and which open or close a request that must outlive a disconnect.
 */
import type { EventRole, JournalPolicy } from './journal';
import { REQUEST_EVENT_NAMES, type WireEvent } from './sessionEvents';

function requestIdOf(event: WireEvent): string | null {
  const args = event.args as unknown;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const a = args as { requestId?: unknown; callId?: unknown };
  if (typeof a.requestId === 'string') return a.requestId;
  if (typeof a.callId === 'string') return a.callId;
  return null;
}

export function classifyWireEvent(event: WireEvent): EventRole {
  switch (event.name) {
    case 'onToken': {
      const text = (event.args as readonly unknown[])[0];
      return { role: 'token', text: typeof text === 'string' ? text : '' };
    }
    case 'onMessage':
      return { role: 'message' };
    case 'onDone':
    case 'onInterrupted':
    case 'onError':
      return { role: 'turn_end' };
    case 'session.state':
      return { role: 'state' };
    case 'request_resolved':
    case 'tool.cancel': {
      const id = requestIdOf(event);
      return id ? { role: 'request_close', requestId: id } : { role: 'other' };
    }
    default: {
      if (REQUEST_EVENT_NAMES.includes(event.name)) {
        const id = requestIdOf(event);
        if (id) return { role: 'request_open', requestId: id };
      }
      return { role: 'other' };
    }
  }
}

export const wireJournalPolicy: JournalPolicy<WireEvent> = { classify: classifyWireEvent };
