import { App, FileSystemAdapter, TFile, base64ToArrayBuffer } from 'obsidian';
import { attachmentDirForThread, attachmentRoot, buildAttachmentPath } from './imageExternalization';
import { debugLog } from './logger';

/**
 * Writes message images out to real vault attachment files so they stop bloating
 * data.json (ADR-0003, PR 1). Files live at
 * `<vaultFolder>/attachments/<threadId>/<messageId>-<index>.<ext>`, mirroring
 * RawLogWriter's per-thread `logs/<threadId>.jsonl` convention.
 *
 * Hosts disagree about which write API exists, so every write walks a
 * three-rung fallback ladder (see `write`). The plugin runs inside both
 * Obsidian and Geode, and Geode's Obsidian shim implements only a subset of
 * `FileSystemAdapter`: `getBasePath`, `getName`, `getResourcePath` and
 * `exists`. Assuming the full adapter is what broke this class.
 *
 * The exact failure, confirmed by running this class against a surface
 * reconstructed from Geode's own source rather than inferred: the
 * `instanceof FileSystemAdapter` guard passes under Geode (its shim returns a
 * real instance, deliberately, so plugin desktop guards resolve). `ensureDir`
 * then called `adapter.mkdir(...)`, which is `undefined` there - but that
 * TypeError was already swallowed by ensureDir's own catch, so it was NOT
 * what killed the write. The throw that actually escaped `write()` came one
 * step later, from `app.vault.createBinary` being undefined too. Every
 * attachment silently stayed inline as base64 in data.json.
 *
 * Both are worth stating because fixing only the `mkdir` call would have left
 * the bug fully intact. Note also that Geode DOES implement
 * `vault.createFolder`, so under Geode `ensureDir` now succeeds via that
 * branch. The write itself now goes through rung 1 (`window.geode.writeBinary`).
 *
 * Removal has the same shape and therefore its own two-rung ladder (see
 * `removeThreadDir`). `adapter.rmdir` does not exist on Geode's shim either, so
 * the old single-call implementation threw a TypeError straight into its own
 * catch: every hard-delete of a thread with no markdown note left
 * `attachments/<threadId>/` orphaned on disk, silently, forever. Rung 2 is a
 * raw `fs.rmSync`, bounded to the attachments directory so a delete can never
 * reach outside it.
 *
 * Desktop-only: every method is a no-op off a FileSystemAdapter (mobile is
 * relay-fed and cannot resolve a desktop attachment path). Never throws into the
 * session hot path. A write failure is logged and swallowed, leaving base64 in
 * place, exactly the graceful-degradation posture RawLogWriter.enqueue takes.
 *
 * App and vault folder are read lazily through getters because ThreadManager
 * populates them after construction (same wiring RawLogWriter uses for its
 * vault root/folder).
 */

/**
 * The binary-write surface a host may expose on `window.geode`.
 *
 * Duck-typed, never version-checked: Geode reports no version to plugins, so
 * "is this a function?" is the only safe test. Same posture as
 * `WakeLockService.detectNativeBridge`.
 *
 * Mirrors Geode's real contract (geode `src/main/preload.ts`,
 * `src/main/vault-write.ts`): the data is an `ArrayBuffer`, and the main
 * process writes `new Uint8Array(data)`. It must never be handed a base64
 * string: `new Uint8Array("<string>")` is length 0, so the IPC call resolves
 * successfully having written an empty file. That is exactly how every
 * attachment written under Geode from ~Sep 15 came out 0 bytes.
 *
 * The result may be `void` because other hosts may return nothing; when a numeric `size` comes back it is checked against the decoded
 * byte length (see `assertWriteSize`).
 */
export interface HostBinaryWriteBridge {
  writeBinary(
    path: string,
    data: ArrayBuffer,
    options?: { mtime?: number; ctime?: number },
  ): Promise<{ mtime: number; ctime: number; size: number } | void>;
}

