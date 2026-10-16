/**
 * Small durable-file helpers shared by the token store, journal and config.
 * Everything the daemon writes is private to its unix user (0600 / 0700).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** tmp + fsync + rename so readers see the old or the new file, never a torn one. */
export function writeFileAtomic(file: string, data: string): void {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** Thread ids become file names; refuse anything that could escape the journal dir. */
export function isSafeThreadId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..');
}
