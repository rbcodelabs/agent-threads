/**
 * codec.ts
 *
 * JSON text codec for daemon frames. Decoding validates the envelope and the
 * required fields of each known frame type and returns a result (never throws)
 * so a network loop can reply with a precise `err` frame or drop the frame.
 *
 * Tolerance rules (additive-only within v1): unknown extra fields are kept and
 * ignored; unknown `type`s are reported as `unknown_command` (client frames) or
 * `unknown_type` (server frames) so the caller can decide, instead of being
 * silently mis-parsed.
 */
import { CLIENT_COMMAND_TYPES, validateRepoSpecs, validateWireImages, type ClientCommandType } from './commands';
import { validateManifestServers, validateToolResultPayload } from './hostTools';
import { validateSyncedMcpShape } from './mcpSync';
import { validateSpecShape } from './spec';
import {
  PROTOCOL_VERSION,
  isChannel,
  type ClientFrame,
  type ServerFrame,
} from './envelope';

export type CodecErrorCode = 'bad_frame' | 'unsupported_version' | 'unknown_command' | 'unknown_type';

export interface CodecError {
  code: CodecErrorCode;
  message: string;
  /** Present when it could be recovered from a malformed client frame, for the reply. */
  cmdId?: string;
  frameType?: string;
}

export type DecodeResult<T> = { ok: true; frame: T } | { ok: false; error: CodecError };

export class ProtocolEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolEncodeError';
  }
}

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(frame);
  } catch (err) {
    throw new ProtocolEncodeError(`frame is not JSON-serializable: ${(err as Error).message}`);
  }
  if (typeof text !== 'string') throw new ProtocolEncodeError('frame serialized to nothing');
  if ((frame as { v?: unknown }).v !== PROTOCOL_VERSION) {
    throw new ProtocolEncodeError(`frame.v must be ${PROTOCOL_VERSION}`);
  }
  return text;
}

// ── field validation ───────────────────────────────────────────────────────

/**
 * Field kinds: s string, S non-empty string, n finite number, i non-negative
 * integer, b boolean, o plain object, a array, c channel. A trailing `?` marks
 * the field optional (absent or undefined; `null` is not accepted).
 */
type Kind = 's' | 'S' | 'n' | 'i' | 'b' | 'o' | 'a' | 'c';
type FieldSpec = Record<string, Kind | `${Kind}?`>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkKind(kind: Kind, value: unknown): boolean {
  switch (kind) {
    case 's': return typeof value === 'string';
    case 'S': return typeof value === 'string' && value.length > 0;
    case 'n': return typeof value === 'number' && Number.isFinite(value);
    case 'i': return typeof value === 'number' && Number.isInteger(value) && value >= 0;
    case 'b': return typeof value === 'boolean';
    case 'o': return isObject(value);
    case 'a': return Array.isArray(value);
    case 'c': return isChannel(value);
  }
}

const KIND_NAME: Record<Kind, string> = {
  s: 'a string', S: 'a non-empty string', n: 'a number', i: 'a non-negative integer',
  b: 'a boolean', o: 'an object', a: 'an array', c: 'a channel ("ctl" or "t:<threadId>")',
};

/** Returns a message naming the first bad field, or null. */
function validateFields(obj: Record<string, unknown>, spec: FieldSpec): string | null {
  for (const [field, raw] of Object.entries(spec)) {
    const optional = raw.endsWith('?');
    const kind = (optional ? raw.slice(0, -1) : raw) as Kind;
    const value = obj[field];
    if (value === undefined) {
      if (optional) continue;
      return `missing required field "${field}"`;
    }
    if (!checkKind(kind, value)) return `field "${field}" must be ${KIND_NAME[kind]}`;
  }
  return null;
}

const COMMAND_FIELDS: Record<ClientCommandType, FieldSpec> = {
  hello: { protocol: 'i', client: 'S', clientVersion: 's', token: 's', instanceId: 's?' },
  'session.open': { threadId: 'S', spec: 'o', resume: 's?' },
  'session.detach': { threadId: 'S' },
  'session.close': { threadId: 'S' },
  'session.list': {},
  'path.check': { path: 'S' },
  'workspaces.list': {},
  'path.list': { path: 'S' },
  'file.read': { path: 'S' },
  attach: { ch: 'c', afterSeq: 'i', epoch: 's?', observe: 'b?' },
  ack: { ch: 'c', seq: 'i' },
  'session.send': { threadId: 'S', text: 's', userMessageUuid: 'S', images: 'a?' },
  'session.prepareForSend': { threadId: 'S', text: 's', images: 'a?' },
  'session.interrupt': { threadId: 'S' },
  'session.sendAgentMessage': { threadId: 'S', nativeAgentId: 'S', text: 's' },
  'session.interruptAgent': { threadId: 'S', nativeAgentId: 'S' },
  'session.setModel': { threadId: 'S', model: 's?' },
  'session.setPermissionMode': { threadId: 'S', mode: 'S' },
  'session.getContextUsage': { threadId: 'S' },
  'session.mcpServerStatus': { threadId: 'S' },
  'session.getUsageSnapshot': { threadId: 'S', includeAccountUsage: 'b?' },
  'resolve.permission': { threadId: 'S', requestId: 'S', allow: 'b', alwaysAllow: 'b?' },
  'resolve.question': { threadId: 'S', requestId: 'S', answers: 'o' },
  'resolve.plan': { threadId: 'S', requestId: 'S', approve: 'b', editedPlan: 's?' },
  'resolve.elicitation': { threadId: 'S', requestId: 'S', result: 'o' },
  'resolve.openTab': { threadId: 'S', requestId: 'S', openedThreadId: 'S', title: 's' },
  'tool.result': { threadId: 'S', callId: 'S', success: 'b', text: 's', content: 'a?' },
  'tool.manifest': { threadId: 'S', servers: 'o' },
  'creds.push': { kind: 'S', ttlSec: 'n', fields: 'o' },
  'repos.sync': { repos: 'a?', wait: 'b?' },
  'repos.status': {},
  'mcp.sync': { servers: 'o', wait: 'b?' },
};

