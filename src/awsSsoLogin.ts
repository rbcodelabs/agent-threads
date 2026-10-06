/**
 * Native AWS IAM Identity Center (SSO) sign-in — no `aws` CLI required.
 *
 * Implements the same OIDC device-authorization flow the AWS CLI uses and reads
 * / writes the same token cache (`~/.aws/sso/cache/<sha1>.json`), so the Claude
 * CLI subprocess (AWS SDK) and any `aws` the user happens to have installed
 * pick the fresh token up with no further step:
 *
 *   RegisterClient → StartDeviceAuthorization → (user approves in browser)
 *   → CreateToken (poll) → write cache → verify via the SSO portal.
 *
 * Verification calls the portal's `GetRoleCredentials` endpoint, which is what
 * the SDK's SSO provider does to turn the token into credentials — so "ok"
 * here means the Claude subprocess will be able to load credentials too.
 *
 * Desktop only. Node built-ins are required lazily so this never loads at
 * module init on mobile, and HTTP is injectable for tests.
 */

export const AWS_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 30_000;
/** Treat a token this close to expiry as expired, like the AWS SDK's refresh window. */
const EXPIRY_SKEW_MS = 5 * 60_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CLIENT_NAME = 'agent-threads';

// ── Result types ────────────────────────────────────────────────────────────

export type AwsCredentialCheck =
  | { ok: true; account: string; arn: string }
  | { ok: false; expired: boolean; error: string };

export type AwsSignInResult = { ok: true } | { ok: false; error: string };

// ── HTTP seam ───────────────────────────────────────────────────────────────

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
export interface HttpResponse {
  status: number;
  body: string;
}
export type HttpLike = (req: HttpRequest) => Promise<HttpResponse>;

/** Default transport: Node http(s), so the Electron renderer's CORS rules don't apply. */
export const nodeHttp: HttpLike = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = (url.protocol === 'http:' ? require('http') : require('https')) as typeof import('https');
    const headers: Record<string, string> = { ...req.headers };
    if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));
    const r = mod.request(
      { method: req.method, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    r.setTimeout(req.timeoutMs, () => r.destroy(new Error('request timed out')));
    r.on('error', reject);
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });

export interface SsoEndpoints {
  oidc(region: string): string;
  portal(region: string): string;
}
const AWS_ENDPOINTS: SsoEndpoints = {
  oidc: (region) => `https://oidc.${region}.amazonaws.com`,
  portal: (region) => `https://portal.sso.${region}.amazonaws.com`,
};

interface BaseOptions {
  /** Profile to use; null → AWS_PROFILE from `env`, then `default`. */
  profile: string | null;
  /** Environment: HOME, AWS_PROFILE, AWS_CONFIG_FILE. */
  env: NodeJS.ProcessEnv;
  http?: HttpLike;
  endpoints?: SsoEndpoints;
  now?: () => number;
}

// ── Profile / config parsing ────────────────────────────────────────────────

/** Minimal INI reader for ~/.aws/config: `[section]` → key/value map. */
export function parseAwsIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[\s*(.+?)\s*\]$/);
    if (section) {
      current = out[section[1].replace(/\s+/g, ' ')] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0 && current) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export interface SsoProfile {
  profile: string;
  startUrl: string;
  region: string;
  /** Scopes for client registration (`sso_registration_scopes`), if any. */
  scopes: string[];
  /** Token-cache key: the sso-session name, or the start URL for legacy profiles. */
  cacheKey: string;
  accountId: string | null;
  roleName: string | null;
}

export type SsoProfileResult = { ok: true; value: SsoProfile } | { ok: false; error: string };

