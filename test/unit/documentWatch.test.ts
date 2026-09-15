/**
 * documentWatch.test.ts
 *
 * Covers the pure helpers behind "Watch with active thread" / "Stop watching
 * this document": the file-type gate (reused from documentChat.ts) and the
 * menu label swap. No Obsidian/Node imports in the module under test, so this
 * runs without jsdom or a live vault.
 */
import { describe, it, expect } from 'vitest';
import {
  isWatchableDocument,
  watchMenuLabel,
  WATCH_DOCUMENT_LABEL,
  UNWATCH_DOCUMENT_LABEL,
} from '../../src/documentWatch';
import { isChattableDocument } from '../../src/documentChat';

describe('isWatchableDocument', () => {
  it('accepts markdown files', () => {
    expect(isWatchableDocument({ extension: 'md' })).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(isWatchableDocument({ extension: 'MD' })).toBe(true);
  });

  it('rejects non-markdown files', () => {
    expect(isWatchableDocument({ extension: 'pdf' })).toBe(false);
    expect(isWatchableDocument({ extension: 'png' })).toBe(false);
  });

  it('rejects folders (no extension) and null/undefined', () => {
    expect(isWatchableDocument({})).toBe(false);
    expect(isWatchableDocument(null)).toBe(false);
    expect(isWatchableDocument(undefined)).toBe(false);
  });

  it('is the same gate as isChattableDocument (single source of truth, no drift)', () => {
    expect(isWatchableDocument).toBe(isChattableDocument);
  });
});

describe('watchMenuLabel', () => {
  it('offers to start watching when not currently watched', () => {
    expect(watchMenuLabel(false)).toBe(WATCH_DOCUMENT_LABEL);
  });

  it('offers to stop watching when currently watched', () => {
    expect(watchMenuLabel(true)).toBe(UNWATCH_DOCUMENT_LABEL);
  });

  it('label constants are distinct and stable', () => {
    expect(WATCH_DOCUMENT_LABEL).toBe('Watch with active thread');
    expect(UNWATCH_DOCUMENT_LABEL).toBe('Stop watching this document');
  });
});