interface HostWindowLike {
  geode?: Partial<HostBinaryWriteBridge>;
}

/**
 * The vault methods this writer probes for. Every member is optional because
 * a host shim may implement only some of them; the real Obsidian type declares
 * them all as required, which is exactly the assumption that caused the bug.
 */
interface ProbedVault {
  getAbstractFileByPath(path: string): unknown;
  createBinary?(path: string, data: ArrayBuffer): Promise<TFile>;
  modifyBinary?(file: TFile, data: ArrayBuffer): Promise<void>;
  createFolder?(path: string): Promise<unknown>;
}

/** The adapter methods this writer probes for. Optional for the same reason. */
interface ProbedAdapter {
  getBasePath?(): string;
  exists?(path: string): Promise<boolean> | boolean;
  /** Obsidian returns void; a host shim may return `{ size }` (checked if so). */
  writeBinary?(path: string, data: ArrayBuffer): Promise<unknown>;
  mkdir?(path: string): Promise<void>;
  rmdir?(path: string, recursive: boolean): Promise<void>;
}

function defaultHostWindow(): HostWindowLike {
  return (globalThis as unknown as { window?: HostWindowLike }).window ?? {};
}

/**
 * Guard against a write that "succeeds" but stores the wrong bytes. When the
 * host reports a numeric `size` for what it wrote, it must equal the decoded
 * length; otherwise throw so `write` falls through to the next rung. A result
 * with no `size` (Obsidian's void returns) is accepted as-is - this relies only
 * on what the host already returns and never re-reads the file.
 */
function assertWriteSize(result: unknown, expectedBytes: number): void {
  if (typeof result !== 'object' || result === null) return;
  const size = (result as { size?: unknown }).size;
  if (typeof size !== 'number') return;
  if (size !== expectedBytes) {
    throw new Error(`host reported ${size} bytes written, expected ${expectedBytes}`);
  }
}

export class AttachmentWriter {
  /** Directories already ensured this session, to skip redundant exists/mkdir. */
  private ensuredDirs = new Set<string>();

  constructor(
    private getApp: () => App | null,
    private getVaultFolder: () => string,
    /** Injectable for tests; defaults to the real host window. */
    private getHostWindow: () => HostWindowLike = defaultHostWindow,
  ) {}

  /** True only on desktop, where a real filesystem vault exists. */
  isDesktop(): boolean {
    const app = this.getApp();
    return !!app && app.vault.adapter instanceof FileSystemAdapter;
  }

  /**
   * Write one image to its attachment file and return the vault-relative path,
   * or null if the write was skipped (mobile) or every rung failed. Idempotent:
   * an existing file at the target path is overwritten rather than duplicated,
   * so a backfill re-run is harmless.
   *
   * Three rungs, tried in order, each isolated so a missing API on one host
   * degrades to the next instead of aborting the whole write:
   *
   *   1. `window.geode.writeBinary`: preferred, because only the host can
   *      refresh its own vault index, so the file is immediately resolvable.
   *   2. The Obsidian vault API (`modifyBinary` / `adapter.writeBinary` /
   *      `createBinary`): registers with the metadata cache.
   *   3. Node `fs` straight to disk: see `writeThroughNodeFs` for the caveat.
   *
   * A rung whose host reports a written `size` that differs from the decoded
   * byte length is treated as failed (see `assertWriteSize`), so a silently
   * truncated write degrades to the next rung instead of leaving a 0-byte file.
   */
  async write(
    threadId: string,
    messageId: string,
    index: number,
    mediaType: string,
    base64: string,
  ): Promise<string | null> {
    const app = this.getApp();
    if (!app || !(app.vault.adapter instanceof FileSystemAdapter)) return null;

    const rel = buildAttachmentPath(this.getVaultFolder(), threadId, messageId, index, mediaType);

    // Rung 1: native host bridge. Takes an ArrayBuffer, never the base64
    // string (see HostBinaryWriteBridge). Decoded per rung because an IPC
    // bridge may transfer (detach) the buffer it is given.
    const bridge = this.hostBinaryWriter();
    if (bridge) {
      try {
        const buffer = base64ToArrayBuffer(base64);
        const expectedBytes = buffer.byteLength;
        assertWriteSize(await bridge.writeBinary(rel, buffer), expectedBytes);
        return rel;
      } catch (err) {
        debugLog('[ClaudeThreads] attachment write via host bridge failed:', rel, String(err));
      }
    }

    // Rung 2: Obsidian vault API.
    try {
      const buffer = base64ToArrayBuffer(base64);
      await this.ensureDir(app, rel.slice(0, rel.lastIndexOf('/')));
      await this.writeThroughVault(app, rel, buffer);
      return rel;
    } catch (err) {
      debugLog('[ClaudeThreads] attachment write via vault API failed:', rel, String(err));
    }

    // Rung 3: Node fs.
    try {
      this.writeThroughNodeFs(app.vault.adapter, rel, base64);
      return rel;
    } catch (err) {
      debugLog('[ClaudeThreads] attachment write via fs failed:', rel, String(err));
    }

    return null;
  }

