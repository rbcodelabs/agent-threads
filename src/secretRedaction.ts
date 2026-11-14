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

// NAME=value where NAME looks like a credential name. Keeps the name, drops the value.
//
// This is a scan, not one big replace: `NAME_EQ_RE` finds `name=` and the loop in `maskAssignments`
// decides what to do with the value. A pair whose name is not secret-ish does NOT swallow its value;
// scanning resumes right after its `=`, so `?user=bob&password=x`, `env="A=1 TOKEN=x"` and
// `opts=--token=x` still expose the nested `password=`/`TOKEN=`/`--token=`.
//
// The name must start at a boundary (so a long run is examined once, never from every offset inside
// it) and is unbounded: a bounded name silently dropped `...<80 chars>_TOKEN=`. A name may follow a
// literal backslash-n/r/t from serialized JSON (`x=1\nTOKEN=abc`), which is stripped from the name.
// `(?![=>])` keeps `==` and `=>` out.
const NAME_EQ_RE = /(\\[nrt]|^|[^A-Za-z0-9_-])([A-Za-z0-9_-]+)(\s*=(?![=>])\s*)/g;

// The value, matched sticky at its start: a quoted string (plain or JSON-escaped `\"...\"`) or a bare
// run that never swallows the backslash of a JSON escape, so serialized lines stay valid.
const VALUE_RE = /"[^"]*"|'[^']*'|\\"(?:[^"\\]|\\[^"])*\\"|(?:[^\s"'\\]|\\\\|\\(?!["'nrt]))+/y;

// A bare value ends where the next query-string pair starts (`&name=`), so the neighbours survive.
const NEXT_PAIR_RE = /[A-Za-z0-9_.%[\]-]+=/y;

const STRONG_WHOLE = new Set(['token', 'secret', 'password', 'passwd', 'passphrase', 'apikey', 'credential', 'credentials', 'authorization']);
const WEAK_WHOLE = new Set(['key', 'auth', 'pass']);
const PASSWORD_WORDS = ['password', 'passwd', 'passphrase'];
// Fused words (GITHUBTOKEN, ACCESSKEY). Bare `key` is deliberately not a suffix: MONKEY, KEYBOARD, TURKEY.
const FUSED_SUFFIXES = ['token', 'secret', 'apikey', 'accesskey', 'secretkey', 'privatekey', ...PASSWORD_WORDS];

/** Split a name on `_`, `-` and camelCase boundaries in one linear pass: `_authToken` -> auth, Token. */
function nameSegments(name: string): string[] {
  const segs: string[] = [];
  let cur = '';
  const isUpper = (c: string | undefined): boolean => c !== undefined && c >= 'A' && c <= 'Z';
  const isLower = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === '_' || c === '-') {
      if (cur) segs.push(cur);
      cur = '';
      continue;
    }
    if (cur && isUpper(c) && (isLower(name[i - 1]) || (isUpper(name[i - 1]) && name[i + 1] !== undefined && name[i + 1] >= 'a' && name[i + 1] <= 'z'))) {
      segs.push(cur);
      cur = '';
    }
    cur += c;
  }
  if (cur) segs.push(cur);
  return segs;
}

const enum NameKind { None, Weak, Strong, Password }

/**
 * How credential-like a name is. A keyword counts as a whole segment (`API_KEY`, `sessionKey`, `_authToken`)
 * or, for the long unambiguous ones, as the prefix/suffix of a fused segment (`GITHUBTOKEN`, `ACCESSKEY`,
 * `PASSWORDHASH`). PASSENGER, MONKEY, KEYBOARD, `author` and `tokens` are not.
 */
function classifyName(name: string): NameKind {
  let kind = NameKind.None;
  for (const seg of nameSegments(name)) {
    const w = seg.toLowerCase();
    let k = NameKind.None;
    if (PASSWORD_WORDS.some((pw) => w === pw || w.startsWith(pw) || w.endsWith(pw))) k = NameKind.Password;
    else if (STRONG_WHOLE.has(w) || FUSED_SUFFIXES.some((suf) => w.endsWith(suf))) k = NameKind.Strong;
    else if (WEAK_WHOLE.has(w)) k = NameKind.Weak;
    if (k > kind) kind = k;
  }
  return kind;
}

function isSecretAssignment(kind: NameKind, name: string, eq: string, value: string): boolean {
  // Env-var style (all caps) and the tight `key=value` of a query string or shell word are always masked.
  if (eq === '=' || name === name.toUpperCase()) return true;
  // Anything else is ordinary code or config with spaces around `=`: `const key = foo()`, `x.token = compute()`.
  // Mask only what is clearly a literal credential: a strong name with a quoted value (`password = "hunter2"`),
  // or a password name with a plain word (INI/TOML `password = hunter2`).
  if (kind === NameKind.Weak) return false;
  if (/^["'\\]/.test(value)) return true;
  return kind === NameKind.Password && !/[()[\]{}]/.test(value);
}

/** Where a value that starts at `start` ends: the match end, cut at the next `&name=` for a bare value. */
function valueEnd(text: string, start: number): number {
  VALUE_RE.lastIndex = start;
  const m = VALUE_RE.exec(text);
  if (!m) return start;
  const first = m[0][0];
  const end = start + m[0].length;
  if (first === '"' || first === "'" || first === '\\') return end;
  for (let amp = text.indexOf('&', start); amp !== -1 && amp < end; amp = text.indexOf('&', amp + 1)) {
    NEXT_PAIR_RE.lastIndex = amp + 1;
    if (NEXT_PAIR_RE.test(text)) return amp;
  }
  return end;
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
    const kind = classifyName(m[2]);
    if (kind === NameKind.None) continue;
    const end = valueEnd(text, valueStart);
    if (end === valueStart) continue;
    if (!isSecretAssignment(kind, m[2], m[3], text.slice(valueStart, end))) continue;
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
