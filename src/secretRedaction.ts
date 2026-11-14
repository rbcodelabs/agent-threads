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
  /** The matched token is only a secret if it also satisfies this (checked after the match, in linear time). */
  requires?: RegExp;
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
  // The digit test lives in `requires` rather than a lookahead: a lookahead rescans the whole
  // run from every `sk-` inside it (quadratic on `sk-sk-sk-...`), whereas a run consumed by one
  // match is never revisited.
  { ...shape('openai', String.raw`sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}`), requires: /[0-9]/ },
  // Atlassian API tokens (ATATT3.../ATCTT3...) and Bitbucket tokens (ATBB...)
  shape('atlassian', String.raw`AT(?:ATT|CTT)3[A-Za-z0-9_=-]{20,}|ATBB[A-Za-z0-9_=-]{28,}`),
  // Terraform Cloud / Enterprise API tokens: <14 chars>.atlasv1.<long>
  shape('terraform', String.raw`[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{50,}`),
  // Stripe secret/restricted keys (sk_live_..., rk_test_...); publishable pk_ keys are not secret
  shape('stripe', String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{20,}`),
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

// NAME=value where NAME contains a credential keyword (`main`'s substring rule). Keeps the name,
// drops the value.
//
// This is a linear scan rather than a single global replace: `NAME_EQ_RE` finds `name=` and the loop in
// `maskAssignments` decides whether to mask its value. A non-secret `name=` does NOT swallow its value;
// scanning resumes right after its `=`, so `?user=bob&password=x`, `env="A=1 TOKEN=x"` and
// `opts=--token=x` still expose the nested `password=`/`TOKEN=`/`--token=`.
//
// The name starts at a non-word boundary (so a long run is examined once, never from every offset inside
// it) and is unbounded so `...<100 chars>_TOKEN=` is still caught. Hyphenated names (`client-secret=`),
// paths (`C:\token=`) and serialized JSON newlines (`x=1\nTOKEN=`, where `nTOKEN` still matches
// `SECRET_NAME_RE` and slicing up to `valueStart` preserves `\n`) all match without eating `\t`/`\r`/`\n`.
// `(?![=>])` keeps `==` and `=>` out.
const NAME_EQ_RE = /(^|[^A-Za-z0-9_])([A-Za-z0-9_]+)(\s*=(?![=>])\s*)/g;
const SECRET_NAME_RE = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL/i;

// Quoted value matched sticky at its start: plain "...", '...', or JSON-escaped \"...\".
const QUOTED_VALUE_RE = /"[^"]*"|'[^']*'|\\"(?:[^"\\]|\\[^"])*\\"/y;

// A bare value ends where the next query-string pair starts (`&name=`), so neighbours survive.
const NEXT_PAIR_RE = /[A-Za-z0-9_.%[\]-]+=/y;

/**
 * Where a value starting at `start` ends. Quoted values match `QUOTED_VALUE_RE`; bare values scan
 * character-by-character so stopping at `&name=` or JSON escapes (`\"`, `\n`, `\r`, `\t`) is O(value)
 * instead of rescanning to the next whitespace on every `&`-separated pair.
 */
function valueEnd(text: string, start: number): number {
  if (start >= text.length) return start;
  const first = text[start];
  if (first === '"' || first === "'" || (first === '\\' && text[start + 1] === '"')) {
    QUOTED_VALUE_RE.lastIndex = start;
    const m = QUOTED_VALUE_RE.exec(text);
    return m ? start + m[0].length : start;
  }
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '"' || c === "'") break;
    if ((c.charCodeAt(0) > 127 || c === '\v' || c === '\f') && /\s/.test(c)) break;
    if (c === '\\') {
      const next = text[i + 1];
      if (next === undefined || next === '"' || next === "'" || next === 'n' || next === 'r' || next === 't') break;
      if (next === '\\') {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '&') {
      NEXT_PAIR_RE.lastIndex = i + 1;
      if (NEXT_PAIR_RE.test(text)) break;
    }
    i++;
  }
  return i;
}

function maskAssignments(text: string): string {
  let out = '';
  let copied = 0;
  const re = new RegExp(NAME_EQ_RE.source, 'g');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const valueStart = m.index + m[0].length;
    // Resume one char back so the boundary char the next name needs (`=`, ` `, `&`) is still there.
    re.lastIndex = valueStart - 1;
    if (text.startsWith('[REDACTED', valueStart)) continue;
    // Decide on the name alone first: scanning a value that is then thrown away would be quadratic on `a=a=a=...`.
    if (!SECRET_NAME_RE.test(m[2])) continue;
    const end = valueEnd(text, valueStart);
    if (end === valueStart) continue;
    out += text.slice(copied, valueStart) + redactedMarker('secret');
    copied = end;
    re.lastIndex = end - 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

// Credentials embedded in a URL: https://user:pass@host. Scheme, user and password are bounded: an
// unbounded scheme class restarted at every `.`/`+`/`-` made `a.a.a.a...` quadratic.
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,512}@/gi;

/** Object keys whose string values are always masked by `redactDeep`. */
const SECRET_KEY_RE = /^(?:.*[_-])?(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credentials?|private[_-]?key|client[_-]?secret)(?:[_-].*)?$/i;

let knownSecretsProvider: (() => readonly string[]) | null = null;

/** How long a resolved provider list is reused. Bounds the keychain/disk reads without delaying rotation pickup. */
const KNOWN_SECRETS_TTL_MS = 1000;

