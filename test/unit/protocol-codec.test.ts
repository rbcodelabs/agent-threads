import { describe, expect, it } from 'vitest';
import {
  CLIENT_COMMAND_TYPES,
  InMemoryJournal,
  ProtocolEncodeError,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  wireJournalPolicy,
  type ClientFrame,
  type ServerFrame,
  type WireEvent,
} from '../../src/protocol';

const clientSamples: ClientFrame[] = [
  { v: 1, cmdId: 'c1', type: 'hello', protocol: 1, client: 'cli', clientVersion: '0.62.2', token: 'tok' },
  { v: 1, cmdId: 'c2', type: 'attach', ch: 't:abc', afterSeq: 41 },
  { v: 1, cmdId: 'c3', type: 'ack', ch: 'ctl', seq: 7 },
  { v: 1, cmdId: 'c4', type: 'session.send', threadId: 'abc', text: 'hi', userMessageUuid: 'u1' },
  { v: 1, cmdId: 'c5', type: 'resolve.permission', threadId: 'abc', requestId: 'R', allow: true, alwaysAllow: false },
  { v: 1, cmdId: 'c6', type: 'session.list' },
  { v: 1, cmdId: 'c7', type: 'session.open', threadId: 'abc', spec: { harness: 'claude', cwd: '/w', permissionMode: 'default', extraEnvRaw: '' } as never },
  { v: 1, cmdId: 'c9', type: 'path.check', path: '/home/rick/vault' },
  { v: 1, cmdId: 'c8', type: 'creds.push', kind: 'claude', ttlSec: 60, fields: { token: 'x' } },
];

describe('client frame codec', () => {
  it.each(clientSamples.map((f) => [f.type, f] as const))('round-trips %s', (_t, frame) => {
    const decoded = decodeClientFrame(encodeFrame(frame));
    expect(decoded).toEqual({ ok: true, frame });
  });

  it('tolerates unknown additive fields and keeps them', () => {
    const wire = JSON.stringify({ ...clientSamples[1], futureField: { a: 1 } });
    const r = decodeClientFrame(wire);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.frame as unknown as { futureField: unknown }).futureField).toEqual({ a: 1 });
  });

  const bad: Array<[string, string, string, Partial<{ code: string; cmdId: string }>]> = [
    ['not json', '{nope', 'not valid JSON', { code: 'bad_frame' }],
    ['array', '[]', 'JSON object', { code: 'bad_frame' }],
    ['missing v', '{"cmdId":"x","type":"session.list"}', '"v"', { code: 'bad_frame', cmdId: 'x' }],
    ['wrong v', '{"v":2,"cmdId":"x","type":"session.list"}', 'unsupported protocol version 2', { code: 'unsupported_version', cmdId: 'x' }],
    ['missing type', '{"v":1,"cmdId":"x"}', '"type"', { code: 'bad_frame' }],
    ['missing cmdId', '{"v":1,"type":"session.list"}', 'cmdId', { code: 'bad_frame' }],
    ['unknown command', '{"v":1,"cmdId":"x","type":"session.explode"}', 'unknown command "session.explode"', { code: 'unknown_command', cmdId: 'x' }],
    ['prototype-key type', '{"v":1,"cmdId":"x","type":"constructor"}', 'unknown command', { code: 'unknown_command' }],
    ['missing field', '{"v":1,"cmdId":"x","type":"attach","ch":"ctl"}', 'missing required field "afterSeq"', { code: 'bad_frame', cmdId: 'x' }],
    ['wrong field type', '{"v":1,"cmdId":"x","type":"ack","ch":"ctl","seq":"7"}', 'field "seq" must be a non-negative integer', { code: 'bad_frame' }],
    ['negative seq', '{"v":1,"cmdId":"x","type":"ack","ch":"ctl","seq":-1}', 'non-negative integer', { code: 'bad_frame' }],
    ['bad channel', '{"v":1,"cmdId":"x","type":"attach","ch":"t:","afterSeq":0}', 'must be a channel', { code: 'bad_frame' }],
    ['null optional', '{"v":1,"cmdId":"x","type":"session.setModel","threadId":"t","model":null}', 'field "model"', { code: 'bad_frame' }],
  ];
  it.each(bad)('rejects %s with a clear error', (_name, text, snippet, expected) => {
    const r = decodeClientFrame(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain(snippet);
    if (expected.code) expect(r.error.code).toBe(expected.code);
    if (expected.cmdId) expect(r.error.cmdId).toBe(expected.cmdId);
  });

  it('has a validator for every command type (no command is accept-anything)', () => {
    // A frame with only the envelope must be rejected for every command that has required fields.
    const noFields = new Set(['session.list']);
    for (const type of Object.keys(CLIENT_COMMAND_TYPES)) {
      const r = decodeClientFrame(JSON.stringify({ v: 1, cmdId: 'x', type }));
      expect(r.ok, type).toBe(noFields.has(type));
    }
  });
});

