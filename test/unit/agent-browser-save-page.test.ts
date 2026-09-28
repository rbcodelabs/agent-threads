// @vitest-environment jsdom
/**
 * browser_save_page: the page is stashed inside the guest, moved to the host in
 * bounded chunks, and written through an injected sink.
 *
 * The guest here is a real one in the sense that matters: it evaluates the
 * emitted scripts against a jsdom document, so chunking, surrogate handling and
 * stash release are exercised on the real source rather than a mock of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThreadBrowser, sanitizeSaveFilename, type SaveSink } from '../../src/agentBrowser/ThreadBrowser';
import { buildStashScript, type RawStashMeta } from '../../src/agentBrowser/agentBrowserScript';
import {
  MAX_SAVED_FILES_PER_THREAD,
  MAX_SAVE_CHARS,
  SAVE_CHUNK_CHARS,
} from '../../src/agentBrowser/agentBrowserPolicy';
import { AgentBrowserError } from '../../src/agentBrowser/agentBrowserErrors';
import { createFsSaveSink as createFsSaveSinkSync, saveRootDir } from '../../src/agentBrowser/agentBrowserSaveSink';
import type { AgentBrowserPool } from '../../src/agentBrowser/AgentBrowserPool';

/** In-memory sink recording every write, so tests can assert on chunking. */
function memorySink() {
  const files = new Map<string, string>();
  const writes: Array<{ path: string; length: number; append: boolean }> = [];
  const removedDirs: string[] = [];
  const sink: SaveSink = {
    resolvePath: (threadId, name) => `/scratch/${threadId}/${name}`,
    write: async (path, chunk, append) => {
      writes.push({ path, length: chunk.length, append });
      files.set(path, (append ? (files.get(path) ?? '') : '') + chunk);
    },
    list: async (threadId) => [...files.keys()].filter((p) => p.startsWith(`/scratch/${threadId}/`)).sort(),
    remove: async (path) => {
      files.delete(path);
    },
    removeDir: async (threadId) => {
      removedDirs.push(threadId);
      for (const p of [...files.keys()]) if (p.startsWith(`/scratch/${threadId}/`)) files.delete(p);
    },
  };
  return { sink, files, writes, removedDirs };
}

type RunScript = (code: string) => Promise<unknown>;

function browserWith(options: { sink?: SaveSink; runScript?: RunScript }) {
  const scripts: string[] = [];
  const evaluate: RunScript = async (code) => {
    // eslint-disable-next-line no-eval
    return eval(code);
  };
  const impl = options.runScript ?? evaluate;
  const guest = {
    runScript: vi.fn(async (code: string) => {
      scripts.push(code);
      return impl(code);
    }),
  };
  const pool = {
    acquire: async () => guest,
    destroyForThread: vi.fn(),
    peek: () => null,
    status: () => ({}),
  } as unknown as AgentBrowserPool;
  let clock = 1_000_000;
  const browser = new ThreadBrowser({
    threadId: 't1',
    pool,
    saveSink: options.sink,
    nowMs: () => (clock += 1),
  });
  return { browser, guest, scripts, pool };
}

/** No stash key may survive a save, however it ended. */
function leakedStashKeys(): string[] {
  return Object.keys(window).filter((k) => k.startsWith('__ctAgentBrowserSave_'));
}

beforeEach(() => {
  document.body.innerHTML = '<h1>Title</h1><p>Some visible prose.</p>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  for (const key of leakedStashKeys()) delete (window as unknown as Record<string, unknown>)[key];
});

function pretendDocumentIs(contentType: string): void {
  vi.spyOn(document, 'contentType', 'get').mockReturnValue(contentType);
}

