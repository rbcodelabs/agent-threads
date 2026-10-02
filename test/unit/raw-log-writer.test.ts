import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RawLogWriter } from '../../src/RawLogWriter';

// ---------------------------------------------------------------------------
// RawLogWriter writes to the real filesystem (it uses require('fs')), so each
// test points it at a throwaway temp directory and reads the result back.
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rawlog-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Deterministically wait for the writer's async append chain to finish, by
 * awaiting the real per-file write tails instead of a fixed sleep. A blind
 * `setTimeout` here was flaky: on a busy machine the mkdir + appendFile chain
 * sometimes hadn't flushed within the timeout, so the read-back saw an empty
 * or missing file.
 */
async function settle(w: RawLogWriter): Promise<void> {
  await w.flushAll();
}

function makeWriter(folder = 'Claude') {
  return new RawLogWriter(
    () => tmpRoot,
    () => folder,
  );
}

function logLines(threadId: string, folder = 'Claude'): Record<string, unknown>[] {
  const file = path.join(tmpRoot, folder, 'logs', `${threadId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('RawLogWriter.shouldLog', () => {
  it('filters out partial streaming token deltas', () => {
    expect(RawLogWriter.shouldLog('stream_event')).toBe(false);
  });

  it('keeps every other event type', () => {
    for (const t of ['assistant', 'user', 'result', 'system', 'session_start', undefined]) {
      expect(RawLogWriter.shouldLog(t)).toBe(true);
    }
  });
});

describe('RawLogWriter.vaultRelativePath', () => {
  it('keys the log by thread id under <folder>/logs', () => {
    const w = makeWriter('Claude');
    expect(w.vaultRelativePath('abc-123')).toBe('Claude/logs/abc-123.jsonl');
  });

  it('falls back to Claude when the folder is empty', () => {
    const w = new RawLogWriter(() => tmpRoot, () => '');
    expect(w.vaultRelativePath('t1')).toBe('Claude/logs/t1.jsonl');
  });
});

describe('RawLogWriter.append', () => {
  it('writes one wrapped JSONL line per event with ts/threadId/type/event', async () => {
    const w = makeWriter();
    w.append('t1', 'sess-9', 'assistant', { type: 'assistant', message: { text: 'hi' } });
    await settle(w);

    const lines = logLines('t1');
    expect(lines).toHaveLength(1);
    const line = lines[0] as Record<string, unknown>;
    expect(line.threadId).toBe('t1');
    expect(line.sessionId).toBe('sess-9');
    expect(line.type).toBe('assistant');
    expect(typeof line.ts).toBe('string');
    expect((line.event as Record<string, unknown>).message).toEqual({ text: 'hi' });
  });

  it('appends in arrival order across multiple events', async () => {
    const w = makeWriter();
    w.append('t2', undefined, 'session_start', { type: 'session_start' });
    w.append('t2', undefined, 'assistant', { type: 'assistant', n: 1 });
    w.append('t2', undefined, 'result', { type: 'result', cost: 0.02 });
    await settle(w);

    const types = logLines('t2').map((l) => l.type);
    expect(types).toEqual(['session_start', 'assistant', 'result']);
  });

  it('keeps logs for different threads in separate files', async () => {
    const w = makeWriter();
    w.append('a', undefined, 'assistant', { type: 'assistant' });
    w.append('b', undefined, 'assistant', { type: 'assistant' });
    await settle(w);

    expect(logLines('a')).toHaveLength(1);
    expect(logLines('b')).toHaveLength(1);
  });

  it('does nothing when the vault root is unknown', async () => {
    const w = new RawLogWriter(() => '', () => 'Claude');
    w.append('t3', undefined, 'assistant', { type: 'assistant' });
    await settle(w);
    // No file should have been created anywhere under tmpRoot.
    expect(fs.existsSync(path.join(tmpRoot, 'Claude'))).toBe(false);
  });

  it('keeps a circular payload, marking the back-reference (redaction walks the event first)', async () => {
    const w = makeWriter();
    const circular: Record<string, unknown> = { type: 'assistant' };
    circular.self = circular;
    w.append('t4', undefined, 'assistant', circular);
    await settle(w);

    const lines = logLines('t4');
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toEqual({ type: 'assistant', self: '[Circular]' });
    expect(lines[0].type).toBe('assistant');
  });

  it('degrades gracefully on a non-serializable payload', async () => {
    const w = makeWriter();
    w.append('t4b', undefined, 'assistant', { n: BigInt(1) });
    await settle(w);

    const lines = logLines('t4b');
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('[unserializable]');
    expect(lines[0].type).toBe('assistant');
  });
});

describe('RawLogWriter.read', () => {
  it('returns null when no log file exists yet', async () => {
    const w = makeWriter();
    expect(await w.read('missing')).toBeNull();
  });

  it('returns null when the vault root is unknown', async () => {
    const w = new RawLogWriter(() => '', () => 'Claude');
    expect(await w.read('t1')).toBeNull();
  });

  it('parses every appended entry and reports the absolute path', async () => {
    const w = makeWriter();
    w.append('r1', 's', 'session_start', { type: 'session_start' });
    w.append('r1', 's', 'assistant', { type: 'assistant', n: 1 });
    await settle(w);

    const res = await w.read('r1');
    expect(res).not.toBeNull();
    expect(res!.total).toBe(2);
    expect(res!.returned).toBe(2);
    expect(res!.path).toBe(path.join(tmpRoot, 'Claude', 'logs', 'r1.jsonl'));
    expect(res!.entries.map((e) => e.type)).toEqual(['session_start', 'assistant']);
  });

  it('tails to the most recent `limit` entries', async () => {
    const w = makeWriter();
    for (let i = 0; i < 5; i++) w.append('r2', undefined, 'assistant', { type: 'assistant', n: i });
    await settle(w);

    const res = await w.read('r2', { limit: 2 });
    expect(res!.total).toBe(5);
    expect(res!.returned).toBe(2);
    expect(res!.entries.map((e) => (e.event as { n: number }).n)).toEqual([3, 4]);
  });

  it('filters by type before tailing, and limit 0 returns all', async () => {
    const w = makeWriter();
    w.append('r3', undefined, 'session_start', { type: 'session_start' });
    w.append('r3', undefined, 'assistant', { type: 'assistant', n: 0 });
    w.append('r3', undefined, 'result', { type: 'result' });
    w.append('r3', undefined, 'assistant', { type: 'assistant', n: 1 });
    await settle(w);

    const res = await w.read('r3', { type: 'assistant', limit: 0 });
    expect(res!.total).toBe(2);
    expect(res!.returned).toBe(2);
    expect(res!.entries.every((e) => e.type === 'assistant')).toBe(true);
  });

  it('skips malformed lines rather than throwing', async () => {
    const w = makeWriter();
    w.append('r4', undefined, 'assistant', { type: 'assistant' });
    await settle(w);
    // Corrupt the file by appending a junk line.
    const file = path.join(tmpRoot, 'Claude', 'logs', 'r4.jsonl');
    fs.appendFileSync(file, 'not json\n', 'utf8');

    const res = await w.read('r4');
    expect(res!.total).toBe(1);
    expect(res!.entries[0].type).toBe('assistant');
  });
});

describe('RawLogWriter trace streaming', () => {
  it('pages metadata without reading log contents', async () => {
    const w = makeWriter();
    w.append('meta', undefined, 'assistant', { value: 'visible' });
    await settle(w);
    const readFile = vi.spyOn(fs.promises, 'readFile');

    const metadata = await w.getTraceMetadata('meta');

    expect(metadata).toMatchObject({ sourceId: 'meta', byteLength: expect.any(Number), revision: expect.any(String), contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(readFile).not.toHaveBeenCalled();
    readFile.mockRestore();
  });

  it('reads a bounded JSONL chunk by byte offset without readFile', async () => {
    const w = makeWriter();
    const file = path.join(tmpRoot, 'Claude', 'logs', 'large.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [...Array(5_000).keys()].map(i => JSON.stringify({ ts: '2026-01-01T00:00:00Z', threadId: 'large', type: 'assistant', event: { i, padding: 'x'.repeat(120) } })).join('\n') + '\n');
    const readFile = vi.spyOn(fs.promises, 'readFile');

    const chunk = await w.readTraceChunk('large', { byteOffset: 0, eventIndex: 0, limit: 10 });

    expect(chunk?.entries).toHaveLength(10);
    expect(chunk?.entries.map(entry => (entry.event as { i: number }).i)).toEqual([...Array(10).keys()]);
    expect(chunk!.bytesRead).toBeLessThanOrEqual(64 * 1024);
    expect(chunk!.readCalls).toBe(1);
    expect(chunk!.nextByteOffset).toBeLessThan(chunk!.metadata.byteLength);
    expect(readFile).not.toHaveBeenCalled();
    readFile.mockRestore();
  });

  it('skips malformed streamed lines while preserving valid event indexes', async () => {
    const w = makeWriter();
    w.append('malformed', undefined, 'assistant', { i: 0 });
    await settle(w);
    const file = path.join(tmpRoot, 'Claude', 'logs', 'malformed.jsonl');
    fs.appendFileSync(file, 'not json\n', 'utf8');
    w.append('malformed', undefined, 'assistant', { i: 1 });
    await settle(w);

    const chunk = await w.readTraceChunk('malformed', { byteOffset: 0, eventIndex: 0, limit: 10 });

    expect(chunk?.entries.map(entry => (entry.event as { i: number }).i)).toEqual([0, 1]);
    expect(chunk?.nextEventIndex).toBe(2);
    expect(chunk?.eof).toBe(true);
  });

  it('changes revision when a source is truncated but not when appended', async () => {
    const w = makeWriter();
    w.append('revision', undefined, 'assistant', { i: 0 });
    await settle(w);
    const initial = await w.getTraceMetadata('revision');
    w.append('revision', undefined, 'assistant', { i: 1 });
    await settle(w);
    const appended = await w.getTraceMetadata('revision');
    expect(appended?.revision).toBe(initial?.revision);
    expect(appended?.contentHash).not.toBe(initial?.contentHash);

    const file = path.join(tmpRoot, 'Claude', 'logs', 'revision.jsonl');
    fs.truncateSync(file, 0);
    const truncated = await w.getTraceMetadata('revision');
    expect(truncated?.revision).not.toBe(initial?.revision);
  });

  it('streams a valid JSONL line larger than 64 KiB without wedging', async () => {
    const w = makeWriter(); const file = path.join(tmpRoot, 'Claude', 'logs', 'oversized.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ts: '1', threadId: 'oversized', type: 'assistant', event: { text: 'x'.repeat(70_000) } }) + '\n');
    const chunk = await w.readTraceChunk('oversized', { byteOffset: 0, eventIndex: 0, limit: 1 });
    expect(chunk?.entries).toHaveLength(1); expect(chunk?.eof).toBe(true);
  });

  it('skips a line beyond the semantic maximum and advances', async () => {
    const w = makeWriter(); const file = path.join(tmpRoot, 'Claude', 'logs', 'too-large.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(1_100_000) + '\n' + JSON.stringify({ ts: '2', threadId: 'too-large', type: 'assistant', event: { ok: true } }) + '\n');
    const chunk = await w.readTraceChunk('too-large', { byteOffset: 0, eventIndex: 0, limit: 1 });
    expect(chunk?.entries.map(e => e.event)).toEqual([{ ok: true }]); expect(chunk?.eof).toBe(true);
  });

  it('changes revision across restart after an in-place rewrite', async () => {
    const w = makeWriter(); w.append('restart', undefined, 'assistant', { value: 'one' }); await settle(w);
    const initial = await w.getTraceMetadata('restart'); const file = path.join(tmpRoot, 'Claude', 'logs', 'restart.jsonl');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('one', 'two'));
    expect((await makeWriter().getTraceMetadata('restart'))?.revision).not.toBe(initial?.revision);
  });

  it('changes a restart-safe cursor boundary hash when preceding bytes are rewritten', async () => {
    const file = path.join(tmpRoot, 'Claude', 'logs', 'boundary.jsonl'); fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = [...Array(20)].map((_, i) => JSON.stringify({ ts: '1', threadId: 'boundary', type: 'assistant', event: { i, pad: 'x'.repeat(300) } })); fs.writeFileSync(file, lines.join('\n') + '\n');
    const first = await makeWriter().readTraceChunk('boundary', { byteOffset: 0, eventIndex: 0, limit: 15 });
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"i":12', '"i":99'));
    const resumed = await makeWriter().readTraceChunk('boundary', { byteOffset: first!.nextByteOffset, eventIndex: first!.nextEventIndex, limit: 1 });
    expect(resumed?.startBoundaryHash).not.toBe(first?.nextBoundaryHash);
  });

  it('closes the streaming file handle when a read throws', async () => {
    const w = makeWriter(); w.append('close-error', undefined, 'assistant', { ok: true }); await settle(w);
    const originalOpen = fs.promises.open.bind(fs.promises); const close = vi.fn(async () => {});
    const open = vi.spyOn(fs.promises, 'open').mockImplementationOnce(originalOpen).mockResolvedValueOnce({ read: vi.fn(async () => { throw new Error('read failed'); }), close } as any);
    await expect(w.readTraceChunk('close-error', { byteOffset: 0, eventIndex: 0, limit: 1 })).rejects.toThrow('read failed');
    expect(close).toHaveBeenCalledOnce(); open.mockRestore();
  });
});