describe('server frame codec', () => {
  const journal = new InMemoryJournal<WireEvent>(wireJournalPolicy, { now: () => 5 });
  journal.append({ name: 'onToken', args: ['hello'] });
  const checkpoint = journal.checkpoint();

  const serverSamples: ServerFrame[] = [
    { v: 1, ch: 't:abc', seq: 3, ts: 9, type: 'event', name: 'onToken', args: ['x'] },
    { v: 1, ch: 't:abc', seq: 4, ts: 9, type: 'event', name: 'permission_request', args: { requestId: 'R', toolName: 'Bash', detail: 'ls' } },
    { v: 1, ch: 'ctl', seq: 1, ts: 9, type: 'event', name: 'session.state', args: { turnInFlight: false, hasPendingPermission: false, hostAttached: true } },
    { v: 1, ch: 't:abc', seq: checkpoint.seq, ts: 9, type: 'resync', checkpoint },
    { v: 1, type: 'ack', cmdId: 'c1', result: { lastSeq: 3 } },
    { v: 1, type: 'err', cmdId: 'c1', code: 'not_found', message: 'no such thread', retryable: false },
    { v: 1, type: 'welcome', cmdId: 'c0', protocol: 1, daemonVersion: '0.1.0', minClientVersion: '0.62.0', capabilities: ['resume'], daemonId: 'd', epoch: 'e1' },
  ];

  it.each(serverSamples.map((f) => [`${f.type}${'name' in f ? `:${f.name}` : ''}`, f] as const))('round-trips %s', (_n, frame) => {
    expect(decodeServerFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
  });

  it('tolerates unknown additive fields on known frames', () => {
    const r = decodeServerFrame(JSON.stringify({ ...serverSamples[0], extra: true }));
    expect(r.ok).toBe(true);
  });

  it('reports unknown frame types distinctly so a client can ignore them', () => {
    const r = decodeServerFrame('{"v":1,"type":"hologram"}');
    expect(r).toMatchObject({ ok: false, error: { code: 'unknown_type', frameType: 'hologram' } });
  });

  it.each([
    ['event without seq', '{"v":1,"ch":"ctl","ts":1,"type":"event","name":"x","args":[]}', 'seq'],
    ['event with scalar args', '{"v":1,"ch":"ctl","seq":1,"ts":1,"type":"event","name":"x","args":5}', 'args'],
    ['event with bad channel', '{"v":1,"ch":"zzz","seq":1,"ts":1,"type":"event","name":"x","args":[]}', 'channel'],
    ['resync with broken checkpoint', '{"v":1,"ch":"ctl","seq":1,"ts":1,"type":"resync","checkpoint":{"seq":1}}', 'checkpoint'],
    ['err without code', '{"v":1,"type":"err","cmdId":"c","message":"m"}', 'code'],
    ['wrong version', '{"v":3,"type":"ack","cmdId":"c"}', 'unsupported protocol version 3'],
  ])('rejects %s', (_n, text, snippet) => {
    const r = decodeServerFrame(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain(snippet);
  });
});

describe('encodeFrame', () => {
  it('refuses frames that cannot be serialized or lack v:1', () => {
    const cyclic: Record<string, unknown> = { v: 1, type: 'ack', cmdId: 'c' };
    cyclic.self = cyclic;
    expect(() => encodeFrame(cyclic as never)).toThrow(ProtocolEncodeError);
    expect(() => encodeFrame({ v: 2, type: 'ack', cmdId: 'c' } as never)).toThrow(/frame\.v must be 1/);
  });
});
