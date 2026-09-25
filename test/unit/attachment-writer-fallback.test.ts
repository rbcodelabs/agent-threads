/**
 * Regression tests for AttachmentWriter's host-write fallback ladder.
 *
 * The bug these exist to catch: the plugin runs inside Geode as well as
 * Obsidian, and Geode's `FileSystemAdapter` shim implements only
 * `getBasePath` / `getName` / `getResourcePath` / `exists`. The old code
 * passed its `instanceof FileSystemAdapter` guard there, then called
 * `adapter.mkdir(...)`, which is `undefined` under Geode, so a TypeError
 * unwound out of `write()`, the catch swallowed it, and it returned null. Every
 * pasted image and every tool-result image silently stayed inline as base64 in
 * data.json, which is exactly the bloat ADR-0003 removed.
 *
 * So each rung is asserted independently, plus the "no rung available" case
 * that must return null rather than throw into the session hot path.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { FileSystemAdapter, TFile } from 'obsidian';
import type { App } from 'obsidian';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AttachmentWriter } from '../../src/AttachmentWriter';

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]).toString('base64');
const EXPECTED_REL = 'Claude/attachments/thread-1/msg-1-0.png';

const tempRoots: string[] = [];
function makeTempVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-writer-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

/**
 * A `FileSystemAdapter` instance (so the `instanceof` desktop guard passes)
 * carrying only the methods a given host actually implements.
 */
function makeAdapter(methods: Record<string, unknown>): unknown {
  // Object.create keeps `instanceof FileSystemAdapter` true (the desktop guard)
  // while letting each test declare exactly which methods the host implements.
  // The inherited getBasePath/getResourcePath are shadowed to undefined so the
  // obsidian mock's own stubs cannot leak in and mask a missing capability.
  const adapter = Object.create(FileSystemAdapter.prototype) as Record<string, unknown>;
  adapter.getBasePath = undefined;
  adapter.getResourcePath = undefined;
  return Object.assign(adapter, methods);
}

function makeApp(vault: Record<string, unknown>, adapter: unknown): App {
  return { vault: { adapter, ...vault } } as unknown as App;
}

/** An in-memory directory tree backing exists()/mkdir() pairs. */
function makeDirTree() {
  const dirs = new Set<string>();
  return {
    dirs,
    exists: vi.fn(async (p: string) => dirs.has(p)),
    mkdir: vi.fn(async (p: string) => { dirs.add(p); }),
  };
}

function writerFor(app: App, hostWindow: Record<string, unknown> = {}) {
  return new AttachmentWriter(() => app, () => 'Claude', () => hostWindow);
}

