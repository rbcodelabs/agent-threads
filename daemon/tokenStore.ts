/**
 * Hashed bearer-token store (design section 3.1 / 5.2).
 *
 * `tokens.json` holds only SHA-256 digests, never the secret. The plaintext
 * token (256 random bits) is shown exactly once by `token create`. Lookups
 * compare against EVERY stored digest with timingSafeEqual and no early exit,
 * so response time does not reveal which (or whether any) token matched.
 *
 * The file is re-read when its mtime changes, so `agent-threads token create|revoke`
 * run from a shell take effect in a running daemon without a restart.
 *
 * A token file that cannot be read or parsed fails CLOSED: while it is broken
 * `verify` rejects everything and `isActive` reports false (open connections
 * are dropped at their next heartbeat), and the problem is logged once per
 * distinct failure. Nothing here throws on the authentication path, so a
 * corrupt file can never crash a socket handler or timer. Fixing the file
 * restores service without a restart. The constructor and the management
 * methods (`list`, `create`, `revoke`) still throw, so startup and the CLI
 * report the corruption loudly.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil';

export const TOKEN_SCOPES = ['read', 'control', 'admin'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Each scope includes the ones below it. */
const RANK: Record<TokenScope, number> = { read: 1, control: 2, admin: 3 };

export function scopeSatisfies(have: TokenScope, need: TokenScope): boolean {
  return RANK[have] >= RANK[need];
}

export interface TokenRecord {
  id: string;
  name: string;
  /** Lowercase hex SHA-256 of the plaintext token. */
  sha256: string;
  /** Highest scope granted; lower scopes are implied. */
  scopes: TokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface VerifiedToken {
  id: string;
  name: string;
  scope: TokenScope;
}

const TOKEN_PREFIX = 'atd_';
/** Don't rewrite tokens.json on every connection; once a minute per token is plenty. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

function isTokenRecord(r: unknown): r is TokenRecord {
  if (typeof r !== 'object' || r === null) return false;
  const t = r as Record<string, unknown>;
  return typeof t.id === 'string' && typeof t.sha256 === 'string' && /^[0-9a-f]{64}$/.test(t.sha256)
    && Array.isArray(t.scopes) && t.scopes.every((x) => (TOKEN_SCOPES as readonly unknown[]).includes(x))
    && (t.revokedAt === null || typeof t.revokedAt === 'number');
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export function highestScope(scopes: readonly TokenScope[]): TokenScope {
  return scopes.reduce<TokenScope>((best, s) => (RANK[s] > RANK[best] ? s : best), 'read');
}

export class TokenStore {
  private readonly file: string;
  private records: TokenRecord[] = [];
  private mtimeMs = -1;
  private readonly lastUsedWritten = new Map<string, number>();
  /** Why the file is currently unusable (null = fine). */
  private broken: string | null = null;
  private lastLogged = '';

  constructor(
    dataDir: string,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (line: string) => void = (l) => console.error(l),
  ) {
    this.file = join(dataDir, 'tokens.json');
    this.reload();
  }

  /** Re-read from disk if it changed (or appeared/vanished). */
  reload(): void {
    if (!existsSync(this.file)) {
      this.records = [];
      this.mtimeMs = -1;
      this.broken = null;
      return;
    }
    const { mtimeMs } = statSync(this.file);
    if (mtimeMs === this.mtimeMs) {
      if (this.broken) throw new Error(this.broken);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
      if (!parsed.every(isTokenRecord)) throw new Error('an entry is not a token record');
      this.records = parsed;
      this.broken = null;
    } catch (err) {
      // Remember the failure for this mtime so every connection does not re-parse (and re-log) the same bad file.
      this.records = [];
      this.broken = `${this.file} is unusable: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.mtimeMs = mtimeMs;
    if (this.broken) throw new Error(this.broken);
  }

  /** `reload` for the authentication path: never throws; false means the store is unusable (fail closed). */
  private reloadOrFailClosed(): boolean {
    try {
      this.reload();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastLogged) {
        this.lastLogged = msg;
        this.log(`ERROR: ${msg}. Rejecting ALL authentication until it is fixed (restoring a valid tokens.json takes effect immediately).`);
      }
      return false;
    }
  }

  list(): TokenRecord[] {
    this.reload();
    return this.records.map((r) => ({ ...r }));
  }

  get hasActiveTokens(): boolean {
    this.reload();
    return this.records.some((r) => r.revokedAt === null);
  }

  /** @returns the plaintext token; it cannot be recovered afterwards. */
  create(name: string, scope: TokenScope): { record: TokenRecord; token: string } {
    this.reload();
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const record: TokenRecord = {
      id: randomUUID().slice(0, 8),
      name,
      sha256: sha256Hex(token),
      scopes: [scope],
      createdAt: this.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.records.push(record);
    this.persist();
    return { record: { ...record }, token };
  }

  /** @returns false when no such (unrevoked) token exists. */
  revoke(idOrPrefix: string): boolean {
    this.reload();
    const hit = this.records.find((r) => r.revokedAt === null && (r.id === idOrPrefix || r.name === idOrPrefix));
    if (!hit) return false;
    hit.revokedAt = this.now();
    this.persist();
    return true;
  }

  /** Is the token with this id still usable? (Open connections re-check this.) */
  isActive(id: string): boolean {
    if (!this.reloadOrFailClosed()) return false;
    return this.records.some((r) => r.id === id && r.revokedAt === null);
  }

  verify(token: string): VerifiedToken | null {
    if (!this.reloadOrFailClosed()) return null;
    const presented = Buffer.from(sha256Hex(token), 'hex');
    let match: TokenRecord | null = null;
    for (const r of this.records) {
      const stored = Buffer.from(r.sha256, 'hex');
      // Equal-length digests, so timingSafeEqual never throws; evaluate all of them.
      const equal = stored.length === presented.length && timingSafeEqual(stored, presented);
      if (equal && r.revokedAt === null) match = r;
    }
    if (!match) return null;
    this.touch(match);
    return { id: match.id, name: match.name, scope: highestScope(match.scopes) };
  }

  private touch(r: TokenRecord): void {
    const t = this.now();
    const last = this.lastUsedWritten.get(r.id) ?? 0;
    r.lastUsedAt = t;
    if (t - last < LAST_USED_WRITE_INTERVAL_MS) return;
    this.lastUsedWritten.set(r.id, t);
    try {
      this.persist();
    } catch {
      // A read-only data dir must not lock everyone out; lastUsedAt is advisory.
    }
  }

  private persist(): void {
    writeFileAtomic(this.file, `${JSON.stringify(this.records, null, 2)}\n`);
    this.mtimeMs = statSync(this.file).mtimeMs;
  }
}
