/**
 * Secret redaction for anything that gets persisted or retained as a log:
 * the leveled logger (console + in-memory ring) and the per-thread raw JSONL
 * conversation log.
 *
 * Two layers, both applied by `redactSecrets`:
 *  1. Known values — exact secret strings supplied by a registered provider
 *     (keychain-backed env values). Catches secrets with no recognizable shape.
 *  2. Shapes — well-known token formats and `KEY=value` / `Authorization:`
 *     patterns. Catches secrets we were never told about (a command echoing a
 *     token, a pasted key).
 *
 * `redactDeep` additionally masks any string whose object key looks secret-ish
 * (`password`, `api_key`, `authorization`, …), since a JSON payload often
 * carries a bare value with no shape to match.
 *
 * Pure and mobile-safe: no Node built-ins, no I/O.
 */

export const REDACTED = '[REDACTED]';

/** Shorter known secrets are skipped: masking e.g. "abc" would shred ordinary text. */
const MIN_KNOWN_SECRET_LENGTH = 8;

const SHAPE_PATTERNS: RegExp[] = [
  // GitHub: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  // Anthropic / OpenAI style keys (sk-ant-…, sk-proj-…, sk-…)
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/g,
  // AWS access key ids
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // JSON web tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]*(?:-----END [A-Z ]*PRIVATE KEY-----)?/g,
];

// `Authorization: Bearer xyz`, `Bearer xyz`, `Authorization: Basic xyz`
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// KEY=value where KEY looks secret-ish. Keeps the key, drops the value.
const SECRET_ASSIGN_RE =
  /\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL)[A-Z0-9_]*)(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi;

// Credentials embedded in a URL: https://user:pass@host
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** Object keys whose string values are always masked by `redactDeep`. */
const SECRET_KEY_RE = /^(?:.*[_-])?(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credentials?|private[_-]?key|client[_-]?secret)(?:[_-].*)?$/i;

let knownSecretsProvider: (() => readonly string[]) | null = null;

/**
 * Register the source of exact secret values to mask (e.g. keychain-backed env
 * values). Called lazily on every redaction so rotated secrets are picked up.
 */
export function setKnownSecretsProvider(provider: (() => readonly string[]) | null): void {
  knownSecretsProvider = provider;
}

function knownSecrets(extra?: readonly string[]): string[] {
  let provided: readonly string[] = [];
  try {
    provided = knownSecretsProvider?.() ?? [];
  } catch {
    // A failing provider must never break logging.
  }
  const all = [...provided, ...(extra ?? [])].filter((s) => typeof s === 'string' && s.length >= MIN_KNOWN_SECRET_LENGTH);
  // Longest first so a secret that contains another is masked whole.
  return all.sort((a, b) => b.length - a.length);
}

/** Mask secrets in free text. Never throws. */
export function redactSecrets(text: string, extraKnownSecrets?: readonly string[]): string {
  if (!text) return text;
  let out = text;
  for (const secret of knownSecrets(extraKnownSecrets)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    // Inside a JSON-serialized string the value appears escaped.
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret && out.includes(escaped)) out = out.split(escaped).join(REDACTED);
  }
  for (const re of SHAPE_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(URL_CREDENTIALS_RE, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  out = out.replace(SECRET_ASSIGN_RE, (_m, key: string, eq: string) => `${key}${eq}${REDACTED}`);
  return out;
}

/**
 * Deep-copy `value`, redacting every string and masking string values under
 * secret-looking keys. Cycle-safe. Non-plain objects (Error, Date, …) are
 * reduced to their redacted string form where useful and otherwise passed on.
 */
export function redactDeep(value: unknown, extraKnownSecrets?: readonly string[]): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      return key !== undefined && SECRET_KEY_RE.test(key) && v.length > 0 ? REDACTED : redactSecrets(v, extraKnownSecrets);
    }
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => walk(item));
    if (v instanceof Error) {
      const copy = new Error(redactSecrets(v.message, extraKnownSecrets));
      copy.name = v.name;
      if (v.stack) copy.stack = redactSecrets(v.stack, extraKnownSecrets);
      return copy;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v; // Date, Map, class instances: leave as-is
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child, k);
    return out;
  };
  return walk(value);
}