describe('savePage', () => {
  it('reassembles a multi-chunk document byte-exact, including astral characters at a chunk boundary', async () => {
    pretendDocumentIs('application/json');
    // The emoji straddles the first chunk boundary: its high surrogate would be
    // the last code unit of a naive slice, and UTF-8 encoding it alone corrupts it.
    const raw =
      '{"a":"' +
      'x'.repeat(SAVE_CHUNK_CHARS - 6) +
      '\u{1F600}' +
      'é'.repeat(SAVE_CHUNK_CHARS) +
      '\u{1F680}' +
      'y'.repeat(1234) +
      '"}';
    document.body.innerHTML = '';
    const pre = document.createElement('pre');
    pre.textContent = raw;
    document.body.appendChild(pre);

    const { sink, files, writes } = memorySink();
    const { browser } = browserWith({ sink });
    const result = await browser.savePage();

    const saved = files.get(result.path);
    expect(saved).toBe(raw);
    expect(result.chars).toBe(raw.length);
    expect(result.bytes).toBe(new TextEncoder().encode(raw).length);
    expect(result.contentType).toBe('application/json');
    expect(result.truncated).toBe(false);
    expect(result.path.endsWith('.json')).toBe(true);
    // More than two chunks, the first creating the file and the rest appending.
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes[0].append).toBe(false);
    expect(writes.slice(1).every((w) => w.append)).toBe(true);
    expect(writes.every((w) => w.length <= SAVE_CHUNK_CHARS)).toBe(true);
    // Still parses: the file is pure content with no header.
    expect(() => JSON.parse(saved!)).not.toThrow();
    expect(leakedStashKeys()).toEqual([]);
  });

  it('saves the visible text of an ordinary page and omits hidden text', async () => {
    document.body.innerHTML = '<p>Shown</p><p style="display:none">Hidden</p>';
    const { sink, files } = memorySink();
    const { browser } = browserWith({ sink });
    const result = await browser.savePage({ format: 'text' });
    expect(files.get(result.path)).toBe('Shown');
    expect(result.path.endsWith('.txt')).toBe(true);
    expect(result.note).toMatch(/untrusted/i);
  });

  it('saves the document HTML when asked', async () => {
    const { sink, files } = memorySink();
    const { browser } = browserWith({ sink });
    const result = await browser.savePage({ format: 'html' });
    const saved = files.get(result.path)!;
    expect(saved).toBe(document.documentElement.outerHTML);
    expect(saved).toContain('<h1>Title</h1>');
    expect(result.path.endsWith('.html')).toBe(true);
  });

  it('writes an empty file for an empty page', async () => {
    document.body.innerHTML = '';
    const { sink, files } = memorySink();
    const { browser } = browserWith({ sink });
    const result = await browser.savePage();
    expect(files.get(result.path)).toBe('');
    expect(result.chars).toBe(0);
    expect(result.bytes).toBe(0);
  });

  it('caps the guest-side stash at maxChars and reports truncation', () => {
    pretendDocumentIs('text/plain');
    document.body.innerHTML = '<pre>' + 'z'.repeat(5000) + '</pre>';
    const key = '__ctAgentBrowserSave_direct';
    // eslint-disable-next-line no-eval
    const meta = eval(buildStashScript(key, 'text', 1000)) as RawStashMeta;
    expect(meta.length).toBe(1000);
    expect(meta.truncated).toBe(true);
    expect((window as unknown as Record<string, string>)[key]).toHaveLength(1000);
    delete (window as unknown as Record<string, unknown>)[key];
  });

  it('never writes past the ceiling even if the guest claims more, and reports truncated', async () => {
    const chunkSizes: number[] = [];
    const runScript: RunScript = async (code) => {
      if (code.includes('contentType')) {
        return { url: 'https://x.test/', title: '', origin: 'https://x.test', contentType: 'text/plain', length: MAX_SAVE_CHARS + 500, truncated: false };
      }
      const match = /var start = (\d+);\s*var end = Math\.min\(start \+ (\d+)/.exec(code);
      if (match) {
        const size = Number(match[2]);
        chunkSizes.push(size);
        return 'a'.repeat(size);
      }
      return true;
    };
    const { sink, files } = memorySink();
    const { browser } = browserWith({ sink, runScript });
    const result = await browser.savePage();
    expect(result.chars).toBe(MAX_SAVE_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/ceiling/i);
    expect(files.get(result.path)).toHaveLength(MAX_SAVE_CHARS);
    expect(chunkSizes.reduce((a, b) => a + b, 0)).toBe(MAX_SAVE_CHARS);
  });

  it('releases the stash after a successful save', async () => {
    const { sink } = memorySink();
    const { browser, scripts } = browserWith({ sink });
    await browser.savePage();
    expect(scripts[scripts.length - 1]).toContain('delete window[');
    expect(leakedStashKeys()).toEqual([]);
  });

  it('releases the stash and removes the partial file when a chunk fails', async () => {
    document.body.innerHTML = '<p>' + 'k'.repeat(600) + '</p>';
    const { sink, files } = memorySink();
    let calls = 0;
    const runScript: RunScript = async (code) => {
      if (code.includes('content.slice(start, end)')) {
        calls += 1;
        throw new AgentBrowserError({ code: 'script_timeout', message: 'timed out', retryable: true });
      }
      // eslint-disable-next-line no-eval
      return eval(code);
    };
    const { browser, scripts } = browserWith({ sink, runScript });

    await expect(browser.savePage()).rejects.toMatchObject({ code: 'script_timeout' });

    expect(calls).toBe(1);
    expect(scripts[scripts.length - 1]).toContain('delete window[');
    expect(leakedStashKeys()).toEqual([]);
    expect(files.size).toBe(0);
  });

  it('fails with stale_snapshot when the stash vanishes mid-save (page navigated)', async () => {
    const runScript: RunScript = async (code) => {
      if (code.includes('contentType')) {
        return { url: 'https://x.test/', title: '', origin: 'https://x.test', contentType: 'text/html', length: 10, truncated: false };
      }
      if (code.includes('content.slice(start, end)')) return null;
      return true;
    };
    const { sink, files } = memorySink();
    const { browser } = browserWith({ sink, runScript });
    await expect(browser.savePage()).rejects.toMatchObject({ code: 'stale_snapshot' });
    expect(files.size).toBe(0);
  });

  it('is unavailable without a sink', async () => {
    const { browser } = browserWith({});
    expect(browser.canSavePages).toBe(false);
    await expect(browser.savePage()).rejects.toMatchObject({ code: 'capability_unavailable' });
  });

  it('sanitizes the requested filename and keeps it inside the thread directory', async () => {
    const { sink, files } = memorySink();
    const { browser } = browserWith({ sink });
    const result = await browser.savePage({ filename: '../../etc/pass wd?.json' });
    expect(result.path.startsWith('/scratch/t1/')).toBe(true);
    const name = result.path.slice('/scratch/t1/'.length);
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name.endsWith('-_._etc_pass_wd_.json')).toBe(true);
    expect(files.has(result.path)).toBe(true);
  });

  it('keeps only the newest files per thread', async () => {
    const { sink, files } = memorySink();
    const { browser } = browserWith({ sink });
    const paths: string[] = [];
    for (let i = 0; i < MAX_SAVED_FILES_PER_THREAD + 5; i += 1) {
      paths.push((await browser.savePage({ filename: 'p' })).path);
    }
    expect(files.size).toBe(MAX_SAVED_FILES_PER_THREAD);
    // The oldest five are gone; the newest survive.
    for (const gone of paths.slice(0, 5)) expect(files.has(gone)).toBe(false);
    for (const kept of paths.slice(5)) expect(files.has(kept)).toBe(true);
  });

  it('gives repeated saves distinct paths', async () => {
    const { sink } = memorySink();
    const { browser } = browserWith({ sink });
    const a = await browser.savePage({ filename: 'same' });
    const b = await browser.savePage({ filename: 'same' });
    expect(a.path).not.toBe(b.path);
  });

  it('removes the thread scratch directory when the browser is closed', async () => {
    const { sink, removedDirs } = memorySink();
    const { browser, pool } = browserWith({ sink });
    browser.close();
    await Promise.resolve();
    expect(pool.destroyForThread).toHaveBeenCalledWith('t1', 'tool');
    expect(removedDirs).toEqual(['t1']);
  });
});