const SERVER_FIELDS: Record<'event' | 'resync' | 'ack' | 'err' | 'welcome', FieldSpec> = {
  event: { ch: 'c', seq: 'i', ts: 'n', name: 'S' },
  resync: { ch: 'c', seq: 'i', ts: 'n', checkpoint: 'o' },
  ack: { cmdId: 'S' },
  err: { cmdId: 'S', code: 'S', message: 's' },
  welcome: { cmdId: 'S', protocol: 'i', daemonVersion: 's', minClientVersion: 's', capabilities: 'a', daemonId: 'S', epoch: 'S' },
};

const CHECKPOINT_FIELDS: FieldSpec = { seq: 'i', ts: 'n', inFlightText: 's', openRequests: 'a', recentMessages: 'a' };

// ── decoding ───────────────────────────────────────────────────────────────

function parseEnvelope(text: string): DecodeResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return fail('bad_frame', `frame is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(parsed)) return fail('bad_frame', 'frame must be a JSON object');
  const frameType = typeof parsed.type === 'string' ? parsed.type : undefined;
  const cmdId = typeof parsed.cmdId === 'string' ? parsed.cmdId : undefined;
  if (parsed.v === undefined) return fail('bad_frame', 'missing protocol version field "v"', { cmdId, frameType });
  if (parsed.v !== PROTOCOL_VERSION) {
    return fail('unsupported_version', `unsupported protocol version ${JSON.stringify(parsed.v)}; this build speaks v${PROTOCOL_VERSION}`, { cmdId, frameType });
  }
  if (frameType === undefined || frameType === '') return fail('bad_frame', 'missing frame "type"', { cmdId });
  return { ok: true, frame: parsed };
}

function fail(code: CodecErrorCode, message: string, extra: { cmdId?: string; frameType?: string } = {}): { ok: false; error: CodecError } {
  return { ok: false, error: { code, message, ...(extra.cmdId ? { cmdId: extra.cmdId } : {}), ...(extra.frameType ? { frameType: extra.frameType } : {}) } };
}

/** Element-level checks that the flat field kinds cannot express (images, spec). */
function validateDeep(type: string, obj: Record<string, unknown>): string | null {
  switch (type) {
    case 'session.send':
    case 'session.prepareForSend':
      return validateWireImages(obj.images);
    case 'session.open':
      return validateSpecShape(obj.spec);
    case 'repos.sync':
      return validateRepoSpecs(obj.repos);
    case 'mcp.sync':
      return validateSyncedMcpShape(obj.servers);
    case 'tool.manifest':
      return validateManifestServers(obj.servers);
    case 'tool.result':
      return validateToolResultPayload({ text: obj.text, content: obj.content });
    default:
      return null;
  }
}

export function decodeClientFrame(text: string): DecodeResult<ClientFrame> {
  const env = parseEnvelope(text);
  if (!env.ok) return env;
  const obj = env.frame;
  const type = obj.type as string;
  const cmdId = typeof obj.cmdId === 'string' && obj.cmdId.length > 0 ? obj.cmdId : undefined;
  if (!cmdId) return fail('bad_frame', 'client frame requires a non-empty string "cmdId"', { frameType: type });
  if (!Object.prototype.hasOwnProperty.call(CLIENT_COMMAND_TYPES, type)) {
    return fail('unknown_command', `unknown command "${type}"`, { cmdId, frameType: type });
  }
  const problem = validateFields(obj, COMMAND_FIELDS[type as ClientCommandType]) ?? validateDeep(type, obj);
  if (problem) return fail('bad_frame', `${type}: ${problem}`, { cmdId, frameType: type });
  return { ok: true, frame: obj as unknown as ClientFrame };
}

export function decodeServerFrame(text: string): DecodeResult<ServerFrame> {
  const env = parseEnvelope(text);
  if (!env.ok) return env;
  const obj = env.frame;
  const type = obj.type as string;
  if (!Object.prototype.hasOwnProperty.call(SERVER_FIELDS, type)) {
    return fail('unknown_type', `unknown server frame type "${type}"`, { frameType: type });
  }
  const key = type as keyof typeof SERVER_FIELDS;
  let problem = validateFields(obj, SERVER_FIELDS[key]);
  if (!problem && key === 'event') {
    const args = obj.args;
    if (!(Array.isArray(args) || isObject(args))) problem = 'field "args" must be an array or an object';
  }
  if (!problem && key === 'resync') {
    const inner = validateFields(obj.checkpoint as Record<string, unknown>, CHECKPOINT_FIELDS);
    if (inner) problem = `checkpoint: ${inner}`;
  }
  if (problem) return fail('bad_frame', `${type}: ${problem}`, { frameType: type });
  return { ok: true, frame: obj as unknown as ServerFrame };
}
