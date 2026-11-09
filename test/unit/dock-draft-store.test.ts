/**
 * dock-draft-store.test.ts
 *
 * K2 P5: the Ask field draft is kept in memory only (drafts can hold secrets), capped, and shared by
 * dock instances through an injected store so a board re-mount keeps it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDraftStore, windowDraftStore, MAX_DRAFT_CHARS } from '../../src/dockDraftStore';

describe('DraftStore', () => {
  it('starts empty, returns what was set, clears', () => {
    const s = createDraftStore();
    expect(s.get()).toBe('');
    s.set('hello');
    expect(s.get()).toBe('hello');
    s.clear();
    expect(s.get()).toBe('');
  });

  it('caps the stored length', () => {
    const s = createDraftStore();
    s.set('x'.repeat(MAX_DRAFT_CHARS + 500));
    expect(s.get()).toHaveLength(MAX_DRAFT_CHARS);
  });

  it('stores are independent; the window store is one shared instance', () => {
    const a = createDraftStore();
    const b = createDraftStore();
    a.set('only a');
    expect(b.get()).toBe('');
    windowDraftStore.set('shared');
    expect(windowDraftStore.get()).toBe('shared');
    windowDraftStore.clear();
  });

  it('is keyed: a draft written for one orchestrator thread is invisible to another', () => {
    const s = createDraftStore();
    s.set('for a', 'a');
    expect(s.get('a')).toBe('for a');
    expect(s.get('b')).toBe('');
  });

  it('version bumps on every set and clear (a stale writer can tell the store changed under it)', () => {
    const s = createDraftStore();
    const v0 = s.version;
    s.set('x', 'k');
    const v1 = s.version;
    expect(v1).toBeGreaterThan(v0);
    s.clear();
    expect(s.version).toBeGreaterThan(v1);
  });

  it('is memory only: the module touches no storage, file system, settings or network', () => {
    const src = readFileSync('src/dockDraftStore.ts', 'utf8');
    for (const banned of [/localStorage/, /sessionStorage/, /indexedDB/, /require\(['"]fs/, /from ['"](?:node:)?fs/, /saveData|saveSettings|writeFile|fetch\(/]) {
      expect(src).not.toMatch(banned);
    }
  });
});