describe('AttachmentWriter fallback ladder', () => {
  it('rung 2: uses the Obsidian vault API when it is present and no host bridge exists', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const modifyBinary = vi.fn(async () => {});
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp({ getAbstractFileByPath: () => null, createBinary, modifyBinary }, adapter);

    const result = await writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64);

    expect(result).toBe(EXPECTED_REL);
    expect(createBinary).toHaveBeenCalledTimes(1);
    expect(createBinary.mock.calls[0]![0]).toBe(EXPECTED_REL);
    expect(Buffer.from(createBinary.mock.calls[0]![1] as ArrayBuffer).toString('base64')).toBe(PNG_BASE64);
    expect(modifyBinary).not.toHaveBeenCalled();
    // Every ancestor was created, not just the leaf.
    expect([...tree.dirs]).toEqual(['Claude', 'Claude/attachments', 'Claude/attachments/thread-1']);
  });

  it('rung 2: overwrites an existing cached file through modifyBinary rather than createBinary', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const modifyBinary = vi.fn(async () => {});
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp(
      { getAbstractFileByPath: (p: string) => (p === EXPECTED_REL ? new TFile(p) : null), createBinary, modifyBinary },
      adapter,
    );

    await expect(writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64)).resolves.toBe(EXPECTED_REL);
    expect(modifyBinary).toHaveBeenCalledTimes(1);
    expect(createBinary).not.toHaveBeenCalled();
  });

  it('rung 1: uses window.geode.writeBinary when the vault API is absent', async () => {
    // Geode's real shim: exists() but no mkdir, no createBinary, no writeBinary.
    const adapter = makeAdapter({ exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);
    const writeBinary = vi.fn(async () => {});

    const result = await writerFor(app, { geode: { writeBinary } })
      .write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64);

    expect(result).toBe(EXPECTED_REL);
    expect(writeBinary).toHaveBeenCalledTimes(1);
    const [calledPath, calledData] = writeBinary.mock.calls[0] as unknown as [string, unknown];
    expect(calledPath).toBe(EXPECTED_REL);
    expect(calledData).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(calledData as ArrayBuffer).toString('base64')).toBe(PNG_BASE64);
  });

  it('rung 1 wins over rung 2: the host bridge is preferred whenever it exists', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp({ getAbstractFileByPath: () => null, createBinary }, adapter);
    const writeBinary = vi.fn(async () => {});

    await expect(
      writerFor(app, { geode: { writeBinary } }).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBe(EXPECTED_REL);

    expect(writeBinary).toHaveBeenCalledTimes(1);
    expect(createBinary).not.toHaveBeenCalled();
  });

  it('ignores a window.geode that exists but has no writeBinary, falling through to rung 2', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp({ getAbstractFileByPath: () => null, createBinary }, adapter);

    await expect(
      writerFor(app, { geode: { acquirePowerSaveBlocker: () => {} } })
        .write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBe(EXPECTED_REL);
    expect(createBinary).toHaveBeenCalledTimes(1);
  });

  it('rung 3: falls back to fs when both the host bridge and the vault API are absent', async () => {
    // This is the live Geode shape today: exists() and getBasePath(), nothing else.
    const root = makeTempVault();
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    const result = await writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64);

    expect(result).toBe(EXPECTED_REL);
    const abs = path.join(root, EXPECTED_REL);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs).toString('base64')).toBe(PNG_BASE64);
  });

  it('rung 3: also catches a vault API that exists but throws', async () => {
    const root = makeTempVault();
    const tree = makeDirTree();
    const adapter = makeAdapter({ getBasePath: () => root, exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp(
      {
        getAbstractFileByPath: () => null,
        createBinary: vi.fn(async () => { throw new Error('createBinary exploded'); }),
      },
      adapter,
    );

    await expect(writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64))
      .resolves.toBe(EXPECTED_REL);
    expect(fs.readFileSync(path.join(root, EXPECTED_REL)).toString('base64')).toBe(PNG_BASE64);
  });

  it('rung 1 failure degrades to a lower rung instead of aborting the write', async () => {
    const root = makeTempVault();
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);
    const writeBinary = vi.fn(async () => { throw new Error('IPC channel not registered'); });

    await expect(
      writerFor(app, { geode: { writeBinary } }).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBe(EXPECTED_REL);
    expect(fs.existsSync(path.join(root, EXPECTED_REL))).toBe(true);
  });

  it('returns null without throwing when no rung is available', async () => {
    // No geode bridge, no vault binary methods, no usable vault root.
    const adapter = makeAdapter({ exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    await expect(writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64)).resolves.toBeNull();
  });

  it('returns null off desktop without consulting any rung', async () => {
    const writeBinary = vi.fn(async () => {});
    // A plain-object adapter fails the `instanceof FileSystemAdapter` guard.
    const app = makeApp({ getAbstractFileByPath: () => null }, { getBasePath: () => '/x' });

    await expect(
      writerFor(app, { geode: { writeBinary } }).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBeNull();
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it('ensureDir prefers vault.createFolder when the adapter has no mkdir', async () => {
    const tree = makeDirTree();
    const createFolder = vi.fn(async (p: string) => { tree.dirs.add(p); });
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists });
    const app = makeApp({ getAbstractFileByPath: () => null, createFolder, createBinary }, adapter);

    await expect(writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64))
      .resolves.toBe(EXPECTED_REL);
    expect(createFolder.mock.calls.map(c => c[0]))
      .toEqual(['Claude', 'Claude/attachments', 'Claude/attachments/thread-1']);
  });
});

/**
 * Companion ladder for directory removal. Same root cause as the write ladder:
 * Geode's `FileSystemAdapter` shim has no `rmdir` at all, so the old
 * single-call implementation threw a TypeError into its own catch and turned
 * every hard-delete into a silent no-op, leaving `attachments/<threadId>/`
 * orphaned on disk forever.
 */
