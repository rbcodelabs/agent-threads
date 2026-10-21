/**
 * `agent-threads creds push`: send credentials to the daemon (`creds.push`, admin scope).
 *
 * Secrets never go through argv by default (visible in `ps`, kept in shell history). Field values come from, in order of
 * precedence per field: stdin JSON (`--stdin`), the environment variable of the same name, and only with the explicit
 * `--allow-argv` flag a `NAME=value` argument. Nothing here ever prints a value: output lists field names.
 */
import type { DaemonClient } from '../../src/remote/DaemonClient';
import { command } from './connection';
import { CliError, EXIT } from './exit';

export interface CredsPushOptions {
  kind: string;
  /** Positional field specs: `NAME` (from stdin JSON / env) or `NAME=value` (needs `allowArgv`). */
  specs: string[];
  /** Seconds the credential is honoured; 0 = until replaced. */
  ttlSec: number;
  remove: boolean;
  stdinJson: boolean;
  allowArgv: boolean;
}

export interface FieldSources {
  env: NodeJS.ProcessEnv;
  /** Raw stdin text, only read when `stdinJson`. */
  stdinText?: string;
  warn(message: string): void;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** `90`, `90s`, `15m`, `24h`, `7d` to seconds. */
export function parseTtl(raw: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(raw.trim());
  if (!m) throw new CliError(`--ttl must be a number of seconds or a number with s, m, h or d (got "${raw}")`, EXIT.USAGE);
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * mult;
}

/** Resolve the field values to send, or throw a usage error naming (never showing) what is missing. */
export function collectFields(opts: CredsPushOptions, src: FieldSources): Record<string, string> {
  let stdinFields: Record<string, unknown> = {};
  if (opts.stdinJson) {
    let parsed: unknown;
    try { parsed = JSON.parse(src.stdinText ?? ''); } catch { throw new CliError('--stdin expects a JSON object of NAME -> value on standard input', EXIT.USAGE); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CliError('--stdin expects a JSON object of NAME -> value', EXIT.USAGE);
    stdinFields = parsed as Record<string, unknown>;
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(stdinFields)) {
    if (typeof value !== 'string') throw new CliError(`field ${name} on stdin must be a string`, EXIT.USAGE);
    out[name] = value;
  }
  const missing: string[] = [];
  for (const spec of opts.specs) {
    const eq = spec.indexOf('=');
    if (eq !== -1) {
      const name = spec.slice(0, eq);
      if (!NAME.test(name)) throw new CliError(`invalid field name "${name.slice(0, 40)}"`, EXIT.USAGE);
      if (!opts.allowArgv) {
        throw new CliError(`NAME=value on the command line would expose the secret in "ps" and shell history. Pass just ${name} and set it in the environment, or use --stdin with JSON; --allow-argv overrides this.`, EXIT.USAGE);
      }
      src.warn(`warning: the value of ${name} was passed on the command line and is visible to other users in "ps".`);
      out[name] = spec.slice(eq + 1);
      continue;
    }
    if (!NAME.test(spec)) throw new CliError(`invalid field name "${spec.slice(0, 40)}"`, EXIT.USAGE);
    if (out[spec] !== undefined) continue; // stdin JSON already supplied it
    const fromEnv = src.env[spec];
    if (fromEnv === undefined || fromEnv === '') { missing.push(spec); continue; }
    out[spec] = fromEnv;
  }
  if (missing.length) throw new CliError(`no value for ${missing.join(', ')}: set ${missing.length === 1 ? 'it' : 'them'} in the environment or pass --stdin with JSON`, EXIT.USAGE);
  return out;
}

export interface CredsPushReply {
  kind: string;
  fields: string[];
  removed: boolean;
  expiresAt?: number;
}

/** Validate flags and gather the fields BEFORE connecting, so a usage error never needs a daemon. */
export function preparePush(opts: CredsPushOptions, src: FieldSources): Record<string, string> {
  if (!opts.kind) throw new CliError('creds push needs a kind (for example: agent-threads creds push mcp DOCS_TOKEN)', EXIT.USAGE);
  if (opts.remove) {
    if (opts.specs.length || opts.stdinJson) throw new CliError('--remove takes only a kind, no fields', EXIT.USAGE);
    return {};
  }
  const fields = collectFields(opts, src);
  // An empty push is how the daemon revokes a kind; never do that by accident.
  if (Object.keys(fields).length === 0) throw new CliError('no fields to push: name them, use --stdin, or pass --remove to delete the kind', EXIT.USAGE);
  return fields;
}

export async function pushCreds(client: DaemonClient, kind: string, ttlSec: number, fields: Record<string, string>): Promise<CredsPushReply> {
  const reply = await command<CredsPushReply>(client, 'creds.push', { kind, ttlSec, fields });
  return { kind: reply.kind, fields: reply.fields ?? [], removed: reply.removed === true, ...(reply.expiresAt !== undefined ? { expiresAt: reply.expiresAt } : {}) };
}

export function formatPush(r: CredsPushReply): string {
  if (r.removed) return `removed credential kind "${r.kind}"`;
  if (r.fields.length === 0) return `credential kind "${r.kind}" was not stored (nothing to remove)`;
  const until = r.expiresAt !== undefined ? `, expires ${new Date(r.expiresAt).toISOString()}` : '';
  return `pushed ${r.fields.length} field${r.fields.length === 1 ? '' : 's'} to "${r.kind}": ${r.fields.join(', ')}${until}`;
}
