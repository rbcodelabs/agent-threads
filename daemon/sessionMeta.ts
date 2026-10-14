/**
 * What the daemon must remember about a session to bring it back after the
 * live process is gone (idle reap, daemon restart): the spec it was opened
 * with and the harness-native session id to resume.
 *
 * `sessions/<threadId>.json`, 0600, tmp + rename. The journal is the history;
 * this is only the recipe for restarting the process behind it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteSessionSpec } from '../src/protocol';
import { ensureDir, isSafeThreadId, writeFileAtomic } from './fsutil';

export interface SessionMeta {
  threadId: string;
  spec: RemoteSessionSpec;
  nativeSessionId?: string;
  updatedAt: number;
}

export class SessionMetaStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'sessions');
    ensureDir(this.dir);
  }

  save(meta: SessionMeta): void {
    if (!isSafeThreadId(meta.threadId)) throw new Error(`invalid threadId "${meta.threadId}"`);
    writeFileAtomic(join(this.dir, `${meta.threadId}.json`), `${JSON.stringify(meta)}\n`);
  }

  load(threadId: string): SessionMeta | null {
    if (!isSafeThreadId(threadId)) return null;
    const file = join(this.dir, `${threadId}.json`);
    if (!existsSync(file)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const m = parsed as Partial<SessionMeta>;
      if (typeof parsed !== 'object' || parsed === null || m.threadId !== threadId || typeof m.spec !== 'object' || m.spec === null) return null;
      return m as SessionMeta;
    } catch {
      // A torn or hand-edited file must not stop the daemon from starting.
      return null;
    }
  }

  listIds(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).filter(isSafeThreadId);
  }
}
