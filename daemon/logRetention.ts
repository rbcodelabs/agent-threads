/**
 * Retention for the raw SDK logs in `<dataDir>/logs/<threadId>.jsonl`.
 *
 * These hold the full prompts and tool output (secrets masked), so they follow
 * the same bounds as the replay journal: nothing older than `maxAgeMs`, and no
 * single file past `maxBytes`. A file over the size cap is rotated to
 * `<id>.jsonl.1` (replacing any earlier rotation) and a fresh file starts, so
 * disk use per thread is at most about twice the cap. Rotation is a rename, so
 * it never reads a large file into memory, and the writer (which appends by
 * path) simply starts the new file.
 */
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface LogRetentionLimits {
  /** Delete files not written for this long (ms). Undefined = keep. */
  maxAgeMs?: number;
  /** Rotate a file larger than this (bytes). Undefined = no cap. */
  maxBytes?: number;
}

export interface LogSweepResult {
  deleted: string[];
  rotated: string[];
}

export function sweepRawLogs(dir: string, limits: LogRetentionLimits, now: number = Date.now()): LogSweepResult {
  const result: LogSweepResult = { deleted: [], rotated: [] };
  let names: string[];
  try { names = readdirSync(dir); } catch { return result; }
  for (const name of names) {
    const isLive = name.endsWith('.jsonl');
    if (!isLive && !name.endsWith('.jsonl.1')) continue;
    const file = join(dir, name);
    let st;
    try { st = statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    try {
      if (limits.maxAgeMs !== undefined && now - st.mtimeMs > limits.maxAgeMs) {
        rmSync(file, { force: true });
        result.deleted.push(name);
      } else if (isLive && limits.maxBytes !== undefined && st.size > limits.maxBytes) {
        renameSync(file, `${file}.1`);
        result.rotated.push(name);
      }
    } catch { /* another process holds it, or it vanished; try again next sweep */ }
  }
  return result;
}
