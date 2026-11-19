import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil';

const LEASE_MS = 15 * 60_000;

export class LocalHarnessMaintenance {
  private readonly file: string;
  private lease: { id: string; expiresAt: number } | undefined;
  private pending = 0;

  constructor(dataDir: string, private readonly busy: () => boolean, private readonly now = Date.now) {
    this.file = join(dataDir, 'local-harness-maintenance');
    try {
      const [id, expiry] = readFileSync(this.file, 'utf8').trim().split(' ');
      const expiresAt = Number(expiry);
      if (id && Number.isSafeInteger(expiresAt)) this.lease = { id, expiresAt };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private get locked(): boolean {
    return this.lease !== undefined && this.lease.expiresAt > this.now();
  }

  get idle(): boolean {
    return !this.locked && this.pending === 0 && !this.busy();
  }

  acquire(id: string): boolean {
    if (this.locked && this.lease?.id === id) return true;
    if (!this.idle) return false;
    const expiresAt = this.now() + LEASE_MS;
    // The candidate or restored daemon reads the same lease before it accepts new session work.
    writeFileAtomic(this.file, `${id} ${expiresAt}\n`);
    this.lease = { id, expiresAt };
    return true;
  }

  release(id: string): boolean {
    if (!this.locked) return true;
    if (this.lease?.id !== id) return false;
    rmSync(this.file, { force: true });
    this.lease = undefined;
    return true;
  }

  /** Register admission before dispatch. All commands and lock acquisition are on the same event loop. */
  begin(): (() => void) | undefined {
    if (this.locked) return undefined;
    this.pending++;
    return () => { this.pending--; };
  }
}
