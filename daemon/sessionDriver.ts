/**
 * The seam between the wire server and whatever actually runs a session.
 *
 * PR 3 plugs in a scripted fake (`fakeHarness.ts`) so the transport, auth and
 * resume machinery can be proven without Claude. PR 4 replaces the factory
 * with one that builds a real `ThreadSession` from the `RemoteSessionSpec`;
 * nothing above this interface changes.
 */
import type { RemoteSessionSpec, WireEvent } from '../src/protocol';

export type RequestKind = 'permission' | 'question' | 'plan' | 'elicitation' | 'openTab';

export interface DriverContext {
  threadId: string;
  spec: RemoteSessionSpec;
  /** Append an event to the thread's journal (and so to every attached client). */
  emit(event: WireEvent): void;
}

export interface SessionDriver {
  /** Mirror of `HarnessSession.turnInFlight`. */
  readonly turnInFlight: boolean;
  /** Start a turn. Must not block; output arrives through `emit`. */
  send(text: string, userMessageUuid: string): void;
  interrupt(): void;
  /**
   * Answer a request the driver opened. Returns false when no such request is
   * pending (already resolved, or never existed).
   */
  resolve(kind: RequestKind, requestId: string, payload: Record<string, unknown>): boolean;
  /** Stop any work and release resources. */
  close(): void;
}

export type DriverFactory = (ctx: DriverContext) => SessionDriver;