/**
 * Geode's real `window.geode.writeBinary` contract (geode src/main/preload.ts,
 * src/main/vault-write.ts): `(path, data: ArrayBuffer) => Promise<{ mtime,
 * ctime, size }>`, and the main process writes `new Uint8Array(data)`. Passing
 * a base64 *string* there yields `new Uint8Array("...")` - length 0 - so the
 * write resolved successfully with an empty file. Every attachment written
 * under Geode since ~Sep 15 was a 0-byte file because of exactly that.
 */
function makeGeodeBridge() {
  const written = new Map<string, Uint8Array>();
  const writeBinary = vi.fn(async (p: string, data: unknown) => {
    const bytes = new Uint8Array(data as ArrayBuffer);
    written.set(p, bytes);
    return { mtime: 1, ctime: 1, size: bytes.byteLength };
  });
  return { written, writeBinary };
}

describe('AttachmentWriter rung 1 against Geode\'s real writeBinary contract', () => {
  it('writes the decoded image bytes, not an empty file', async () => {
    const adapter = makeAdapter({ exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);
    const bridge = makeGeodeBridge();

    const result = await writerFor(app, { geode: { writeBinary: bridge.writeBinary } })
      .write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64);

    expect(result).toBe(EXPECTED_REL);
    const bytes = bridge.written.get(EXPECTED_REL);
    expect(bytes).toBeDefined();
    expect(Buffer.from(bytes!).toString('base64')).toBe(PNG_BASE64);
  });

  it('treats a host-reported size of 0 as a failed write and falls through to rung 2', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp({ getAbstractFileByPath: () => null, createBinary }, adapter);
    const writeBinary = vi.fn(async () => ({ mtime: 1, ctime: 1, size: 0 }));

    await expect(
      writerFor(app, { geode: { writeBinary } }).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBe(EXPECTED_REL);
    expect(writeBinary).toHaveBeenCalledTimes(1);
    expect(createBinary).toHaveBeenCalledTimes(1);
    expect(Buffer.from(createBinary.mock.calls[0]![1] as ArrayBuffer).toString('base64')).toBe(PNG_BASE64);
  });

  it('treats a host-reported size that differs from the decoded length as a failed write', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp({ getAbstractFileByPath: () => null, createBinary }, adapter);
    const writeBinary = vi.fn(async () => ({ mtime: 1, ctime: 1, size: 3 }));

    await expect(
      writerFor(app, { geode: { writeBinary } }).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBe(EXPECTED_REL);
    expect(createBinary).toHaveBeenCalledTimes(1);
  });

  it('treats a rung 2 adapter write that reports size 0 as a failure and falls through to rung 3', async () => {
    const root = makeTempVault();
    const tree = makeDirTree();
    // File already on disk but not in the metadata cache, so rung 2 uses adapter.writeBinary.
    tree.dirs.add(EXPECTED_REL);
    const writeBinary = vi.fn(async () => ({ mtime: 1, ctime: 1, size: 0 }));
    const adapter = makeAdapter({ getBasePath: () => root, exists: tree.exists, mkdir: tree.mkdir, writeBinary });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    await expect(writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64))
      .resolves.toBe(EXPECTED_REL);
    expect(writeBinary).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, EXPECTED_REL)).toString('base64')).toBe(PNG_BASE64);
  });

  it('accepts a host that reports no size at all (older bridge / void return)', async () => {
    const adapter = makeAdapter({ exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);
    const writeBinary = vi.fn(async () => undefined);

    await expect(
      writerFor(app, { geode: { writeBinary } }).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBe(EXPECTED_REL);
  });
});

