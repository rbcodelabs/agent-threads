/**
 * envelope.ts
 *
 * Frame shapes for the daemon wire protocol (design section 3.2).
 *
 *   server -> client   { v:1, ch, seq, ts, type:'event', name, args }   journaled, resumable
 *                      { v:1, ch, seq, ts, type:'resync', checkpoint }
 *                      { v:1, type:'ack'|'err'|'welcome', cmdId, ... }  replies, never journaled
 *   client -> server   { v:1, cmdId, type, ...payload }
 *
 * Additive-only within `v:1`: receivers ignore fields they do not know.
 */
import type { ClientCommand } from './commands';
import type { Checkpoint } from './journal';
import type { WireEvent } from './sessionEvents';

export const PROTOCOL_VERSION = 1 as const;

/** `ctl` carries daemon-wide events; `t:<threadId>` is one session. */
export type Channel = 'ctl' | `t:${string}`;

export function threadChannel(threadId: string): Channel {
  return `t:${threadId}`;
}

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (value === 'ctl' || (value.startsWith('t:') && value.length > 2));
}

/** WebSocket close codes used by the daemon. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_SLOW_CONSUMER = 4408;

export type ErrorCode =
  | 'bad_frame'
  | 'unsupported_version'
  | 'unauthorized'
  | 'forbidden'
  | 'unknown_command'
  | 'not_found'
  | 'conflict'
  | 'slow_consumer'
  | 'daemon_restarted'
  | 'internal';

// ── server -> client ───────────────────────────────────────────────────────

/** A journaled event: `name`/`args` come from `WireEvent`. */
export type EventFrame = {
  v: typeof PROTOCOL_VERSION;
  ch: Channel;
  seq: number;
  ts: number;
  type: 'event';
  /**
   * Set on a re-delivered request event: the request is still open but its
   * original `seq` is at or below the client's cursor (it saw it, then lost
   * the socket). The client must NOT drop it as a duplicate; it re-shows the
   * prompt if it is not already showing it. Additive within v1.
   */
  reopen?: true;
} & WireEvent;

/** The cursor fell behind the journal; rebuild from the checkpoint then continue live. */
export interface ResyncFrame {
  v: typeof PROTOCOL_VERSION;
  ch: Channel;
  /** Equals `checkpoint.seq`. */
  seq: number;
  ts: number;
  type: 'resync';
  checkpoint: Checkpoint<WireEvent>;
}

export interface AckFrame {
  v: typeof PROTOCOL_VERSION;
  type: 'ack';
  cmdId: string;
  /** Command-specific result (e.g. `{ lastSeq }` for attach, getters' payload). */
  result?: unknown;
}

export interface ErrFrame {
  v: typeof PROTOCOL_VERSION;
  type: 'err';
  cmdId: string;
  code: ErrorCode;
  message: string;
  retryable?: boolean;
}

/** Reply to `hello`. */
export interface WelcomeFrame {
  v: typeof PROTOCOL_VERSION;
  type: 'welcome';
  cmdId: string;
  protocol: number;
  daemonVersion: string;
  minClientVersion: string;
  capabilities: string[];
  daemonId: string;
  /** Random per daemon process; a change means the daemon restarted. */
  epoch: string;
}

export type ServerFrame = EventFrame | ResyncFrame | AckFrame | ErrFrame | WelcomeFrame;

// ── client -> server ───────────────────────────────────────────────────────

export type ClientFrame = { v: typeof PROTOCOL_VERSION; cmdId: string } & ClientCommand;

export type HelloFrame = Extract<ClientFrame, { type: 'hello' }>;

// ── client-side cursor ─────────────────────────────────────────────────────

export type CursorOutcome = 'apply' | 'duplicate' | 'resync';

/**
 * Per-channel cursor implementing idempotent apply: events with
 * `seq <= lastSeq` are dropped, so replay overlapping live delivery (or a
 * retried attach) can never double-apply. Gaps in seq are legal (compaction
 * removes tokens of finished turns). A resync always applies and resets the
 * cursor to the checkpoint.
 */
export class StreamCursor {
  constructor(public lastSeq = 0) {}

  accept(frame: EventFrame | ResyncFrame): CursorOutcome {
    if (frame.type === 'resync') {
      this.lastSeq = frame.checkpoint.seq;
      return 'resync';
    }
    if (frame.seq <= this.lastSeq) return 'duplicate';
    this.lastSeq = frame.seq;
    return 'apply';
  }
}
