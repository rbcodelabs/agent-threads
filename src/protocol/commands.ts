/**
 * commands.ts
 *
 * Client -> daemon commands (design section 3.3 table). Each is carried in a
 * `ClientFrame` (`{ v: 1, cmdId, type, ...payload }`) and answered by an
 * `ack` / `err` frame with the same `cmdId`.
 */
import type { HarnessPermissionMode } from '../HarnessSession';
import type { Channel } from './envelope';
import type { RemoteHostToolSpec, RemoteSessionSpec } from './spec';

export type ClientKind = 'geode-plugin' | 'cli';

/** An image on `session.send`; the daemon cannot read the client's attachment paths. */
export interface WireImage {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  name: string;
}

export type ClientCommand =
  // Lifecycle
  | { type: 'hello'; protocol: number; client: ClientKind; clientVersion: string; token: string }
  | { type: 'session.open'; threadId: string; spec: RemoteSessionSpec; resume?: string }
  | { type: 'session.detach'; threadId: string }
  | { type: 'session.close'; threadId: string }
  | { type: 'session.list' }
  /** Is this folder usable as a session cwd on the daemon? (additive; older daemons answer `unknown_command`.) */
  | { type: 'path.check'; path: string }
  | { type: 'attach'; ch: Channel; afterSeq: number }
  | { type: 'ack'; ch: Channel; seq: number }
  // Turn
  | { type: 'session.send'; threadId: string; text: string; userMessageUuid: string; images?: WireImage[] }
  | { type: 'session.prepareForSend'; threadId: string; text: string; images?: WireImage[] }
  | { type: 'session.interrupt'; threadId: string }
  | { type: 'session.sendAgentMessage'; threadId: string; nativeAgentId: string; text: string }
  | { type: 'session.interruptAgent'; threadId: string; nativeAgentId: string }
  // State
  | { type: 'session.setModel'; threadId: string; model?: string }
  | { type: 'session.setPermissionMode'; threadId: string; mode: HarnessPermissionMode }
  | { type: 'session.getContextUsage'; threadId: string }
  | { type: 'session.mcpServerStatus'; threadId: string }
  | { type: 'session.getUsageSnapshot'; threadId: string; includeAccountUsage?: boolean }
  // Resolutions (requestId is owned by the daemon)
  | { type: 'resolve.permission'; threadId: string; requestId: string; allow: boolean; alwaysAllow?: boolean }
  | { type: 'resolve.question'; threadId: string; requestId: string; answers: Record<string, string> }
  | { type: 'resolve.plan'; threadId: string; requestId: string; approve: boolean; editedPlan?: string }
  | { type: 'resolve.elicitation'; threadId: string; requestId: string; result: Record<string, unknown> }
  | { type: 'resolve.openTab'; threadId: string; requestId: string; openedThreadId: string; title: string }
  // Host tools
  | { type: 'tool.result'; threadId: string; callId: string; success: boolean; text: string; content?: unknown[] }
  | { type: 'tool.manifest'; threadId: string; servers: Record<string, RemoteHostToolSpec[]> }
  // Credentials (PR 17)
  | { type: 'creds.push'; kind: string; ttlSec: number; fields: Record<string, string> };

/**
 * Reply to `path.check`. A path outside every workspace reports only
 * `allowed:false`: a read-scope token must not be able to probe the disk
 * beyond what sessions may use.
 */
export interface PathCheckReply {
  /** Inside a configured workspace (symlinks followed). */
  allowed: boolean;
  /** Only meaningful when `allowed`. */
  exists: boolean;
  isDirectory: boolean;
  /** The workspace is read-only: edits are refused there. */
  readOnly: boolean;
}

export type ClientCommandType = ClientCommand['type'];

/** Every command type, for codec dispatch and exhaustiveness tests. */
export const CLIENT_COMMAND_TYPES: Record<ClientCommandType, true> = {
  hello: true,
  'session.open': true,
  'session.detach': true,
  'session.close': true,
  'session.list': true,
  'path.check': true,
  attach: true,
  ack: true,
  'session.send': true,
  'session.prepareForSend': true,
  'session.interrupt': true,
  'session.sendAgentMessage': true,
  'session.interruptAgent': true,
  'session.setModel': true,
  'session.setPermissionMode': true,
  'session.getContextUsage': true,
  'session.mcpServerStatus': true,
  'session.getUsageSnapshot': true,
  'resolve.permission': true,
  'resolve.question': true,
  'resolve.plan': true,
  'resolve.elicitation': true,
  'resolve.openTab': true,
  'tool.result': true,
  'tool.manifest': true,
  'creds.push': true,
};