describe('AttachmentWriter.removeThreadDir fallback ladder', () => {
  const THREAD_DIR = 'Claude/attachments/thread-1';

  /** A populated `<vault>/Claude/attachments/thread-1` on a real temp disk. */
  function seedThreadDir(): { root: string; abs: string } {
    const root = makeTempVault();
    const abs = path.join(root, THREAD_DIR);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'msg-1-0.png'), Buffer.from(PNG_BASE64, 'base64'));
    return { root, abs };
  }

  it('rung 1: uses adapter.rmdir when the host implements it', async () => {
    const rmdir = vi.fn(async () => {});
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: async () => true, rmdir });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    await writerFor(app).removeThreadDir('thread-1');

    expect(rmdir).toHaveBeenCalledWith(THREAD_DIR, true);
  });

  it('rung 2: falls back to fs when the host has no rmdir (the live Geode shape)', async () => {
    const { root, abs } = seedThreadDir();
    // Geode's real shim: exists() and getBasePath(), no rmdir.
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => true });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    await writerFor(app).removeThreadDir('thread-1');

    expect(fs.existsSync(abs)).toBe(false);
    // Only the thread's own directory went away.
    expect(fs.existsSync(path.join(root, 'Claude/attachments'))).toBe(true);
  });

  it('rung 2: also catches an adapter.rmdir that exists but throws', async () => {
    const { root, abs } = seedThreadDir();
    const rmdir = vi.fn(async () => { throw new Error('rmdir exploded'); });
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => true, rmdir });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    await writerFor(app).removeThreadDir('thread-1');

    expect(rmdir).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(abs)).toBe(false);
  });

  it('skips both rungs when the directory does not exist', async () => {
    const root = makeTempVault();
    const rmdir = vi.fn(async () => {});
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => false, rmdir });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    await writerFor(app).removeThreadDir('thread-1');

    expect(rmdir).not.toHaveBeenCalled();
  });

  it('refuses a traversing thread id instead of deleting outside the attachments dir', async () => {
    const root = makeTempVault();
    const outside = path.join(root, 'Claude', 'logs');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'thread-1.jsonl'), 'keep me');
    const rmdir = vi.fn(async () => {});
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => true, rmdir });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    await writerFor(app).removeThreadDir('../logs');

    expect(rmdir).not.toHaveBeenCalled();
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('rung 2 boundary guard: a vault folder that escapes the vault root removes nothing', async () => {
    // A vault root nested one level down, so the escape target is still inside
    // the throwaway temp tree rather than somewhere real on the machine.
    const parent = makeTempVault();
    const root = path.join(parent, 'vault');
    fs.mkdirSync(root, { recursive: true });
    const outside = path.join(parent, 'attachments', 'thread-1');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.png'), 'keep me');

    // No rmdir, so rung 2 runs — and a vault folder of '..' resolves the
    // attachments root outside the vault, which must throw rather than delete.
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => true });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);
    const writer = new AttachmentWriter(() => app, () => '..', () => ({}));

    await writer.removeThreadDir('thread-1');

    expect(fs.existsSync(outside)).toBe(true);
  });

  it('removes exactly the directory write() wrote to when the folder setting is empty', async () => {
    // The mismatch this pins: buildAttachmentPath defaulted an empty
    // vaultFolder to 'Agent Threads' while removeThreadDir defaulted it to
    // 'Claude', so cleanup deleted a directory that had never been written and
    // the real attachments leaked. Both sides now derive from one helper, so
    // this asserts the two paths against each other rather than against a
    // literal that could drift again.
    const root = makeTempVault();
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => true });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);
    // Empty folder setting — the shared default has to apply on both sides.
    const writer = new AttachmentWriter(() => app, () => '', () => ({}));

    const written = await writer.write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64);
    expect(written).toBe('Agent Threads/attachments/thread-1/msg-1-0.png');
    const writtenAbs = path.join(root, written!);
    expect(fs.existsSync(writtenAbs)).toBe(true);

    await writer.removeThreadDir('thread-1');

    expect(fs.existsSync(writtenAbs)).toBe(false);
    expect(fs.existsSync(path.dirname(writtenAbs))).toBe(false);
  });

  it('does not throw off desktop', async () => {
    const app = makeApp({ getAbstractFileByPath: () => null }, { getBasePath: () => '/x' });
    await expect(writerFor(app).removeThreadDir('thread-1')).resolves.toBeUndefined();
  });

  it('does not throw when no rung is available', async () => {
    // Neither rmdir nor a usable vault root.
    const adapter = makeAdapter({ exists: async () => true });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    await expect(writerFor(app).removeThreadDir('thread-1')).resolves.toBeUndefined();
  });
});
