import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  AWS_SIGN_IN_TIMEOUT_MS,
  checkAwsCredentials,
  nodeHttp,
  parseAwsIni,
  resolveSsoProfile,
  signInToAws,
  ssoCachePath,
  type AwsSignInOptions,
  type SsoEndpoints,
} from '../../src/awsSsoLogin';

const CONFIG = `
# comment
[default]
sso_session = corp
sso_account_id = 111111111111
sso_role_name = Admin

[profile dev]
sso_session = corp
sso_account_id = 222222222222
sso_role_name = Dev

[profile legacy]
sso_start_url = https://legacy.awsapps.com/start
sso_region = eu-west-1
sso_account_id = 333333333333
sso_role_name = Reader

[profile static]
region = us-east-1

[profile orphan]
sso_session = nope

[profile nocreds]
sso_session = corp

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = us-east-2
sso_registration_scopes = sso:account:access, extra:scope
`;

const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();
const PAST = () => new Date(Date.now() - 3600_000).toISOString();

interface Recorded { method: string; url: string; headers: http.IncomingHttpHeaders; body: unknown }

/** A real local HTTP server standing in for oidc.<region> and portal.sso.<region>. */
class FakeAws {
  requests: Recorded[] = [];
  tokenResponses: Array<{ status: number; body: unknown }> = [];
  portalStatus = 200;
  registerBody: Record<string, unknown> = { clientId: 'cid', clientSecret: 'csecret', clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400 };
  deviceBody: Record<string, unknown> = {
    deviceCode: 'dcode',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://device.sso.us-east-2.amazonaws.com/',
    verificationUriComplete: 'https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-EFGH',
    expiresIn: 600,
    interval: 1,
  };
  private server: http.Server | null = null;
  base = '';

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : undefined;
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.url === '/client/register') return send(200, this.registerBody);
        if (req.url === '/device_authorization') return send(200, this.deviceBody);
        if (req.url === '/token') {
          const next = this.tokenResponses.shift() ?? { status: 400, body: { error: 'authorization_pending' } };
          return send(next.status, next.body);
        }
        if (req.url?.startsWith('/federation/credentials')) return send(this.portalStatus, this.portalStatus === 200 ? { roleCredentials: {} } : { message: 'nope' });
        send(404, {});
      });
    });
    this.server = server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
  get endpoints(): SsoEndpoints {
    return { oidc: () => this.base, portal: () => this.base };
  }
  ofUrl(prefix: string): Recorded[] {
    return this.requests.filter((r) => r.url.startsWith(prefix));
  }
}