export function resolveSsoProfile(iniText: string, profile: string): SsoProfileResult {
  const ini = parseAwsIni(iniText);
  const section = profile === 'default' ? (ini.default ?? ini['profile default']) : ini[`profile ${profile}`];
  if (!section) return { ok: false, error: `AWS profile "${profile}" was not found in your AWS config file.` };

  const sessionName = section.sso_session;
  let startUrl = section.sso_start_url;
  let region = section.sso_region;
  let scopes = section.sso_registration_scopes;
  let cacheKey = startUrl;
  if (sessionName) {
    const session = ini[`sso-session ${sessionName}`];
    if (!session) return { ok: false, error: `Profile "${profile}" references sso-session "${sessionName}", which is not defined in your AWS config file.` };
    startUrl = session.sso_start_url;
    region = session.sso_region;
    scopes = session.sso_registration_scopes;
    cacheKey = sessionName;
  }
  if (!startUrl || !region) {
    return { ok: false, error: `AWS profile "${profile}" is not an SSO profile (no sso_start_url / sso_region), so there is nothing to sign in to.` };
  }
  return {
    ok: true,
    value: {
      profile,
      startUrl,
      region,
      scopes: scopes ? scopes.split(/[\s,]+/).filter(Boolean) : [],
      cacheKey,
      accountId: section.sso_account_id || null,
      roleName: section.sso_role_name || null,
    },
  };
}

// ── Filesystem (lazy) ───────────────────────────────────────────────────────

function nodeFs() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('fs') as typeof import('fs');
}

function homeDir(env: NodeJS.ProcessEnv): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return env.HOME || env.USERPROFILE || (require('os') as typeof import('os')).homedir();
}

function joinPath(...parts: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('path') as typeof import('path')).join(...parts);
}

function configPath(env: NodeJS.ProcessEnv): string {
  return env.AWS_CONFIG_FILE || joinPath(homeDir(env), '.aws', 'config');
}

/** Same name the AWS CLI / SDK use: sha1 of the sso-session name (or start URL). */
export function ssoCachePath(env: NodeJS.ProcessEnv, cacheKey: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sha1 = (require('crypto') as typeof import('crypto')).createHash('sha1').update(cacheKey).digest('hex');
  return joinPath(homeDir(env), '.aws', 'sso', 'cache', `${sha1}.json`);
}

function loadProfile(opts: BaseOptions): SsoProfileResult {
  const profile = opts.profile || opts.env.AWS_PROFILE || 'default';
  let text: string;
  try {
    text = nodeFs().readFileSync(configPath(opts.env), 'utf8');
  } catch {
    return { ok: false, error: 'No AWS config file found (~/.aws/config). Configure an SSO profile with `aws configure sso` or by editing the file.' };
  }
  return resolveSsoProfile(text, profile);
}

interface CachedToken {
  startUrl?: string;
  region?: string;
  accessToken?: string;
  expiresAt?: string;
  clientId?: string;
  clientSecret?: string;
  registrationExpiresAt?: string;
  refreshToken?: string;
}

function readToken(env: NodeJS.ProcessEnv, p: SsoProfile): CachedToken | null {
  try {
    const parsed = JSON.parse(nodeFs().readFileSync(ssoCachePath(env, p.cacheKey), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CachedToken) : null;
  } catch {
    return null;
  }
}

function writeToken(env: NodeJS.ProcessEnv, p: SsoProfile, token: CachedToken): void {
  const fs = nodeFs();
  const file = ssoCachePath(env, p.cacheKey);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  fs.mkdirSync((require('path') as typeof import('path')).dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(token), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const isFuture = (iso: string | undefined, now: number, skew = 0): boolean => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t - skew > now;
};

// ── OIDC / portal calls ─────────────────────────────────────────────────────

class SsoHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function postJson(http: HttpLike, url: string, body: unknown): Promise<Record<string, unknown>> {
  let res: HttpResponse;
  try {
    res = await http({ method: 'POST', url, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), timeoutMs: HTTP_TIMEOUT_MS });
  } catch (err) {
    throw new SsoHttpError(`Couldn't reach AWS SSO (${err instanceof Error ? err.message : String(err)}). Check your network connection.`, 0);
  }
  let json: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(res.body) as unknown;
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
  } catch {
    // non-JSON body; fall through to status handling
  }
  if (res.status >= 200 && res.status < 300) return json;
  const code = typeof json.error === 'string' ? json.error : undefined;
  const desc = typeof json.error_description === 'string' ? json.error_description : typeof json.message === 'string' ? json.message : '';
  throw new SsoHttpError(desc || code || `AWS SSO returned HTTP ${res.status}`, res.status, code);
}

