/**
 * Secret redaction for anything that gets persisted or retained as a log:
 * the leveled logger (console + in-memory ring), the per-thread raw JSONL
 * conversation log, the daemon journal (and the client frames served from it)
 * and archived thread notes.
 *
 * Every persistence sink goes through `redactForStorage`, so a new sink has one
 * obvious function to call. Two layers sit behind it:
 *  1. Known values: exact secret strings supplied by a registered provider
 *     (keychain-backed env values). Catches secrets with no recognizable shape.
 *  2. Shapes: well-known token formats and `KEY=value` / `Authorization:`
 *     patterns. Catches secrets we were never told about (a command echoing a
 *     token, a pasted key).
 *
 * `redactDeep` additionally masks any string whose object key looks secret-ish
 * (`password`, `api_key`, `authorization`, ...), since a JSON payload often
 * carries a bare value with no shape to match.
 *
 * Replacements are typed markers, `[REDACTED:github]`. They contain no quote or
 * backslash, so masking a value never breaks the JSON string it sits in. Prefer
 * redacting the structured value before serializing; the patterns are also
 * tolerant of already-serialized JSON (escaped `\n`, escaped quotes).
 *
 * Redaction is at rest only: the live model turn keeps the real value.
 *
 * Pure and mobile-safe: no Node built-ins, no I/O, no regex lookbehind.
 */

/** Generic marker, kept for callers that only need "something was masked". */
export const REDACTED = '[REDACTED]';

/** Typed marker, e.g. `redactedMarker('github')` -> `[REDACTED:github]`. */
export function redactedMarker(type: string): string {
  return `[REDACTED:${type}]`;
}

/** Shorter known secrets are skipped: masking e.g. "abc" would shred ordinary text. */
const MIN_KNOWN_SECRET_LENGTH = 8;

/**
 * Token boundary on the left. A plain `\b` fails after an escaped newline in
 * serialized JSONL (`...\nghp_xxx`: the `n` of `\n` is a word character), so a
 * token may also follow a literal backslash-n/r/t. Captured (not a lookbehind)
 * so it works on every mobile WebView, and re-emitted by the replacer.
 */
const LEFT = String.raw`(^|[^A-Za-z0-9_]|\\[nrt])`;
/** Token boundary on the right (a `\b` would not end after `=` or `-`). */
const RIGHT = '(?![A-Za-z0-9_])';

interface ShapePattern {
  type: string;
  re: RegExp;
}

function shape(type: string, body: string): ShapePattern {
  return { type, re: new RegExp(`${LEFT}(${body})${RIGHT}`, 'g') };
}

