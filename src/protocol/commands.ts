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
  /**
   * `instanceId` is a stable id for one client install (the plugin's `remoteClientId`). The daemon keys the
   * read-write seat on (token, instance): the same instance reconnecting takes its own seat back, a different
   * instance sharing the token is refused. Absent (older clients) = one instance per token. Additive within v1.
   */
  | { type: 'hello'; protocol: number; client: ClientKind; clientVersion: string; token: string; instanceId?: string }
  | { type: 'session.open'; threadId: string; spec: RemoteSessionSpec; resume?: string }
  | { type: 'session.detach'; threadId: string }
  | { type: 'session.close'; threadId: string }
  | { type: 'session.list' }
  /** Is this folder usable as a session cwd on the daemon? (additive; older daemons answer `unknown_command`.) */
  | { type: 'path.check'; path: string }
  /** The folders this daemon allows sessions in, so a client can offer them instead of asking for a typed path. Additive; older daemons answer `unknown_command`. */
  | { type: 'workspaces.list' }
  /** Subfolders of an allowed folder, for browsing. Directories only, capped, confined to the workspaces. Additive. */
  | { type: 'path.list'; path: string }
  /**
   * `epoch` is the daemon process epoch the client last saw on this channel. If the daemon has restarted
   * since and lost journal entries the client already applied (a crash before they were flushed, so their
   * seqs were reused), the reply carries `rewind` and replay starts there. Additive within v1.
   */
  | { type: 'attach'; ch: Channel; afterSeq: number; epoch?: string }
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

/** One folder the daemon allows sessions in (reply to `workspaces.list`). */
export interface WorkspaceInfo {
  /** Absolute path on the daemon's machine, as configured. */
  path: string;
  /** Last path segment; a label for pickers. */
  name: string;
  /** Edits are refused there (a read-only workspace). */
  readOnly: boolean;
  /** `vault` when the folder holds a `.geode`, `.obsidian` or `.vault` directory, else `folder`. */
  kind: 'vault' | 'folder';
  /** The daemon's preferred starting folder: its first read-write workspace. */
  isDefault: boolean;
}

export interface WorkspacesListReply {
  workspaces: WorkspaceInfo[];
}

/** A subfolder in a `path.list` reply. */
export interface PathListEntry {
  name: string;
  /** Absolute path (the requested path joined with `name`). */
  path: string;
}

/**
 * Reply to `path.list`. A path outside every workspace (or one that is not a
 * folder) yields no entries and, like `path.check`, nothing else: no names
 * from outside the workspaces are ever returned.
 */
export interface PathListReply {
  /** The requested path is inside a configured workspace. */
  allowed: boolean;
  entries: PathListEntry[];
  /** More subfolders exist than were returned. */
  truncated: boolean;
}

export const WIRE_IMAGE_MEDIA_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
/** Caps on one `session.send` / `session.prepareForSend`: the model API rejects larger images anyway. */
export const MAX_WIRE_IMAGES = 10;
export const MAX_WIRE_IMAGE_BASE64_CHARS = 7_000_000;
export const MAX_WIRE_IMAGES_TOTAL_CHARS = 14_000_000;
const MAX_WIRE_IMAGE_NAME = 256;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Check the `images` of a send. Returns a message naming the first problem, or null. Every element is
 * checked (a `null` or a non-object used to slip past an "is it an array" test and throw later, inside
 * the session driver). Unknown media types are refused rather than silently dropped.
 */
export function validateWireImages(images: unknown): string | null {
  if (images === undefined) return null;
  if (!Array.isArray(images)) return 'images must be an array';
  if (images.length > MAX_WIRE_IMAGES) return `at most ${MAX_WIRE_IMAGES} images per message`;
  let total = 0;
  for (let i = 0; i < images.length; i++) {
    const img: unknown = images[i];
    if (typeof img !== 'object' || img === null || Array.isArray(img)) return `images[${i}] must be an object`;
    const { base64, mediaType, name } = img as Record<string, unknown>;
    if (typeof mediaType !== 'string' || !WIRE_IMAGE_MEDIA_TYPES.includes(mediaType)) return `images[${i}].mediaType must be one of ${WIRE_IMAGE_MEDIA_TYPES.join(', ')}`;
    if (typeof base64 !== 'string' || base64.length === 0) return `images[${i}].base64 must be a non-empty string`;
    if (base64.length > MAX_WIRE_IMAGE_BASE64_CHARS) return `images[${i}] is too large (limit ${MAX_WIRE_IMAGE_BASE64_CHARS} base64 characters)`;
    if (!BASE64.test(base64)) return `images[${i}].base64 is not valid base64`;
    if (name !== undefined && (typeof name !== 'string' || name.length > MAX_WIRE_IMAGE_NAME)) return `images[${i}].name must be a string of at most ${MAX_WIRE_IMAGE_NAME} characters`;
    total += base64.length;
  }
  if (total > MAX_WIRE_IMAGES_TOTAL_CHARS) return 'images are too large in total';
  return null;
}

/** At most this many subfolders are returned by one `path.list`. */
export const PATH_LIST_MAX_ENTRIES = 300;

export type ClientCommandType = ClientCommand['type'];

/** Every command type, for codec dispatch and exhaustiveness tests. */
export const CLIENT_COMMAND_TYPES: Record<ClientCommandType, true> = {
  hello: true,
  'session.open': true,
  'session.detach': true,
  'session.close': true,
  'session.list': true,
  'path.check': true,
  'workspaces.list': true,
  'path.list': true,
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