/** Refreshes an expired access token with its refresh token; null if that isn't possible. */
async function refreshToken(opts: BaseOptions, p: SsoProfile, token: CachedToken, http: HttpLike, endpoints: SsoEndpoints, now: number): Promise<CachedToken | null> {
  if (!token.refreshToken || !token.clientId || !token.clientSecret || !isFuture(token.registrationExpiresAt, now)) return null;
  try {
    const res = await postJson(http, `${endpoints.oidc(p.region)}/token`, {
      clientId: token.clientId,
      clientSecret: token.clientSecret,
      grantType: 'refresh_token',
      refreshToken: token.refreshToken,
    });
    if (typeof res.accessToken !== 'string') return null;
    const next: CachedToken = {
      ...token,
      accessToken: res.accessToken,
      expiresAt: new Date(now + (Number(res.expiresIn) || 3600) * 1000).toISOString(),
      refreshToken: typeof res.refreshToken === 'string' ? res.refreshToken : token.refreshToken,
    };
    writeToken(opts.env, p, next);
    return next;
  } catch {
    return null;
  }
}

/** A usable access token for the profile (refreshing if needed), or null when sign-in is required. */
async function usableAccessToken(opts: BaseOptions, p: SsoProfile, http: HttpLike, endpoints: SsoEndpoints, now: number): Promise<string | null> {
  const token = readToken(opts.env, p);
  if (!token) return null;
  if (token.accessToken && isFuture(token.expiresAt, now, EXPIRY_SKEW_MS)) return token.accessToken;
  const refreshed = await refreshToken(opts, p, token, http, endpoints, now);
  return refreshed?.accessToken ?? null;
}

/**
 * Non-interactive credential probe — used to verify a sign-in and by Settings.
 * Never opens a browser.
 */