interface PreparedSecret {
  secret: string;
  /** JSON-string-escaped form, when it differs: inside a serialized string the value appears escaped. */
  escaped: string | null;
}
let providerCache: { at: number; list: PreparedSecret[] } | null = null;
/** The last list the provider returned successfully; still served if a later read fails (and not cached as if it were fresh). */
let lastGoodList: PreparedSecret[] = [];

/**
 * Register the source of exact secret values to mask (e.g. keychain-backed env
 * values). Resolved at most once per redaction call and reused for a second
 * (`KNOWN_SECRETS_TTL_MS`), so rotated secrets are picked up promptly; call
 * `invalidateKnownSecrets` when one is added so it applies to the very next write.
 */
export function setKnownSecretsProvider(provider: (() => readonly string[]) | null): void {
  knownSecretsProvider = provider;
  providerCache = null;
  lastGoodList = [];
}

/** Forget the cached provider list (a secret was just pushed or rotated). */
export function invalidateKnownSecrets(): void {
  providerCache = null;
}

function prepare(values: readonly unknown[]): PreparedSecret[] {
  const secrets = values.filter((s): s is string => typeof s === 'string' && s.length >= MIN_KNOWN_SECRET_LENGTH);
  // Longest first so a secret that contains another is masked whole.
  secrets.sort((a, b) => b.length - a.length);
  return secrets.map((secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return { secret, escaped: escaped !== secret ? escaped : null };
  });
}

function providedSecrets(): PreparedSecret[] {
  if (!knownSecretsProvider) return [];
  const now = Date.now();
  if (providerCache && now - providerCache.at < KNOWN_SECRETS_TTL_MS && now >= providerCache.at) return providerCache.list;
  try {
    const list = prepare(knownSecretsProvider() ?? []);
    lastGoodList = list;
    providerCache = { at: now, list };
    return list;
  } catch {
    // A failing provider must never break logging, and a failed read must not be cached as "no secrets":
    // keep masking with the last good list and retry on the next call.
    providerCache = null;
    return lastGoodList;
  }
}

/** The known secrets to mask, resolved ONCE for a whole redaction call. */
function resolveKnown(extra?: readonly string[]): PreparedSecret[] {
  const provided = providedSecrets();
  if (!extra || extra.length === 0) return provided;
  const merged = prepare([...provided.map((p) => p.secret), ...extra]);
  return merged;
}

function maskText(text: string, known: readonly PreparedSecret[]): string {
  if (!text) return text;
  let out = text;
  const marker = redactedMarker('known');
  for (const { secret, escaped } of known) {
    if (out.includes(secret)) out = out.split(secret).join(marker);
    if (escaped !== null && out.includes(escaped)) out = out.split(escaped).join(marker);
  }
  for (const { type, re, requires } of SHAPE_PATTERNS) {
    out = out.replace(re, (m: string, left: string, token: string) => (requires && !requires.test(token) ? m : `${left}${redactedMarker(type)}`));
  }
  out = out.replace(PEM_RE, redactedMarker('pem'));
  out = out.replace(OAUTH_PARAM_RE, (_m, left: string, name: string, eq: string) => `${left}${name}${eq}${redactedMarker('auth0')}`);
  out = out.replace(BEARER_RE, (_m, left: string, scheme: string, ws: string) => `${left}${scheme}${ws}${redactedMarker('bearer')}`);
  out = out.replace(URL_CREDENTIALS_RE, (_m, scheme: string) => `${scheme}${redactedMarker('url-credentials')}@`);
  return maskAssignments(out);
}

/** Mask secrets in free text. Never throws. */
export function redactSecrets(text: string, extraKnownSecrets?: readonly string[]): string {
  if (!text) return text;
  return maskText(text, resolveKnown(extraKnownSecrets));
}

/**
 * Deep-copy `value`, redacting every string and masking string values under
 * secret-looking keys. Cycle-safe (a value reachable twice without a cycle is
 * copied twice, not flagged). Non-plain objects (Error, Date, ...) are
 * reduced to their redacted string form where useful and otherwise passed on.
 */
export function redactDeep(value: unknown, extraKnownSecrets?: readonly string[]): unknown {
  const known = resolveKnown(extraKnownSecrets);
  // The objects on the CURRENT path only: a shared reference is not a cycle.
  const path = new Set<object>();
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      return key !== undefined && SECRET_KEY_RE.test(key) && v.length > 0 ? redactedMarker('secret') : maskText(v, known);
    }
    if (v === null || typeof v !== 'object') return v;
    if (path.has(v)) return '[Circular]';
    if (v instanceof Error) {
      const copy = new Error(maskText(v.message, known));
      copy.name = v.name;
      if (v.stack) copy.stack = maskText(v.stack, known);
      return copy;
    }
    if (!Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v; // Date, Map, class instances: leave as-is
    }
    path.add(v);
    try {
      if (Array.isArray(v)) return v.map((item) => walk(item));
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child, k);
      return out;
    } finally {
      path.delete(v);
    }
  };
  return walk(value);
}

/**
 * The one function every persistence sink calls before a value reaches disk
 * (logger, raw log, daemon journal, archived notes). Strings are redacted as
 * text, anything else as a structure, so redact BEFORE serializing and the
 * result is always valid JSON. Never throws: if redaction itself fails the
 * value is replaced by a marker string rather than written raw (fail closed).
 * A caller that needs a specific shape on failure (the daemon journal) must
 * check what it got back; see `daemon/redactEvent.ts`.
 */
export function redactForStorage<T>(value: T, extraKnownSecrets?: readonly string[]): T {
  try {
    if (typeof value === 'string') return redactSecrets(value, extraKnownSecrets) as unknown as T;
    return redactDeep(value, extraKnownSecrets) as T;
  } catch {
    return redactedMarker('error') as unknown as T;
  }
}