let home: string;
let aws: FakeAws;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'awssso-'));
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aws', 'config'), CONFIG);
  env = { HOME: home };
  aws = new FakeAws();
  await aws.start();
});
afterEach(async () => {
  await aws.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeCache(key: string, token: Record<string, unknown>): void {
  const file = ssoCachePath(env, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(token));
}
const readCache = (key: string) => JSON.parse(fs.readFileSync(ssoCachePath(env, key), 'utf8')) as Record<string, unknown>;

describe('config parsing', () => {
  it('parses sections, comments and spacing', () => {
    const ini = parseAwsIni(CONFIG);
    expect(ini['profile dev'].sso_role_name).toBe('Dev');
    expect(ini['sso-session corp'].sso_start_url).toBe('https://corp.awsapps.com/start');
  });

  it('resolves an sso-session profile with scopes', () => {
    const res = resolveSsoProfile(CONFIG, 'dev');
    expect(res).toMatchObject({ ok: true, value: { startUrl: 'https://corp.awsapps.com/start', region: 'us-east-2', cacheKey: 'corp', accountId: '222222222222', roleName: 'Dev', scopes: ['sso:account:access', 'extra:scope'] } });
  });

  it('resolves [default] and a legacy profile keyed by start URL', () => {
    expect(resolveSsoProfile(CONFIG, 'default')).toMatchObject({ ok: true, value: { accountId: '111111111111' } });
    expect(resolveSsoProfile(CONFIG, 'legacy')).toMatchObject({ ok: true, value: { cacheKey: 'https://legacy.awsapps.com/start', region: 'eu-west-1' } });
  });

  it('explains missing, non-SSO and dangling-session profiles', () => {
    expect(resolveSsoProfile(CONFIG, 'ghost')).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
    expect(resolveSsoProfile(CONFIG, 'static')).toMatchObject({ ok: false, error: expect.stringContaining('not an SSO profile') });
    expect(resolveSsoProfile(CONFIG, 'orphan')).toMatchObject({ ok: false, error: expect.stringContaining('not defined') });
  });

  it('uses the same cache file name as the AWS CLI (sha1 of the session name)', () => {
    const sha = crypto.createHash('sha1').update('corp').digest('hex');
    expect(ssoCachePath(env, 'corp')).toBe(path.join(home, '.aws', 'sso', 'cache', `${sha}.json`));
  });
});

describe('checkAwsCredentials', () => {
  const base = () => ({ env, endpoints: aws.endpoints, profile: 'dev' });

  it('reports expired when there is no cached token', async () => {
    expect(await checkAwsCredentials(base())).toMatchObject({ ok: false, expired: true });
  });

  it('is ok with a valid token the portal accepts, sending the bearer token and role', async () => {
    writeCache('corp', { accessToken: 'tok', expiresAt: FUTURE() });
    expect(await checkAwsCredentials(base())).toEqual({ ok: true, account: '222222222222', arn: 'role/Dev' });
    const req = aws.ofUrl('/federation/credentials')[0];
    expect(req.url).toContain('role_name=Dev');
    expect(req.url).toContain('account_id=222222222222');
    expect(req.headers['x-amz-sso_bearer_token']).toBe('tok');
  });

  it('treats a portal 401 as an expired session and a 403 as an access problem', async () => {
    writeCache('corp', { accessToken: 'tok', expiresAt: FUTURE() });
    aws.portalStatus = 401;
    expect(await checkAwsCredentials(base())).toMatchObject({ ok: false, expired: true });
    aws.portalStatus = 403;
    expect(await checkAwsCredentials(base())).toMatchObject({ ok: false, expired: false, error: expect.stringContaining('no access to role "Dev"') });
  });

  it('refreshes an expired access token with the refresh token and rewrites the cache', async () => {
    writeCache('corp', { accessToken: 'old', expiresAt: PAST(), refreshToken: 'r1', clientId: 'cid', clientSecret: 'cs', registrationExpiresAt: FUTURE(), startUrl: 'u', region: 'us-east-2' });
    aws.tokenResponses.push({ status: 200, body: { accessToken: 'new', expiresIn: 3600, refreshToken: 'r2' } });
    expect(await checkAwsCredentials(base())).toMatchObject({ ok: true });
    expect(aws.ofUrl('/token')[0].body).toEqual({ clientId: 'cid', clientSecret: 'cs', grantType: 'refresh_token', refreshToken: 'r1' });
    expect(readCache('corp')).toMatchObject({ accessToken: 'new', refreshToken: 'r2', startUrl: 'u', clientId: 'cid' });
    expect(aws.ofUrl('/federation/credentials')[0].headers['x-amz-sso_bearer_token']).toBe('new');
  });

  it('reports expired when the refresh is rejected or the registration has lapsed', async () => {
    writeCache('corp', { accessToken: 'old', expiresAt: PAST(), refreshToken: 'r1', clientId: 'cid', clientSecret: 'cs', registrationExpiresAt: FUTURE() });
    aws.tokenResponses.push({ status: 400, body: { error: 'invalid_grant' } });
    expect(await checkAwsCredentials(base())).toMatchObject({ ok: false, expired: true });

    aws.requests = [];
    writeCache('corp', { accessToken: 'old', expiresAt: PAST(), refreshToken: 'r1', clientId: 'cid', clientSecret: 'cs', registrationExpiresAt: PAST() });
    expect(await checkAwsCredentials(base())).toMatchObject({ ok: false, expired: true });
    expect(aws.ofUrl('/token')).toHaveLength(0);
  });

  it('treats a token inside the 5-minute refresh window as expired', async () => {
    writeCache('corp', { accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await checkAwsCredentials(base())).toMatchObject({ ok: false, expired: true });
  });

  it('accepts a valid token when the profile names no account/role to exchange', async () => {
    writeCache('corp', { accessToken: 'tok', expiresAt: FUTURE() });
    expect(await checkAwsCredentials({ ...base(), profile: 'nocreds' })).toEqual({ ok: true, account: '', arn: '' });
    expect(aws.ofUrl('/federation')).toHaveLength(0);
  });

  it('falls back to AWS_PROFILE, then default, when no profile is given', async () => {
    writeCache('corp', { accessToken: 'tok', expiresAt: FUTURE() });
    expect(await checkAwsCredentials({ env: { ...env, AWS_PROFILE: 'dev' }, endpoints: aws.endpoints, profile: null })).toMatchObject({ account: '222222222222' });
    expect(await checkAwsCredentials({ env, endpoints: aws.endpoints, profile: null })).toMatchObject({ account: '111111111111' });
  });

  it('reports non-SSO profiles and a missing config as non-expired errors', async () => {
    expect(await checkAwsCredentials({ ...base(), profile: 'static' })).toMatchObject({ ok: false, expired: false });
    fs.rmSync(path.join(home, '.aws', 'config'));
    expect(await checkAwsCredentials(base())).toMatchObject({ ok: false, expired: false, error: expect.stringContaining('No AWS config file') });
  });

  it('honours AWS_CONFIG_FILE', async () => {
    const alt = path.join(home, 'alt-config');
    fs.writeFileSync(alt, '[profile x]\nsso_start_url = https://x.awsapps.com/start\nsso_region = us-west-2\n');
    expect(await checkAwsCredentials({ env: { ...env, AWS_CONFIG_FILE: alt }, endpoints: aws.endpoints, profile: 'x' })).toMatchObject({ ok: false, expired: true });
  });

  it('reports an unreachable endpoint as a network error, not an expired session', async () => {
    writeCache('corp', { accessToken: 'tok', expiresAt: FUTURE() });
    await aws.stop();
    const res = await checkAwsCredentials(base());
    expect(res).toMatchObject({ ok: false, expired: false, error: expect.stringContaining("Couldn't reach AWS SSO") });
  });
});

describe('signInToAws', () => {
  const sleeps: number[] = [];
  const opts = (extra: Partial<AwsSignInOptions> = {}): AwsSignInOptions => ({
    env,
    endpoints: aws.endpoints,
    profile: 'dev',
    sleep: async (ms: number) => { sleeps.push(ms); },
    ...extra,
  });
  beforeEach(() => { sleeps.length = 0; });

  it('runs the device flow, opens the URL, writes a CLI-compatible cache and verifies', async () => {
    aws.tokenResponses.push(
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 28800, tokenType: 'Bearer' } },
    );
    const urls: string[] = [];
    const opened: string[] = [];
    const codes: string[] = [];
    const progress: string[] = [];
    const res = await signInToAws(opts({ onUrl: (u) => urls.push(u), openUrl: (u) => { opened.push(u); }, onCode: (c) => codes.push(c), onProgress: (t) => progress.push(t) }));
    expect(res).toEqual({ ok: true });

    expect(urls).toEqual(['https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-EFGH']);
    expect(opened).toEqual(urls);
    expect(codes).toEqual(['ABCD-EFGH']);
    expect(progress).toEqual(['Contacting AWS SSO…', 'Waiting for browser sign-in…', 'Checking sign-in…']);

    expect(aws.ofUrl('/client/register')[0].body).toEqual({ clientName: 'agent-threads', clientType: 'public', scopes: ['sso:account:access', 'extra:scope'] });
    expect(aws.ofUrl('/device_authorization')[0].body).toEqual({ clientId: 'cid', clientSecret: 'csecret', startUrl: 'https://corp.awsapps.com/start' });
    expect(aws.ofUrl('/token')[0].body).toEqual({ clientId: 'cid', clientSecret: 'csecret', deviceCode: 'dcode', grantType: 'urn:ietf:params:oauth:grant-type:device_code' });
    expect(aws.ofUrl('/token')).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000, 1000]);

    const cache = readCache('corp');
    expect(Object.keys(cache).sort()).toEqual(['accessToken', 'clientId', 'clientSecret', 'expiresAt', 'refreshToken', 'region', 'registrationExpiresAt', 'startUrl']);
    expect(cache).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', clientId: 'cid', startUrl: 'https://corp.awsapps.com/start', region: 'us-east-2' });
    expect(Date.parse(cache.expiresAt as string)).toBeGreaterThan(Date.now() + 7 * 3600_000);
    if (process.platform !== 'win32') expect(fs.statSync(ssoCachePath(env, 'corp')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(ssoCachePath(env, 'corp'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    expect(aws.ofUrl('/federation/credentials')[0].headers['x-amz-sso_bearer_token']).toBe('AT');
    // The token it wrote is what a later probe (or the Claude CLI's SDK) reads.
    expect(await checkAwsCredentials({ env, endpoints: aws.endpoints, profile: 'dev' })).toMatchObject({ ok: true });
  });

  it('backs off on slow_down', async () => {
    aws.tokenResponses.push({ status: 400, body: { error: 'slow_down' } }, { status: 200, body: { accessToken: 'AT', expiresIn: 3600 } });
    expect(await signInToAws(opts())).toEqual({ ok: true });
    expect(sleeps).toEqual([1000, 6000]);
  });

  it('reports a denied or expired approval', async () => {
    aws.tokenResponses.push({ status: 400, body: { error: 'access_denied' } });
    expect(await signInToAws(opts())).toEqual({ ok: false, error: 'Sign-in was denied in the browser.' });
    aws.tokenResponses.push({ status: 400, body: { error: 'expired_token' } });
    expect(await signInToAws(opts())).toMatchObject({ ok: false, error: expect.stringContaining('expired before it was approved') });
    expect(fs.existsSync(ssoCachePath(env, 'corp'))).toBe(false);
  });

  it('surfaces an unexpected token error with its description', async () => {
    aws.tokenResponses.push({ status: 500, body: { error: 'server_error', error_description: 'kaboom' } });
    expect(await signInToAws(opts())).toEqual({ ok: false, error: 'kaboom' });
  });

  it('times out while waiting for approval', async () => {
    let t = 1_000_000;
    const res = await signInToAws(opts({ now: () => t, sleep: async (ms: number) => { t += ms * 100; }, timeoutMs: 60_000 }));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('timed out') });
    expect(AWS_SIGN_IN_TIMEOUT_MS).toBe(300_000);
  });

  it('refuses a non-https verification URL and never opens it', async () => {
    aws.deviceBody = { ...aws.deviceBody, verificationUriComplete: 'file:///etc/passwd' };
    const opened: string[] = [];
    const res = await signInToAws(opts({ openUrl: (u) => { opened.push(u); } }));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('unexpected verification URL') });
    expect(opened).toEqual([]);
  });

  it('still signs in when opening the browser throws (fallback link remains)', async () => {
    aws.tokenResponses.push({ status: 200, body: { accessToken: 'AT', expiresIn: 3600 } });
    const urls: string[] = [];
    const res = await signInToAws(opts({ onUrl: (u) => urls.push(u), openUrl: () => { throw new Error('no browser'); } }));
    expect(res).toEqual({ ok: true });
    expect(urls).toHaveLength(1);
  });

  it('reports a sign-in that completed but is still unusable', async () => {
    aws.tokenResponses.push({ status: 200, body: { accessToken: 'AT', expiresIn: 3600 } });
    aws.portalStatus = 403;
    const res = await signInToAws(opts());
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Sign-in finished but AWS credentials are still not usable.') });
  });

  it('fails clearly for a profile that is not SSO, without any network call', async () => {
    const res = await signInToAws(opts({ profile: 'static' }));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('not an SSO profile') });
    expect(aws.requests).toHaveLength(0);
  });

  it('reports an unreachable SSO endpoint', async () => {
    await aws.stop();
    const res = await signInToAws(opts());
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("Couldn't reach AWS SSO") });
  });

  it('treats a hostile profile name as data only', async () => {
    const res = await signInToAws(opts({ profile: 'x; rm -rf ~ $(touch /tmp/pwn)' }));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
    expect(fs.existsSync('/tmp/pwn')).toBe(false);
  });
});

describe('nodeHttp', () => {
  it('round-trips JSON over a real socket and rejects when nothing is listening', async () => {
    const res = await nodeHttp({ method: 'POST', url: `${aws.base}/client/register`, headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).clientId).toBe('cid');
    const dead = aws.base;
    await aws.stop();
    await expect(nodeHttp({ method: 'GET', url: `${dead}/x`, headers: {}, timeoutMs: 2000 })).rejects.toThrow();
  });
});
