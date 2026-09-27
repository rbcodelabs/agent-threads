import { describe, expect, it, vi } from 'vitest';
import { CodexSession } from '../../src/CodexSession';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RawLogWriter } from '../../src/RawLogWriter';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

function fixture(raw = vi.fn()) {
  const session = new CodexSession('codex');
  const internal = session as any;
  internal.options = { callbacks: { onRawEvent: raw, onToolUse: vi.fn(), onToolResult: vi.fn(), onDone: vi.fn(), onInterrupted: vi.fn(), onError: vi.fn() } };
  internal.codexThreadId = 'root';
  const send = (method: string, params: object) => internal.handle({ method, params });
  return { session, internal, raw, send };
}
const ids = { threadId: 'root', turnId: 'turn', itemId: 'cmd' };

describe('Codex log compaction', () => {
  it('retains only the final diff and complete command output from thousands of updates', () => {
    const { send, raw } = fixture();
    for (let i = 0; i < 1000; i++) {
      send('turn/diff/updated', { ...ids, diff: `diff ${i}` });
      send('item/commandExecution/outputDelta', { ...ids, delta: 'x' });
    }
    const item = { type: 'commandExecution', id: 'cmd', aggregatedOutput: 'x'.repeat(1000), exitCode: 0 };
    send('item/completed', { ...ids, item });
    send('turn/completed', { threadId: 'root', turn: { id: 'turn', status: 'completed' } });
    expect(raw.mock.calls.map(([e]) => e.type)).toEqual(['item/completed', 'turn/diff/updated', 'turn/completed']);
    expect(raw.mock.calls[0][0].params.item).toBe(item);
    expect(raw.mock.calls[1][0].params.diff).toBe('diff 999');
  });

  it('preserves a bounded UTF-8 diagnostic tail when completion output is truncated', () => {
    const { send, raw } = fixture();
    send('item/commandExecution/outputDelta', { ...ids, delta: '🙂'.repeat(20000) });
    send('item/completed', { ...ids, item: { type: 'commandExecution', id: 'cmd', aggregatedOutput: 'truncated' } });
    const summary = raw.mock.calls[0][0];
    expect(summary.type).toBe('codex/log/compacted');
    expect(summary.params).toMatchObject({ ...ids, originalBytes: 80000, retainedBytes: 65536, omittedBytes: 14464 });
    expect(summary.params.tail).not.toContain('�');
    expect(raw.mock.calls[1][0].type).toBe('item/completed');
  });

  it('keeps omission counts even when a truncated completed aggregate contains the retained tail', () => {
    const { send, raw } = fixture();
    send('item/commandExecution/outputDelta', { ...ids, delta: 'x'.repeat(80000) });
    send('item/completed', { ...ids, item: { type: 'commandExecution', id: 'cmd', aggregatedOutput: 'x'.repeat(65536) } });
    expect(raw.mock.calls[0][0].params.omittedBytes).toBe(14464);
    expect(raw.mock.calls[1][0].type).toBe('item/completed');
  });

  it('flushes interrupted children independently and flushes unfinished diagnostics on close', () => {
    const { send, raw, session } = fixture();
    send('turn/diff/updated', { ...ids, diff: 'root diff' });
    send('turn/diff/updated', { ...ids, threadId: 'child', diff: 'child diff' });
    send('item/plan/delta', { ...ids, delta: 'unfinished plan' });
    send('turn/completed', { threadId: 'child', turn: { id: 'turn', status: 'interrupted' } });
    expect(raw.mock.calls.map(([e]) => e.params.diff).filter(Boolean)).toEqual(['child diff']);
    session.close();
    expect(raw.mock.calls.map(([e]) => e.params.diff).filter(Boolean)).toEqual(['child diff', 'root diff']);
    expect(raw.mock.calls.at(-1)![0].params.tail).toBe('unfinished plan');
    const count = raw.mock.calls.length;
    session.close();
    expect(raw).toHaveBeenCalledTimes(count);
  });

  it('forwards malformed identities without grouping unrelated events', () => {
    const { send, raw } = fixture();
    send('turn/diff/updated', { diff: 'no identity' });
    send('item/commandExecution/outputDelta', { delta: 'no identity' });
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('bounds retention across unfinished items by flushing older diagnostics', () => {
    const { send, raw, session } = fixture();
    for (let i = 0; i < 300; i++) send('item/commandExecution/outputDelta', { ...ids, itemId: `cmd-${i}`, delta: 'x' });
    expect(raw.mock.calls.length).toBeGreaterThan(0);
    expect(raw.mock.calls.every(([e]) => e.type === 'codex/log/compacted')).toBe(true);
    session.close();
    expect(raw).toHaveBeenCalledTimes(300);
  });
  it('does not retain events when raw logging is disabled', () => {
    const { send, internal, session } = fixture();
    internal.options.callbacks.onRawEvent = undefined;
    for (let i = 0; i < 300; i++) send('turn/diff/updated', { ...ids, diff: 'pending' });
    const raw = vi.fn();
    internal.options.callbacks.onRawEvent = raw;
    session.close();
    expect(raw).not.toHaveBeenCalled();
  });

  it('preserves final plans and flushes on process errors', () => {
    const { send, raw, internal } = fixture();
    send('item/plan/delta', { ...ids, delta: 'final plan' });
    send('item/completed', { ...ids, item: { type: 'plan', id: 'cmd', text: 'final plan' } });
    expect(raw.mock.calls.map(([e]) => e.type)).toEqual(['item/completed']);
    send('item/commandExecution/outputDelta', { ...ids, delta: 'error detail' });
    internal.failAll(new Error('process failed'));
    expect(raw.mock.calls.at(-1)![0].params.tail).toBe('error detail');
  });

  it('flushes oldest entries when pending payload exceeds 4 MiB', () => {
    const { send, raw, session } = fixture();
    for (let i = 0; i < 80; i++) send('item/commandExecution/outputDelta', { ...ids, itemId: `cmd-${i}`, delta: 'x'.repeat(65536) });
    expect(raw).toHaveBeenCalledTimes(16);
    expect(raw.mock.calls[0][0].params.reason).toBe('buffer-limit');
    session.close();
    expect(raw).toHaveBeenCalledTimes(80);
  });

  it('coalesces oversized diffs into a bounded final snapshot with omission metadata', () => {
    const { send, raw, session } = fixture();
    for (let i = 0; i < 4; i++) send('turn/diff/updated', { ...ids, diff: 'x'.repeat(5 * 1024 * 1024) + i });
    expect(raw).not.toHaveBeenCalled();
    session.close();
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0][0].params).toMatchObject({ source: 'turn/diff/updated', originalBytes: 5242881, retainedBytes: 524288, omittedBytes: 4718593 });
    expect(raw.mock.calls[0][0].params.tail).toMatch(/3$/);
  });

  it('isolates replacement sessions from old process data, errors, and exits', () => {
    const { session, internal, send, raw } = fixture();
    const makeChild = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write: vi.fn() }, kill: vi.fn() });
    const oldChild = makeChild();
    const newChild = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(oldChild as any).mockReturnValueOnce(newChild as any);
    vi.spyOn(internal, 'request').mockImplementation(() => new Promise(() => {}));
    const options = { ...internal.options, extraEnvRaw: '' };
    void session.start(options);
    send('turn/diff/updated', { ...ids, diff: 'old diff' });
    void session.start(options);
    expect(raw.mock.calls.at(-1)![0].params.diff).toBe('old diff');
    send('turn/diff/updated', { ...ids, diff: 'new diff' });
    oldChild.stdout.emit('data', Buffer.from(JSON.stringify({ method: 'turn/diff/updated', params: { ...ids, diff: 'stale' } }) + '\n'));
    oldChild.emit('error', new Error('old failure'));
    oldChild.emit('exit', 1);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(internal.closed).toBe(false);
    newChild.emit('exit', 0);
    expect(raw.mock.calls.at(-1)![0].params.diff).toBe('new diff');
    expect(internal.closed).toBe(true);
    newChild.stdout.emit('data', Buffer.from(JSON.stringify({ method: 'item/commandExecution/outputDelta', params: { ...ids, delta: 'last pipe bytes' } }) + '\n'));
    newChild.emit('close', 0);
    expect(raw.mock.calls.at(-1)![0].params.tail).toBe('last pipe bytes');
  });

  it('writes valid compact JSONL to disk with over 99 percent less repeated payload', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-test-'));
    try {
      const writer = new RawLogWriter(() => dir, () => 'Claude');
      const { send, session } = fixture(vi.fn((event) => writer.append('root', 'session', event.type, event)));
      let originalBytes = 0;
      for (let i = 0; i < 1000; i++) {
        const params = { ...ids, diff: 'x'.repeat(10000) + i };
        originalBytes += Buffer.byteLength(JSON.stringify({ method: 'turn/diff/updated', params }));
        send('turn/diff/updated', params);
      }
      session.close();
      await writer.flushAll();
      const content = await fs.readFile(path.join(dir, writer.vaultRelativePath('root')), 'utf8');
      const lines = content.trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(1);
      expect(lines[0].event.params.diff).toMatch(/999$/);
      expect(Buffer.byteLength(content)).toBeLessThan(originalBytes / 100);
      const read = await writer.read('root', { limit: 0 });
      expect(read?.entries).toEqual(lines);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