  /**
   * Remove a thread's entire attachment directory. Used on a hard-delete of a
   * thread that has no markdown note (see ThreadManager.deleteThread). No-op off
   * desktop, if the directory doesn't exist, or if every rung fails (leaving
   * orphaned files is a far cheaper failure than throwing out of a delete).
   *
   * Two rungs, mirroring `write`'s ladder for the same reason — a host may not
   * implement the API this needs:
   *
   *   1. `adapter.rmdir`: preferred, because the host removes the files through
   *      its own path and updates its vault index itself.
   *   2. Node `fs.rmSync` straight to disk: see `removeThroughNodeFs`. Reached
   *      when `rmdir` is missing (Geode's `FileSystemAdapter` shim has no
   *      `rmdir` at all) or when it throws.
   */
  async removeThreadDir(threadId: string): Promise<void> {
    const app = this.getApp();
    if (!app || !(app.vault.adapter instanceof FileSystemAdapter)) return;
    // Derived from the same helpers `write` builds its paths with, so the
    // directory removed here is by construction the directory written to —
    // including when the vault-folder setting is empty and the shared default
    // applies.
    const vaultFolder = this.getVaultFolder();
    const attachmentsRoot = attachmentRoot(vaultFolder);
    const dir = attachmentDirForThread(vaultFolder, threadId);

    // A thread id is plugin-generated, but it lands in a path that both rungs
    // then delete recursively, so refuse traversal before either one runs
    // rather than trusting the fs-side boundary check alone.
    if (!threadId || threadId.includes('/') || threadId.includes('\\') || threadId === '..' || threadId === '.') {
      debugLog('[ClaudeThreads] attachment dir remove refused for unsafe thread id:', threadId);
      return;
    }

    const adapter = app.vault.adapter as unknown as ProbedAdapter;

    // Rung 1: the Obsidian adapter API.
    try {
      if (typeof adapter.exists === 'function' && !(await adapter.exists(dir))) {
        this.ensuredDirs.delete(dir);
        return;
      }
      if (typeof adapter.rmdir !== 'function') throw new Error('adapter.rmdir unavailable');
      await adapter.rmdir(dir, true);
      this.ensuredDirs.delete(dir);
      return;
    } catch (err) {
      debugLog('[ClaudeThreads] attachment dir remove via adapter failed:', dir, String(err));
    }

    // Rung 2: Node fs.
    try {
      this.removeThroughNodeFs(app.vault.adapter, dir, attachmentsRoot);
      this.ensuredDirs.delete(dir);
    } catch (err) {
      debugLog('[ClaudeThreads] attachment dir remove via fs failed:', dir, String(err));
    }
  }

