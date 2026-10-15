/**
 * The seam between the wire server and whatever actually runs a session.
 *
 * `fakeHarness.ts` is a scripted stand-in (tests, smoke runs); `claudeDriver.ts`
 * hosts a real `ThreadSession`. `ThreadHost` talks only to this interface, so
 * nothing above it knows which one is behind a thread.
 */
import type { RemoteHostToolSpec, RemoteSessionSpec, WireEvent, WireImage } from '../src/protocol';
import type { HostToolOutcome } from './hostTools';

export type RequestKind = 'permission' | 'question' | 'plan' | 'elicitation' | 'openTab';

/** What a driver may do with the user's Geode: see the manifest, run a tool there, hear about attach changes. */
export interface HostToolPort {
  /** A client able to serve host tools holds this thread's seat. */
  attached(): boolean;
  manifest(): Record<string, RemoteHostToolSpec[]>;
  /** Never rejects: failure is an outcome the model can read. */
  call(server: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolOutcome>;
  /** Attach state or manifest changed. */
  onChange(cb: () => void): () => void;
}

/** Daemon-side facts the LOCAL tools (worktrees) need. */
export interface LocalToolsPort {
  /** False in a read-only workspace: the worktree tools write, so they are not offered. */
  enabled: boolean;
  worktreeRoot?: string;
  /** Throws when a working directory is outside the daemon's workspaces. */
  checkCwd(path: string): void;
}

export interface DriverContext {
  threadId: string;
  /** The spec the session was opened with (already validated against daemon policy). */
  spec: RemoteSessionSpec;
  /** Native session id to resume (stored one, the client's, or the spec's); undefined starts fresh. */
  resume?: string;
  /** Append an event to the thread's journal (and so to every attached client). */
  emit(event: WireEvent): void;
  /** The driver learned the harness-native session id; the host persists it for cold resume. */
  onNativeSessionId(id: string): void;
  /** Host tools (absent for a bare context, e.g. older tests). */
  hostTools?: HostToolPort;
  localTools?: LocalToolsPort;
  /** A local worktree tool moved the session's working directory; the host persists it and tells the client. */
  onCwdChanged?(cwd: string, originRepoPath?: string | null): void;
  /** Raw SDK events for the daemon's own JSONL log. Never on the wire. */
  onRawEvent?(event: Record<string, unknown>): void;
}

export interface SessionDriver {
  /** Mirror of `HarnessSession.turnInFlight`. */
  readonly turnInFlight: boolean;
  /** A permission/question/plan/elicitation is waiting on a human. */
  readonly hasPendingPermission: boolean;
  readonly cwd: string | undefined;
  /** Last time the session did anything (send, any callback); drives the idle reaper. */
  readonly lastActivityAt: number;
  /** Mirror of `HarnessSession.canIdleReap()`. */
  canIdleReap(): boolean;
  /** Start a turn. Must not block; output arrives through `emit`. */
  send(text: string, userMessageUuid: string, images?: WireImage[]): void;
  /** Stop the running turn; pending requests are canceled. */
  interrupt(): Promise<void> | void;
  /**
   * Answer a request the driver opened. Returns false when no such request is
   * pending (already resolved, or never existed).
   */
  resolve(kind: RequestKind, requestId: string, payload: Record<string, unknown>): boolean;
  /** Stop any work and release resources. Pending requests are canceled. */
  close(): void;

  // Optional surface. A driver that lacks one answers the command with an error.
  prepareForSend?(text: string, images?: WireImage[]): Promise<void>;
  sendAgentMessage?(nativeAgentId: string, text: string): Promise<void>;
  interruptAgent?(nativeAgentId: string): Promise<void>;
  setModel?(model: string | undefined): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
  getContextUsage?(): Promise<unknown>;
  mcpServerStatus?(): Promise<Array<{ name: string; status: string }>>;
  getUsageSnapshot?(includeAccountUsage?: boolean): Promise<unknown>;
}

export type DriverFactory = (ctx: DriverContext) => SessionDriver;