describe('sanitizeSaveFilename', () => {
  it('replaces unsafe characters, strips leading dots, and falls back when empty', () => {
    expect(sanitizeSaveFilename('a b/c\\d:e', 'page')).toBe('a_b_c_d_e');
    expect(sanitizeSaveFilename('...hidden', 'page')).toBe('hidden');
    expect(sanitizeSaveFilename('', 'page')).toBe('page');
    expect(sanitizeSaveFilename(undefined, 'page')).toBe('page');
    expect(sanitizeSaveFilename('....', 'page')).toBe('page');
    expect(sanitizeSaveFilename('x'.repeat(500), 'page')).toHaveLength(80);
  });
});

describe('createFsSaveSink', () => {
  it('writes, appends, lists oldest-first, removes files, and deletes the thread directory', async () => {
    const fs = await import('fs');
    const sink = createFsSaveSinkSync();
    const threadId = `test-thread-${process.pid}-${Date.now()}`;
    try {
      const b = sink.resolvePath(threadId, 'b.txt');
      const a = sink.resolvePath(threadId, 'a.txt');
      await sink.write(b, 'he', false);
      await sink.write(b, 'llo \u{1F600}', true);
      await sink.write(a, 'x', false);
      expect(fs.readFileSync(b, 'utf8')).toBe('hello \u{1F600}');
      expect(b.startsWith(saveRootDir())).toBe(true);
      expect(await sink.list(threadId)).toEqual([a, b]);
      await sink.remove(a);
      await sink.remove(a); // already gone: not an error
      expect(await sink.list(threadId)).toEqual([b]);
    } finally {
      await sink.removeDir(threadId);
    }
    expect(await sink.list(threadId)).toEqual([]);
    expect(fs.existsSync(sink.resolvePath(threadId, 'b.txt'))).toBe(false);
  });

  it('cannot be steered outside the scratch root by a hostile thread id', () => {
    const sink = createFsSaveSinkSync();
    const p = sink.resolvePath('../../etc', 'x.txt');
    // One path segment under the scratch root, whatever the id contains.
    expect(require('path').dirname(require('path').dirname(p))).toBe(saveRootDir());
  });
});
