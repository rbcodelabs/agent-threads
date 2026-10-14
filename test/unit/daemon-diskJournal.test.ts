import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiskJournal } from '../../daemon/diskJournal';
import { InMemoryJournal, wireJournalPolicy, type WireEvent } from '../../src/protocol';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dj-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const tok = (t: string): WireEvent => ({ name: 'onToken', args: [t] });
const msg = (t: string): WireEvent => ({ name: 'onMessage', args: [t, []] });
const done: WireEvent = { name: 'onDone', args: ['s', 0, 1] };
const open = (dir: string, extra = {}) => DiskJournal.open<WireEvent>(dir, 'th', wireJournalPolicy, { epoch: 'e1', flushMs: 5, ...extra });

describe('InMemoryJournal.restore', () => {
  it('rebuilds entries, checkpoint fold and numbering', () => {
    const src = new InMemoryJournal<WireEvent>(wireJournalPolicy);
    src.append(tok('a')); src.append(tok('b'));
    const entries = (src.replay(0) as { entries: never[] }).entries;
    const j = new InMemoryJournal<WireEvent>(wireJournalPolicy);
    j.restore(entries, { lastSeq: 2, lowWater: 0 });
    expect(j.checkpoint().inFlightText).toBe('ab');
    expect(j.append(tok('c')).seq).toBe(3);
  });

  it('drops entries at or below lowWater and refuses a non-empty journal', () => {
    const j = new InMemoryJournal<WireEvent>(wireJournalPolicy);
    j.restore([{ seq: 1, ts: 1, event: tok('a') }, { seq: 2, ts: 2, event: tok('b') }], { lastSeq: 2, lowWater: 1 });
    expect(j.size).toBe(1);
    expect(j.replay(0).kind).toBe('resync');
    expect(() => j.restore([], { lastSeq: 0, lowWater: 0 })).toThrow();
  });
});

describe('DiskJournal', () => {
  it('survives close/reopen with identical replay, ack and next seq', () => {
    const dir = tmp();
    const a = open(dir);
    a.append(tok('x')); a.append(msg('x')); a.append(done);
    a.ack(3);
    a.close();
    const b = open(dir);
    expect(b.lastSeq).toBe(3);
    expect(b.ackedSeq).toBe(3);
    expect(b.replay(0)).toMatchObject({ kind: 'entries', lastSeq: 3 });
    expect(b.append(tok('y')).seq).toBe(4);
    b.close();
  });

  it('flushes boundary events immediately (visible to a second reader without waiting 50 ms)', () => {
    const dir = tmp();
    const a = open(dir, { flushMs: 60_000, isBoundary: (e: WireEvent) => e.name === 'onDone' });
    a.append(tok('x'));
    expect(statSync(a.path, { throwIfNoEntry: false })?.size ?? 0).toBe(0); // batched, not yet written
    a.append(done);
    const lines = readFileSync(a.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    a.abandon();
  });

  it('batches: a crash (abandon) loses at most the unflushed tail, never corrupts', () => {
    const dir = tmp();
    const a = open(dir, { flushMs: 60_000, isBoundary: (e: WireEvent) => e.name === 'onDone' });
    a.append(tok('1')); a.append(done); a.append(tok('2')); // '2' is only buffered
    a.abandon();
    const b = open(dir);
    expect(b.lastSeq).toBe(2);
    b.close();
  });

  it('discards a torn tail and truncates the file', () => {
    const dir = tmp();
    const a = open(dir);
    a.append(tok('1')); a.append(tok('2'));
    a.close();
    const size = statSync(a.path).size;
    appendFileSync(a.path, '{"seq":3,"ts":1,"event":{"name":"onTok');
    const b = open(dir);
    expect(b.lastSeq).toBe(2);
    expect(statSync(b.path).size).toBe(size);
    b.close();
  });

  it('stops at a non-monotonic or corrupt record instead of trusting what follows', () => {
    const dir = tmp();
    const a = open(dir);
    a.append(tok('1'));
    a.close();
    appendFileSync(a.path, 'garbage\n{"seq":2,"ts":1,"event":{"name":"onToken","args":["z"]}}\n');
    const b = open(dir);
    expect(b.lastSeq).toBe(1);
    b.close();
  });

  it('rewrites the file on compaction and keeps seq numbering across reopen', () => {
    const dir = tmp();
    const a = open(dir);
    for (let i = 0; i < 50; i++) a.append(tok('t'.repeat(100)));
    a.append(msg('m')); a.append(done);
    a.flush(true);
    const before = statSync(a.path).size;
    a.ack(a.lastSeq);
    expect(a.compact().removed).toBe(50);
    expect(statSync(a.path).size).toBeLessThan(before / 10);
    a.close();
    const b = open(dir);
    expect(b.lastSeq).toBe(52);
    expect(b.append(tok('n')).seq).toBe(53);
    b.close();
  });

  it('eviction raises lowWater durably: cursors below it resync after reopen', () => {
    const dir = tmp();
    const a = open(dir, { maxEntries: 3 });
    for (let i = 0; i < 10; i++) a.append({ name: 'onRecap', args: [`r${i}`] });
    expect(a.lowWater).toBe(7);
    a.close();
    const b = open(dir, { maxEntries: 3 });
    expect(b.lowWater).toBe(7);
    expect(b.replay(2).kind).toBe('resync');
    expect(b.replay(7)).toMatchObject({ kind: 'entries' });
    expect(readFileSync(b.path, 'utf8').trim().split('\n')).toHaveLength(3);
    b.close();
  });

  it('notifies subscribers synchronously and stops after unsubscribe', () => {
    const dir = tmp();
    const j = open(dir);
    const seen: number[] = [];
    const off = j.subscribe((e) => seen.push(e.seq));
    j.append(tok('a'));
    off();
    j.append(tok('b'));
    expect(seen).toEqual([1]);
    j.close();
  });
});