  /**
   * Rung 1 detection. Returns the bridge only when `writeBinary` is actually a
   * function, so a host that exposes `window.geode` without it falls straight
   * through to rung 2 rather than throwing.
   */
  private hostBinaryWriter(): HostBinaryWriteBridge | null {
    let geode: Partial<HostBinaryWriteBridge> | undefined;
    try {
      geode = this.getHostWindow()?.geode;
    } catch {
      return null;
    }
    if (typeof geode?.writeBinary !== 'function') return null;
    return geode as HostBinaryWriteBridge;
  }

  /**
   * Rung 2 write. Throws (rather than returning false) when the host is missing
   * the method this branch needs, so `write` falls through to rung 3 with the
   * reason logged.
   */
  private async writeThroughVault(app: App, rel: string, buffer: ArrayBuffer): Promise<void> {
    const vault = app.vault as unknown as ProbedVault;
    const adapter = app.vault.adapter as unknown as ProbedAdapter;

    const existing = vault.getAbstractFileByPath(rel);
    if (existing instanceof TFile) {
      if (typeof vault.modifyBinary !== 'function') throw new Error('vault.modifyBinary unavailable');
      await vault.modifyBinary(existing, buffer);
      return;
    }

    // On disk but not yet in the metadata cache (e.g. created a prior session):
    // overwrite via the adapter rather than risk a createBinary "already
    // exists" throw.
    if (typeof adapter.exists === 'function' && (await adapter.exists(rel))) {
      if (typeof adapter.writeBinary !== 'function') throw new Error('adapter.writeBinary unavailable');
      const expectedBytes = buffer.byteLength;
      assertWriteSize(await adapter.writeBinary(rel, buffer), expectedBytes);
      return;
    }

    if (typeof vault.createBinary !== 'function') throw new Error('vault.createBinary unavailable');
    await vault.createBinary(rel, buffer);
  }

  /**
   * Rung 3: write the bytes straight to disk under the vault root.
   *
   * Caveat, measured rather than assumed: a file written this way bypasses the
   * host's own write path, so whether it becomes visible depends on the host's
   * file watcher.
   *
   * Under Geode it does, and quickly. Measured in a live Electron process
   * (headless Playwright, Geode's own e2e harness): `adapter.exists` is true
   * at 1ms (a live IPC stat, never index-dependent),
   * `vault.getAbstractFileByPath` resolves at ~306ms once the FSEvents watcher
   * fires, `getResourcePath` serves the bytes (fetch 200, correct length), and
   * a real `![[attachments/...]]` embed renders in a markdown view with zero
   * unresolved embeds. No rescan or restart is needed. The 306ms figure is
   * macOS/FSEvents-specific and was not measured on Windows or Linux.
   *
   * Obsidian proper was NOT tested this way. There the ladder stops at rung 2,
   * which registers with the metadata cache directly, so rung 3's visibility
   * is not on Obsidian's normal path anyway.
   *
   * Either way this beats the alternative it replaces: a silent no-op that
   * left multi-megabyte base64 inline in data.json forever, the exact bloat
   * ADR-0003 was written to eliminate. Under current Geode, which ships
   * `window.geode.writeBinary`, rung 1 handles the write and this rung is
   * reached only if that bridge throws or reports a truncated write.
   *
   * `fs`/`path` are required lazily, never at module scope: ThreadManager
   * imports this module eagerly and Obsidian Mobile's require() interceptor
   * returns null for Node built-ins (see test/unit/bundle-safety.test.ts).
   */
  private writeThroughNodeFs(adapter: FileSystemAdapter, rel: string, base64: string): void {
    const probed = adapter as unknown as ProbedAdapter;
    if (typeof probed.getBasePath !== 'function') throw new Error('adapter.getBasePath unavailable');
    const basePath = probed.getBasePath();
    if (!basePath) throw new Error('adapter.getBasePath returned no vault root');

    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const abs = path.join(basePath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(base64, 'base64'));
  }

