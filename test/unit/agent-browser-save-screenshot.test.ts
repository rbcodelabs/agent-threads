/**
 * browser_screenshot with `save`: the PNG the guest captured (overlay included,
 * maxWidth honoured) is written to the same per-thread scratch directory as
 * saved pages, with the same filename sanitising, unique prefix and retention.
 */
import { describe, expect, it, vi } from 'vitest';

import { ThreadBrowser, type SaveSink } from '../../src/agentBrowser/ThreadBrowser';
import { MAX_SAVED_FILES_PER_THREAD } from '../../src/agentBrowser/agentBrowserPolicy';
import { createFsSaveSink } from '../../src/agentBrowser/agentBrowserSaveSink';
import type { AgentBrowserPool } from '../../src/agentBrowser/AgentBrowserPool';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);

function setup(options: { bytesSink?: boolean; capture?: () => Promise<Uint8Array> } = {}) {
  const { bytesSink = true } = options;
  const files = new Map<string, Uint8Array | string>();
  const sink: SaveSink = {
    resolvePath: (threadId, name) => `/scratch/${threadId}/${name}`,
    write: async (path, chunk) => { files.set(path, chunk); },
    ...(bytesSink ? { writeBytes: async (path: string, bytes: Uint8Array) => { files.set(path, bytes); } } : {}),
    list: async (threadId) => [...files.keys()].filter((p) => p.startsWith(`/scratch/${threadId}/`)).sort(),
    remove: async (path) => { files.delete(path); },
    removeDir: async () => {},
  };
  const capture = vi.fn(options.capture ?? (async () => PNG));
  const pool = { acquire: async () => ({ capture }), destroyForThread: vi.fn(), peek: () => null, status: () => ({}) } as unknown as AgentBrowserPool;
  let clock = 1_000_000;
  const browser = new ThreadBrowser({ threadId: 't1', pool, saveSink: sink, nowMs: () => (clock += 1) });
  return { browser, files, capture };
}

describe('ThreadBrowser.screenshotAndSave', () => {
  it('writes the captured PNG bytes exactly and returns path and size', async () => {
    const { browser, files } = setup();
    const result = await browser.screenshotAndSave({ maxWidth: 640 });
    expect(files.get(result.path)).toEqual(PNG);
    expect(result.bytes).toBe(PNG.length);
    expect(result.path.startsWith('/scratch/t1/')).toBe(true);
    expect(result.path.endsWith('-screenshot.png')).toBe(true);
    expect(result.png).toBe(PNG);
  });

  it('honours maxWidth', async () => {
    const { browser, capture } = setup();
    await browser.screenshotAndSave({ maxWidth: 640 });
    expect(capture).toHaveBeenCalledWith(640);
  });

  it('sanitises the filename, forces a .png extension and stays inside the thread directory', async () => {
    const { browser } = setup();
    const result = await browser.screenshotAndSave({ filename: '../../etc/pass wd?.txt' });
    const name = result.path.slice('/scratch/t1/'.length);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).not.toContain('..');
    expect(name.endsWith('.png')).toBe(true);
    expect(name).not.toContain('.txt');
  });

  it('gives repeated saves distinct paths and keeps only the newest per thread', async () => {
    const { browser, files } = setup();
    const paths: string[] = [];
    for (let i = 0; i < MAX_SAVED_FILES_PER_THREAD + 3; i += 1) paths.push((await browser.screenshotAndSave({ filename: 's' })).path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(files.size).toBe(MAX_SAVED_FILES_PER_THREAD);
    expect(files.has(paths[0])).toBe(false);
    expect(files.has(paths[paths.length - 1])).toBe(true);
  });

  it('is unavailable without a binary-capable sink', async () => {
    expect(setup({ bytesSink: false }).browser.canSaveScreenshots).toBe(false);
    await expect(setup({ bytesSink: false }).browser.screenshotAndSave({})).rejects.toMatchObject({ code: 'capability_unavailable' });
  });

  it('writes nothing when the capture is refused (e.g. a person has taken over)', async () => {
    const { browser, files } = setup({ capture: async () => { throw new Error('user_in_control'); } });
    await expect(browser.screenshotAndSave({})).rejects.toThrow();
    expect(files.size).toBe(0);
  });
});

describe('createFsSaveSink.writeBytes', () => {
  it('writes binary data byte-exact under the scratch root', async () => {
    const fs = await import('fs');
    const sink = createFsSaveSink();
    const threadId = `shot-test-${process.pid}-${Date.now()}`;
    try {
      const path = sink.resolvePath(threadId, 'a.png');
      await sink.writeBytes!(path, PNG);
      expect(new Uint8Array(fs.readFileSync(path))).toEqual(PNG);
    } finally {
      await sink.removeDir(threadId);
    }
  });
});