const SHAPE_PATTERNS: ShapePattern[] = [
  // GitHub: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_
  shape('github', String.raw`gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}`),
  // Anthropic keys and OAuth tokens (sk-ant-api03-..., sk-ant-oat01-...)
  shape('anthropic', String.raw`sk-ant-[A-Za-z0-9_-]{20,}`),
  // OpenAI-style keys (sk-..., sk-proj-...). Must contain a digit: real keys do,
  // and it keeps long hyphenated words ("sk-learn-pipeline-...") from matching.
  shape('openai', String.raw`sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}`),
  // Atlassian API tokens (ATATT3.../ATCTT3...) and Bitbucket tokens (ATBB...)
  shape('atlassian', String.raw`AT(?:ATT|CTT)3[A-Za-z0-9_=-]{20,}|ATBB[A-Za-z0-9_=-]{28,}`),
  // Terraform Cloud / Enterprise API tokens: <14 chars>.atlasv1.<long>
  shape('terraform', String.raw`[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{50,}`),
  // AWS access key ids
  shape('aws', String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`),
  // Slack tokens
  shape('slack', String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`),
  // Google API keys
  shape('google', String.raw`AIza[0-9A-Za-z_-]{35}`),
  // JSON web tokens (also what Auth0 access/id tokens are)
  shape('jwt', String.raw`eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
];

// OAuth/Auth0-style credential parameters in form bodies and query strings:
// `client_secret=...&grant_type=...`. The value stops at `&`, so neighbouring
// parameters survive. Keeps the name, drops the value.
const OAUTH_PARAM_RE = new RegExp(
  `${LEFT}((?:client_secret|client_assertion|refresh_token|id_token|access_token|code_verifier))(=)([^&\\s"'\\\\]{8,})`,
  'gi',
);

// PEM private key blocks. `"` is excluded from the body so an unterminated
// block inside a serialized JSON string cannot swallow the closing quote.
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[^-"]*(?:-----END [A-Z ]*PRIVATE KEY-----)?/g;

// `Authorization: Bearer xyz`, `Bearer xyz`, `Authorization: Basic xyz`
const BEARER_RE = new RegExp(`${LEFT}(Bearer|Basic)(\\s+)[A-Za-z0-9._~+/=-]{8,}`, 'gi');

// KEY=value where KEY looks secret-ish. Keeps the key, drops the value. The
// value is a quoted string (plain or JSON-escaped `\"...\"`) or a bare run that
// never swallows the backslash of a JSON escape, so serialized lines stay valid.
const SECRET_ASSIGN_RE =
  /\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL)[A-Z0-9_]*)(\s*=\s*)(?!\[REDACTED)(?:"[^"]*"|'[^']*'|\\"(?:[^"\\]|\\[^"])*\\"|(?:[^\s"'\\]|\\\\|\\(?!["'nrt]))+)/gi;

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
  const known = redactedMarker('known');
  for (const secret of knownSecrets(extraKnownSecrets)) {
    if (out.includes(secret)) out = out.split(secret).join(known);
    // Inside a JSON-serialized string the value appears escaped.
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret && out.includes(escaped)) out = out.split(escaped).join(known);
  }
  for (const { type, re } of SHAPE_PATTERNS) {
    out = out.replace(re, (_m, left: string) => `${left}${redactedMarker(type)}`);
  }
  out = out.replace(PEM_RE, redactedMarker('pem'));
  out = out.replace(OAUTH_PARAM_RE, (_m, left: string, name: string, eq: string) => `${left}${name}${eq}${redactedMarker('auth0')}`);
  out = out.replace(BEARER_RE, (_m, left: string, scheme: string, ws: string) => `${left}${scheme}${ws}${redactedMarker('bearer')}`);
  out = out.replace(URL_CREDENTIALS_RE, (_m, scheme: string) => `${scheme}${redactedMarker('url-credentials')}@`);
  out = out.replace(SECRET_ASSIGN_RE, (_m, key: string, eq: string) => `${key}${eq}${redactedMarker('secret')}`);
  return out;
}

/**
 * Deep-copy `value`, redacting every string and masking string values under
 * secret-looking keys. Cycle-safe. Non-plain objects (Error, Date, ...) are
 * reduced to their redacted string form where useful and otherwise passed on.
 */
export function redactDeep(value: unknown, extraKnownSecrets?: readonly string[]): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      return key !== undefined && SECRET_KEY_RE.test(key) && v.length > 0 ? redactedMarker('secret') : redactSecrets(v, extraKnownSecrets);
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

/**
 * The one function every persistence sink calls before a value reaches disk
 * (logger, raw log, daemon journal, archived notes). Strings are redacted as
 * text, anything else as a structure, so redact BEFORE serializing and the
 * result is always valid JSON. Never throws: if redaction itself fails the
 * value is replaced by a marker rather than written raw (fail closed).
 */
export function redactForStorage<T>(value: T, extraKnownSecrets?: readonly string[]): T {
  try {
    if (typeof value === 'string') return redactSecrets(value, extraKnownSecrets) as unknown as T;
    return redactDeep(value, extraKnownSecrets) as T;
  } catch {
    return redactedMarker('error') as unknown as T;
  }
}
