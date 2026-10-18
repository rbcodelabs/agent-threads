/**
 * Credentials pushed by an admin client (`creds.push`).
 *
 * One file per kind: `<dataDir>/creds/<kind>.json` (directory 0700, file 0600, written atomically). A kind is a
 * named bundle of `NAME -> value` fields, for example `mcp` holding the API keys that daemon-side MCP server
 * definitions refer to as `${NAME}`. Values never leave this process: replies carry field names only, and the
 * daemon registers every value with the secret redactor so a log line cannot echo one.
 *
 * `ttlSec` bounds how long a pushed credential is honoured (0 = until replaced). An expired kind is ignored and its
 * file is removed the next time it is read. Pushing a kind with no fields deletes it (revocation).
 *
 * `claude-token` (written by the local-daemon runner into the same directory) is a bare file with no extension,
 * so it can never collide with a `<kind>.json`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil';

export const MAX_CRED_FIELDS = 64;
export const MAX_CRED_VALUE_BYTES = 64 * 1024;
export const MAX_CRED_TTL_SEC = 365 * 24 * 60 * 60;

const KIND = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export class CredError extends Error {}

interface StoredKind {
  kind: string;
  fields: Record<string, string>;
  pushedAt: number;
  /** Epoch ms; absent = never expires. */
  expiresAt?: number;
}

export interface CredPushResult {
  kind: string;
  /** Field names now stored under this kind (never values). Empty when the kind was removed. */
  fields: string[];
  removed: boolean;
  expiresAt?: number;
}

export class CredStore {
  readonly dir: string;

  constructor(dataDir: string, private readonly now: () => number = () => Date.now()) {
    this.dir = join(dataDir, 'creds');
  }

  /** Validate and store (or, with no fields, delete) one kind. Throws `CredError` on bad input. */
  push(kind: unknown, ttlSec: unknown, fields: unknown): CredPushResult {
    if (typeof kind !== 'string' || !KIND.test(kind)) throw new CredError('kind must be 1-64 characters of a-z, 0-9, "-" or "_"');
    if (typeof ttlSec !== 'number' || !Number.isInteger(ttlSec) || ttlSec < 0 || ttlSec > MAX_CRED_TTL_SEC) {
      throw new CredError(`ttlSec must be an integer from 0 (no expiry) to ${MAX_CRED_TTL_SEC}`);
    }
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new CredError('fields must be an object of NAME -> value');
    const entries = Object.entries(fields as Record<string, unknown>);
    if (entries.length > MAX_CRED_FIELDS) throw new CredError(`too many fields (limit ${MAX_CRED_FIELDS})`);
    const clean: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (!FIELD.test(name)) throw new CredError(`invalid field name "${name.slice(0, 40)}": use letters, digits and "_", not starting with a digit`);
      if (typeof value !== 'string') throw new CredError(`field ${name} must be a string`);
      if (Buffer.byteLength(value) > MAX_CRED_VALUE_BYTES) throw new CredError(`field ${name} is too large (limit ${MAX_CRED_VALUE_BYTES} bytes)`);
      clean[name] = value;
    }
    const file = this.fileFor(kind);
    if (entries.length === 0) {
      let removed = false;
      try { unlinkSync(file); removed = true; } catch { /* nothing stored */ }
      return { kind, fields: [], removed };
    }
    const pushedAt = this.now();
    const record: StoredKind = { kind, fields: clean, pushedAt, ...(ttlSec > 0 ? { expiresAt: pushedAt + ttlSec * 1000 } : {}) };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify(record)}\n`);
    return { kind, fields: Object.keys(clean), removed: false, ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}) };
  }

  /** Unexpired fields of one kind. */
  get(kind: string): Record<string, string> | undefined {
    if (!KIND.test(kind)) return undefined;
    return this.read(this.fileFor(kind))?.fields;
  }

  /** Every live kind, in name order (so a lookup across kinds is deterministic). */
  private all(): StoredKind[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    const out: StoredKind[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const record = this.read(join(this.dir, name));
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * Resolve a `${NAME}` placeholder. `kind.NAME` reads one kind; a bare `NAME` takes the first kind (by name) that
   * has it.
   */
  lookup(name: string): string | undefined {
    const dot = name.indexOf('.');
    if (dot > 0) {
      const value = this.get(name.slice(0, dot))?.[name.slice(dot + 1)];
      if (value !== undefined) return value;
    }
    for (const record of this.all()) {
      const value = record.fields[name];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** Every stored value, for the redactor. */
  secretValues(): string[] {
    return this.all().flatMap((r) => Object.values(r.fields));
  }

  private fileFor(kind: string): string { return join(this.dir, `${kind}.json`); }

  private read(file: string): StoredKind | undefined {
    if (!existsSync(file)) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
    const r = parsed as Partial<StoredKind> | null;
    if (!r || typeof r !== 'object' || typeof r.fields !== 'object' || r.fields === null) return undefined;
    if (typeof r.expiresAt === 'number' && r.expiresAt <= this.now()) {
      try { unlinkSync(file); } catch { /* already gone */ }
      return undefined;
    }
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.fields)) if (typeof v === 'string') fields[k] = v;
    return { kind: String(r.kind ?? ''), fields, pushedAt: Number(r.pushedAt ?? 0), ...(typeof r.expiresAt === 'number' ? { expiresAt: r.expiresAt } : {}) };
  }
}
