/**
 * The real, `fs`-backed save sink for browser_save_page.
 *
 * Saved pages are scratch for the agent to explore with `jq`, `grep` or Read, so
 * they live under the OS temp directory: outside the vault (no iCloud sync, no
 * clutter) and readable by shell tools. Each thread gets its own directory so it
 * can be removed when the thread or its browser session ends.
 *
 * Node modules are required lazily inside the functions, matching the rest of
 * the plugin: this file is reachable from the renderer bundle, and mobile has no
 * `fs`. `ThreadBrowser` deliberately knows only the `SaveSink` interface.
 */

import type { SaveSink } from './ThreadBrowser';

export const SAVE_ROOT_DIRNAME = 'geode-browser';

/** Thread ids are ours, but never let one escape the scratch root. */
function safeSegment(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
}

/* eslint-disable @typescript-eslint/no-require-imports */
function nodeModules(): { fs: typeof import('fs'); os: typeof import('os'); path: typeof import('path') } {
  return {
    fs: require('fs') as typeof import('fs'),
    os: require('os') as typeof import('os'),
    path: require('path') as typeof import('path'),
  };
}
/* eslint-enable @typescript-eslint/no-require-imports */

export function saveRootDir(): string {
  const { os, path } = nodeModules();
  return path.join(os.tmpdir(), SAVE_ROOT_DIRNAME);
}

function threadDir(threadId: string): string {
  return nodeModules().path.join(saveRootDir(), safeSegment(threadId));
}

export function createFsSaveSink(): SaveSink {
  return {
    resolvePath(threadId, name) {
      return nodeModules().path.join(threadDir(threadId), name);
    },
    async write(filePath, chunk, append) {
      const { fs, path } = nodeModules();
      if (!append) await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      if (append) await fs.promises.appendFile(filePath, chunk, 'utf8');
      else await fs.promises.writeFile(filePath, chunk, 'utf8');
    },
    async writeBytes(filePath, bytes) {
      const { fs, path } = nodeModules();
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, bytes);
    },
    async list(threadId) {
      const { fs, path } = nodeModules();
      const dir = threadDir(threadId);
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        return [];
      }
      return names.sort().map((name) => path.join(dir, name));
    },
    async remove(filePath) {
      await nodeModules().fs.promises.rm(filePath, { force: true });
    },
    async removeDir(threadId) {
      await nodeModules().fs.promises.rm(threadDir(threadId), { recursive: true, force: true });
    },
  };
}

/** Remove every thread's scratch directory. Used on plugin unload. */
export function removeAllSavedPagesSync(): void {
  try {
    nodeModules().fs.rmSync(saveRootDir(), { recursive: true, force: true });
  } catch {
    // Best effort at teardown; the OS temp directory is reclaimed eventually anyway.
  }
}