export async function checkAwsCredentials(opts: BaseOptions): Promise<AwsCredentialCheck> {
  const http = opts.http ?? nodeHttp;
  const endpoints = opts.endpoints ?? AWS_ENDPOINTS;
  const now = (opts.now ?? Date.now)();
  const loaded = loadProfile(opts);
  if (!loaded.ok) return { ok: false, expired: false, error: loaded.error };
  const p = loaded.value;

  const accessToken = await usableAccessToken(opts, p, http, endpoints, now);
  if (!accessToken) {
    return { ok: false, expired: true, error: `The AWS SSO session for profile "${p.profile}" is expired or missing.` };
  }
  if (!p.accountId || !p.roleName) {
    // Token is valid but the profile doesn't name an account/role to exchange it for.
    return { ok: true, account: p.accountId ?? '', arn: '' };
  }
  try {
    const res = await http({
      method: 'GET',
      url: `${endpoints.portal(p.region)}/federation/credentials?role_name=${encodeURIComponent(p.roleName)}&account_id=${encodeURIComponent(p.accountId)}`,
      headers: { 'x-amz-sso_bearer_token': accessToken, accept: 'application/json' },
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, account: p.accountId, arn: `role/${p.roleName}` };
    if (res.status === 401) return { ok: false, expired: true, error: `AWS rejected the SSO session for profile "${p.profile}" (it was revoked or expired).` };
    if (res.status === 403) {
      return { ok: false, expired: false, error: `Signed in, but your user has no access to role "${p.roleName}" in account ${p.accountId}.` };
    }
    return { ok: false, expired: false, error: `AWS SSO returned HTTP ${res.status} while checking credentials.` };
  } catch (err) {
    return { ok: false, expired: false, error: `Couldn't reach AWS SSO (${err instanceof Error ? err.message : String(err)}). Check your network connection.` };
  }
}

export interface AwsSignInOptions extends BaseOptions {
  timeoutMs?: number;
  onProgress?: (text: string) => void;
  /** The verification URL (already contains the code) — shown as a fallback link. */
  onUrl?: (url: string) => void;
  /** The device user code, shown for the user to confirm matches the browser page. */
  onCode?: (code: string) => void;
  /** Opens the verification URL. Called once, right after the user clicked Sign in. */
  openUrl?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function signInToAws(opts: AwsSignInOptions): Promise<AwsSignInResult> {
  const http = opts.http ?? nodeHttp;
  const endpoints = opts.endpoints ?? AWS_ENDPOINTS;
  const clock = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? AWS_SIGN_IN_TIMEOUT_MS;

  const loaded = loadProfile(opts);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const p = loaded.value;

  try {
    opts.onProgress?.('Contacting AWS SSO…');
    const oidc = endpoints.oidc(p.region);
    const client = await postJson(http, `${oidc}/client/register`, {
      clientName: CLIENT_NAME,
      clientType: 'public',
      ...(p.scopes.length ? { scopes: p.scopes } : {}),
    });
    const clientId = client.clientId;
    const clientSecret = client.clientSecret;
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
      return { ok: false, error: 'AWS SSO returned an unexpected response while registering the sign-in client.' };
    }
    const registrationExpiresAt = typeof client.clientSecretExpiresAt === 'number' ? new Date(client.clientSecretExpiresAt * 1000).toISOString() : undefined;

    const device = await postJson(http, `${oidc}/device_authorization`, { clientId, clientSecret, startUrl: p.startUrl });
    const deviceCode = device.deviceCode;
    const url = (device.verificationUriComplete || device.verificationUri) as unknown;
    if (typeof deviceCode !== 'string' || typeof url !== 'string') {
      return { ok: false, error: 'AWS SSO returned an unexpected response while starting sign-in.' };
    }
    // The URL comes from a network response and is about to be handed to the OS.
    if (!/^https:\/\//i.test(url)) return { ok: false, error: 'AWS SSO returned an unexpected verification URL.' };
    if (typeof device.userCode === 'string') opts.onCode?.(device.userCode);
    opts.onUrl?.(url);
    try {
      opts.openUrl?.(url);
    } catch {
      // the fallback link from onUrl stays available
    }
    opts.onProgress?.('Waiting for browser sign-in…');

    const start = clock();
    const deadline = start + Math.min(timeoutMs, (Number(device.expiresIn) || 600) * 1000);
    let intervalMs = Math.max(1, Number(device.interval) || 5) * 1000;
    for (;;) {
      await sleep(intervalMs);
      if (clock() >= deadline) {
        return { ok: false, error: `Sign-in timed out after ${Math.max(1, Math.round((clock() - start) / 60_000))} min. Try again.` };
      }
      try {
        const tok = await postJson(http, `${oidc}/token`, { clientId, clientSecret, deviceCode, grantType: DEVICE_GRANT });
        if (typeof tok.accessToken !== 'string') return { ok: false, error: 'AWS SSO returned no access token.' };
        writeToken(opts.env, p, {
          startUrl: p.startUrl,
          region: p.region,
          accessToken: tok.accessToken,
          expiresAt: new Date(clock() + (Number(tok.expiresIn) || 3600) * 1000).toISOString(),
          clientId,
          clientSecret,
          ...(registrationExpiresAt ? { registrationExpiresAt } : {}),
          ...(typeof tok.refreshToken === 'string' ? { refreshToken: tok.refreshToken } : {}),
        });
        break;
      } catch (err) {
        const code = err instanceof SsoHttpError ? err.code : undefined;
        if (code === 'authorization_pending') continue;
        if (code === 'slow_down') {
          intervalMs += 5000;
          continue;
        }
        if (code === 'expired_token') return { ok: false, error: 'The sign-in request expired before it was approved. Try again.' };
        if (code === 'access_denied') return { ok: false, error: 'Sign-in was denied in the browser.' };
        throw err;
      }
    }

    opts.onProgress?.('Checking sign-in…');
    const check = await checkAwsCredentials({ ...opts, now: clock });
    if (!check.ok) return { ok: false, error: `Sign-in finished but AWS credentials are still not usable.\n${check.error}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