  /**
   * Rung 2 of `removeThreadDir`: delete the directory straight off disk under
   * the vault root, the same way `writeThroughNodeFs` writes to it.
   *
   * Exists because `adapter.rmdir` is not universal: Geode's `FileSystemAdapter`
   * shim implements `getBasePath`/`getName`/`getResourcePath`/`exists` and
   * nothing else, so `adapter.rmdir(...)` is `undefined` there. The resulting
   * TypeError was swallowed by `removeThreadDir`'s own catch, which turned a
   * hard-delete into a silent no-op and left `attachments/<threadId>/` on disk
   * forever — unbounded growth nobody could see.
   *
   * Visibility has the same caveat as the write side: the removal bypasses the
   * host's own path, so the host's file watcher is what drops the files out of
   * its index. Under Geode that watcher exists (see `writeThroughNodeFs` for
   * the measured behavior on the create side).
   *
   * `boundaryRel` is the vault-relative attachments root. The resolved absolute
   * path must sit strictly inside it, so neither a traversing thread id nor a
   * symlinked/absolute vault folder can turn a thread delete into an rm of
   * anything else. A path that fails the check throws instead of deleting.
   *
   * `fs`/`path` are required lazily for the mobile-bundle reason documented on
   * `writeThroughNodeFs`; this method is unreachable off a FileSystemAdapter
   * anyway.
   */
  private removeThroughNodeFs(adapter: FileSystemAdapter, rel: string, boundaryRel: string): void {
    const probed = adapter as unknown as ProbedAdapter;
    if (typeof probed.getBasePath !== 'function') throw new Error('adapter.getBasePath unavailable');
    const basePath = probed.getBasePath();
    if (!basePath) throw new Error('adapter.getBasePath returned no vault root');

    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const root = path.resolve(basePath);
    const boundary = path.resolve(root, boundaryRel);
    const abs = path.resolve(root, rel);

    const insideBoundary = abs.startsWith(boundary + path.sep);
    const insideVault = boundary === root || boundary.startsWith(root + path.sep);
    if (!insideBoundary || !insideVault) {
      throw new Error(`refusing to remove outside ${boundaryRel}: ${abs}`);
    }

    fs.rmSync(abs, { recursive: true, force: true });
  }

  /**
   * Ensure every ancestor of `dir` exists, using whichever directory-create API
   * the host actually implements. Walks segment-by-segment with an exists-check
   * so it works whether or not that API is recursive, and tolerates a concurrent
   * create (two images for the same message race here).
   *
   * Throws if the directory still doesn't exist afterwards, so `write` drops to
   * rung 3 (which does its own recursive mkdir) instead of attempting a vault
   * write that is guaranteed to fail. Caches the full dir only on success, so a
   * failed attempt isn't remembered as done.
   */
  private async ensureDir(app: App, dir: string): Promise<void> {
    if (!dir || this.ensuredDirs.has(dir)) return;
    const vault = app.vault as unknown as ProbedVault;
    const adapter = app.vault.adapter as unknown as ProbedAdapter;

    const mkdir: ((p: string) => Promise<unknown>) | null =
      typeof adapter.mkdir === 'function'
        ? (p) => Promise.resolve(adapter.mkdir!(p))
        : typeof vault.createFolder === 'function'
          ? (p) => Promise.resolve(vault.createFolder!(p))
          : null;
    if (!mkdir) throw new Error('host exposes no mkdir/createFolder');

    const exists = typeof adapter.exists === 'function'
      ? (p: string) => Promise.resolve(adapter.exists!(p))
      : (p: string) => Promise.resolve(vault.getAbstractFileByPath(p) != null);

    const segments = dir.split('/');
    let cur = '';
    for (const seg of segments) {
      cur = cur ? `${cur}/${seg}` : seg;
      // eslint-disable-next-line no-await-in-loop
      if (await exists(cur)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await mkdir(cur);
      } catch {
        // A concurrent write may have created it between the check and here.
      }
    }

    if (!(await exists(dir))) throw new Error(`attachment directory not created: ${dir}`);
    this.ensuredDirs.add(dir);
  }
}
