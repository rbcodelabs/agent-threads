/**
 * `agent-threads doctor`: is this machine ready to be a daemon host, and is the daemon healthy?
 *
 * Every check is a pure function of a `Probes` object (the machine as seen through a few small
 * functions), so the pass/warn/fail logic is unit-tested with fabricated machines and only
 * `realProbes()` touches the real one. A check never throws: a probe that fails is the finding.
 *
 * Status meaning: pass = fine; warn = works but you probably want to fix it; fail = the daemon
 * cannot do its job (exit code 1); skip = could not be measured here (never affects the exit code).
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LISTEN, DEFAULT_PORT, DEFAULT_WORKSPACES, isLoopbackAddress, isWildcardAddress } from '../config';
import { findClaudeBinary } from '../claudeDriver';
import { sha256Hex } from '../tokenStore';
import { CLI_TOKEN_FILE } from './connection';

export type Status = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  status: Status;
  title: string;
  detail: string;
  /** What to do about a warn/fail. */
  fix?: string;
}

export interface FileStat {
  /** `mode & 0o777`. */
  mode: number;
  uid: number;
  isDirectory: boolean;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface HealthResult {
  reachable: boolean;
  status?: number;
  body?: string;
  /** The `Date` response header, parsed to epoch ms. */
  serverTime?: number;
  error?: string;
}

/** The machine, as the checks see it. */
export interface Probes {
  nodeVersion: string;
  platform: string;
  uid: number | null;
  env: NodeJS.ProcessEnv;
  home: string;
  now(): number;
  run(cmd: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
  stat(path: string): FileStat | null;
  readFile(path: string): string | null;
  readDir(path: string): string[] | null;
  /** Free and total bytes of the filesystem holding `path`; null if it cannot be asked. */
  disk(path: string): { freeBytes: number; totalBytes: number } | null;
  canWrite(path: string): boolean;
  /** Is this file executable (used for the `claude` binary lookup)? */
  findClaude(explicit: string | undefined): string | null;
  health(baseUrl: string): Promise<HealthResult>;
}

export interface DoctorTarget {
  dataDir: string;
  /** What the daemon is (or will be) configured to listen on. */
  listen: string;
  port: number;
  /** The URL clients use (http base for /healthz). */
  baseUrl: string;
  workspaces: string[];
  claudeBinaryPath?: string;
  /** Files that may carry the Claude credential for a systemd-run daemon. */
  credentialFiles: string[];
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// ── node ────────────────────────────────────────────────────────────────────

export function checkNode(p: Probes): CheckResult {
  const major = Number(p.nodeVersion.replace(/^v/, '').split('.')[0]);
  const title = 'node';
  if (!Number.isFinite(major)) return { id: 'node', status: 'warn', title, detail: `cannot read the version ("${p.nodeVersion}")` };
  if (major < 22) {
    return { id: 'node', status: 'fail', title, detail: `${p.nodeVersion} (22 or newer is required)`, fix: 'install Node 22+ (https://nodejs.org, or your distribution\'s nodesource package)' };
  }
  return { id: 'node', status: 'pass', title, detail: p.nodeVersion };
}

// ── tools ───────────────────────────────────────────────────────────────────

async function version(p: Probes, cmd: string, args: string[] = ['--version']): Promise<string | null> {
  const r = await p.run(cmd, args, 8000);
  if (!r.ok) return null;
  return (r.stdout || r.stderr).split('\n')[0].trim() || 'installed';
}

export async function checkClaude(p: Probes, explicit?: string): Promise<CheckResult> {
  const title = 'claude CLI';
  const path = p.findClaude(explicit);
  if (!path) {
    return {
      id: 'claude', status: 'fail', title, detail: explicit ? `${explicit} is not an executable file` : 'not found on PATH, ~/.local/bin or ~/.npm-global/bin',
      fix: 'install it as the daemon user: curl -fsSL https://claude.ai/install.sh | bash   (or set --claude-binary / claudeBinaryPath)',
    };
  }
  const v = await version(p, path);
  if (!v) return { id: 'claude', status: 'warn', title, detail: `${path} is present but \`--version\` failed`, fix: 'run it once by hand to see why' };
  return { id: 'claude', status: 'pass', title, detail: `${v} (${path})` };
}

export async function checkGit(p: Probes): Promise<CheckResult> {
  const v = await version(p, 'git');
  return v
    ? { id: 'git', status: 'pass', title: 'git', detail: v }
    : { id: 'git', status: 'fail', title: 'git', detail: 'not found', fix: 'apt-get install git   (agents clone, branch and commit with it)' };
}

export async function checkGh(p: Probes): Promise<CheckResult[]> {
  const title = 'gh';
  const v = await version(p, 'gh');
  if (!v) return [{ id: 'gh', status: 'warn', title, detail: 'not found (pull-request workflows will not work)', fix: 'apt-get install gh   (https://cli.github.com)' }];
  const auth = await p.run('gh', ['auth', 'status'], 8000);
  const out: CheckResult[] = [{ id: 'gh', status: 'pass', title, detail: v }];
  out.push(auth.ok
    ? { id: 'gh-auth', status: 'pass', title: 'gh login', detail: 'logged in' }
    : { id: 'gh-auth', status: 'warn', title: 'gh login', detail: 'not logged in (push and PR commands will fail)', fix: 'as the daemon user: gh auth login   (or set GH_TOKEN in the service environment)' });
  return out;
}

export async function checkRipgrep(p: Probes): Promise<CheckResult> {
  const v = await version(p, 'rg');
  return v
    ? { id: 'rg', status: 'pass', title: 'ripgrep', detail: v }
    : { id: 'rg', status: 'warn', title: 'ripgrep', detail: 'not found (code search falls back to slower tools)', fix: 'apt-get install ripgrep' };
}

// ── disk ────────────────────────────────────────────────────────────────────

export function checkDisk(p: Probes, paths: Array<{ label: string; path: string }>): CheckResult[] {
  const out: CheckResult[] = [];
  for (const { label, path } of paths) {
    const d = p.disk(path);
    const title = `disk (${label})`;
    if (!d) { out.push({ id: `disk-${label}`, status: 'skip', title, detail: `${path} does not exist or cannot be measured` }); continue; }
    const free = (d.freeBytes / GIB).toFixed(1);
    const pct = d.totalBytes > 0 ? (d.freeBytes / d.totalBytes) * 100 : 100;
    const detail = `${free} GiB free (${pct.toFixed(0)}%) at ${path}`;
    if (d.freeBytes < 500 * MIB) out.push({ id: `disk-${label}`, status: 'fail', title, detail, fix: 'free space; journals, logs and repositories need room (see journalMaxMb)' });
    else if (d.freeBytes < 5 * GIB || pct < 5) out.push({ id: `disk-${label}`, status: 'warn', title, detail, fix: 'free space soon; checkouts and builds grow quickly' });
    else out.push({ id: `disk-${label}`, status: 'pass', title, detail });
  }
  return out;
}

// ── clock ───────────────────────────────────────────────────────────────────

export const CLOCK_WARN_MS = 5_000;
export const CLOCK_FAIL_MS = 120_000;

/** Skew between this machine and the daemon's HTTP `Date` header (second resolution, so allow 1 s of rounding). */
export function checkClockSkew(p: Probes, health: HealthResult | null, ntp: boolean | null): CheckResult {
  const title = 'clock';
  if (health?.serverTime !== undefined) {
    const skew = Math.max(0, Math.abs(p.now() - health.serverTime) - 1000);
    const detail = `${(skew / 1000).toFixed(0)} s off the daemon's clock`;
    if (skew > CLOCK_FAIL_MS) return { id: 'clock', status: 'fail', title, detail, fix: 'enable time sync (timedatectl set-ntp true); sign-in and TLS fail on a skewed clock' };
    if (skew > CLOCK_WARN_MS) return { id: 'clock', status: 'warn', title, detail, fix: 'enable time sync (timedatectl set-ntp true)' };
    return { id: 'clock', status: 'pass', title, detail: ntp === false ? `${detail}; but the system reports no NTP sync` : detail };
  }
  if (ntp === true) return { id: 'clock', status: 'pass', title, detail: 'system clock is NTP-synchronised' };
  if (ntp === false) return { id: 'clock', status: 'warn', title, detail: 'the system reports no NTP sync', fix: 'timedatectl set-ntp true' };
  return { id: 'clock', status: 'skip', title, detail: 'daemon not reachable and no time-sync tool to ask' };
}

// ── credentials ─────────────────────────────────────────────────────────────

/** Names only, never values. */
export function checkCredentials(p: Probes, files: string[]): CheckResult {
  const title = 'Claude credential';
  const env = p.env;
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { id: 'credentials', status: 'pass', title, detail: 'CLAUDE_CODE_OAUTH_TOKEN is set in this environment' };
  if (env.ANTHROPIC_API_KEY) return { id: 'credentials', status: 'pass', title, detail: 'ANTHROPIC_API_KEY is set in this environment' };
  if (env.CREDENTIALS_DIRECTORY && (p.readFile(join(env.CREDENTIALS_DIRECTORY, 'claude-token')) ?? '').trim()) {
    return { id: 'credentials', status: 'pass', title, detail: 'claude-token (systemd credential)' };
  }
  for (const f of files) {
    const text = p.readFile(f);
    if (text === null) continue;
    if (/^\s*(?:export\s+)?(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)\s*=\s*\S+/m.test(text)) {
      return { id: 'credentials', status: 'pass', title, detail: `a credential is set in ${f}` };
    }
    if (f.endsWith('claude-token') && text.trim()) return { id: 'credentials', status: 'pass', title, detail: `${f} holds a token` };
  }
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(env.HOME || p.home, '.claude');
  for (const f of [join(claudeHome, '.credentials.json'), join(env.HOME || p.home, '.claude.json')]) {
    if (p.stat(f)) return { id: 'credentials', status: 'pass', title, detail: `an existing Claude login (${f})` };
  }
  return {
    id: 'credentials', status: 'fail', title, detail: 'no Claude credential found for this user',
    fix: 'as the daemon user run `claude` once and sign in, or run `claude setup-token` and put the token in the service env file (CLAUDE_CODE_OAUTH_TOKEN=...) or in the claude-token credential file',
  };
}

// ── listen address ──────────────────────────────────────────────────────────

export async function checkListen(p: Probes, t: DoctorTarget): Promise<{ listen: CheckResult; running: CheckResult; health: HealthResult }> {
  const title = 'listen address';
  let listen: CheckResult;
  if (isWildcardAddress(t.listen)) {
    listen = { id: 'listen', status: 'warn', title, detail: `${t.listen}:${t.port} (all interfaces, plain ws://)`, fix: `bind ${DEFAULT_LISTEN} and publish it with \`tailscale serve\`; the token travels in the clear otherwise` };
  } else if (!isLoopbackAddress(t.listen)) {
    listen = { id: 'listen', status: 'warn', title, detail: `${t.listen}:${t.port} (plain ws://, not loopback)`, fix: 'fine inside a VPN tunnel; otherwise bind 127.0.0.1 and use `tailscale serve` (wss)' };
  } else {
    listen = { id: 'listen', status: 'pass', title, detail: `${t.listen}:${t.port} (loopback)` };
  }
  const health = await p.health(t.baseUrl);
  let running: CheckResult;
  if (!health.reachable) {
    running = { id: 'running', status: 'warn', title: 'daemon', detail: `nothing answers at ${t.baseUrl}/healthz${health.error ? ` (${health.error})` : ''}`, fix: 'start it: systemctl --user start agent-threads   (or `agent-threads serve`)' };
  } else if (health.status !== 200 || !/"ok"\s*:\s*true/.test(health.body ?? '')) {
    running = { id: 'running', status: 'fail', title: 'daemon', detail: `${t.baseUrl}/healthz answered ${health.status} ${(health.body ?? '').slice(0, 80)}`, fix: 'something else is using this port, or the daemon is unhealthy; check its log' };
  } else {
    running = { id: 'running', status: 'pass', title: 'daemon', detail: `${t.baseUrl}/healthz ${health.body?.trim()}` };
  }
  return { listen, running, health };
}

// ── data dir ────────────────────────────────────────────────────────────────

export function checkDataDir(p: Probes, dataDir: string): CheckResult[] {
  const out: CheckResult[] = [];
  const st = p.stat(dataDir);
  if (!st) {
    out.push({ id: 'data-dir', status: 'warn', title: 'data directory', detail: `${dataDir} does not exist yet (it is created on first start)`, fix: `agent-threads serve --data-dir ${dataDir}` });
    return out;
  }
  const problems: string[] = [];
  let status: Status = 'pass';
  if (!st.isDirectory) { out.push({ id: 'data-dir', status: 'fail', title: 'data directory', detail: `${dataDir} is not a directory` }); return out; }
  if (st.mode & 0o022) { status = 'fail'; problems.push(`writable by group/others (mode ${st.mode.toString(8)})`); }
  else if (st.mode & 0o055) { status = 'warn'; problems.push(`readable by group/others (mode ${st.mode.toString(8)}); journals hold prompts and tool output`); }
  if (p.uid !== null && st.uid !== p.uid) { if (status === 'pass') status = 'warn'; problems.push(`owned by uid ${st.uid}, not you (${p.uid})`); }
  if (!p.canWrite(dataDir)) { status = 'fail'; problems.push('not writable by you'); }
  out.push({
    id: 'data-dir', status, title: 'data directory',
    detail: problems.length ? `${dataDir}: ${problems.join('; ')}` : `${dataDir} (mode ${st.mode.toString(8)})`,
    ...(status !== 'pass' ? { fix: `chmod 700 ${dataDir}   (and run the daemon and this command as the same user)` } : {}),
  });
  for (const f of ['tokens.json', CLI_TOKEN_FILE]) {
    const fs = p.stat(join(dataDir, f));
    if (fs && fs.mode & 0o077) {
      out.push({ id: `perm-${f}`, status: 'fail', title: f, detail: `mode ${fs.mode.toString(8)}: readable by group/others`, fix: `chmod 600 ${join(dataDir, f)}` });
    }
  }
  return out;
}

// ── tokens ──────────────────────────────────────────────────────────────────

interface TokenRow { sha256?: unknown; revokedAt?: unknown; name?: unknown }

export function checkTokens(p: Probes, dataDir: string): CheckResult[] {
  const title = 'tokens';
  const file = join(dataDir, 'tokens.json');
  const raw = p.readFile(file);
  if (raw === null) {
    return [{ id: 'tokens', status: 'warn', title, detail: `${file} does not exist: no client can connect yet`, fix: `agent-threads token create --name geode --scope control --data-dir ${dataDir}` }];
  }
  let rows: TokenRow[];
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed as { tokens?: unknown }).tokens;
    if (!Array.isArray(list)) throw new Error('no token list');
    rows = list as TokenRow[];
  } catch {
    return [{ id: 'tokens', status: 'fail', title, detail: `${file} is not valid JSON: the daemon rejects every login while it is damaged`, fix: 'restore it from a backup, or delete it and create tokens again' }];
  }
  const active = rows.filter((r) => r.revokedAt === null || r.revokedAt === undefined);
  const out: CheckResult[] = [];
  out.push(active.length === 0
    ? { id: 'tokens', status: 'warn', title, detail: 'no active tokens: no client can connect', fix: `agent-threads token create --name geode --scope control --data-dir ${dataDir}` }
    : { id: 'tokens', status: 'pass', title, detail: `${active.length} active, ${rows.length - active.length} revoked` });
  const cli = p.readFile(join(dataDir, CLI_TOKEN_FILE))?.trim();
  if (cli) {
    const ok = active.some((r) => r.sha256 === sha256Hex(cli));
    out.push(ok
      ? { id: 'cli-token', status: 'pass', title: 'local CLI token', detail: `${CLI_TOKEN_FILE} matches an active token` }
      : { id: 'cli-token', status: 'warn', title: 'local CLI token', detail: `${CLI_TOKEN_FILE} does not match any active token (revoked or replaced)`, fix: `agent-threads token create --name cli --scope control --save --data-dir ${dataDir}` });
  }
  return out;
}

// ── workspaces ──────────────────────────────────────────────────────────────

export function checkWorkspaces(p: Probes, workspaces: string[]): CheckResult {
  const title = 'workspaces';
  if (workspaces.length === 0) return { id: 'workspaces', status: 'warn', title, detail: 'none configured: sessions cannot start anywhere', fix: 'pass --workspace <dir>' };
  const missing = workspaces.filter((w) => !p.stat(w));
  const unwritable = workspaces.filter((w) => p.stat(w) && !p.canWrite(w));
  if (missing.length) return { id: 'workspaces', status: 'warn', title, detail: `missing: ${missing.join(', ')}`, fix: `mkdir -p ${missing.join(' ')}` };
  if (unwritable.length) return { id: 'workspaces', status: 'warn', title, detail: `not writable by you: ${unwritable.join(', ')}`, fix: 'fine for a read-only workspace; otherwise fix ownership' };
  return { id: 'workspaces', status: 'pass', title, detail: workspaces.join(', ') };
}

// ── tailscale ───────────────────────────────────────────────────────────────

export async function checkTailscale(p: Probes, port: number): Promise<CheckResult> {
  const title = 'tailscale';
  const hint = 'optional: it is how Geode reaches the daemon off your LAN over wss://';
  const st = await p.run('tailscale', ['status', '--json'], 8000);
  if (!st.ok) {
    const missing = /ENOENT|not found/i.test(st.stderr);
    return { id: 'tailscale', status: 'skip', title, detail: missing ? `not installed (${hint})` : `tailscale did not answer (${st.stderr.split('\n')[0] || 'is tailscaled running?'})` };
  }
  let state = ''; let dns = '';
  try {
    const j = JSON.parse(st.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    state = j.BackendState ?? '';
    dns = (j.Self?.DNSName ?? '').replace(/\.$/, '');
  } catch { /* fall through */ }
  if (state !== 'Running') {
    return { id: 'tailscale', status: 'warn', title, detail: `installed but ${state || 'not running'}`, fix: 'tailscale up' };
  }
  const serve = await p.run('tailscale', ['serve', 'status'], 8000);
  const serving = serve.ok && new RegExp(`(?:127\\.0\\.0\\.1|localhost):${port}\\b`).test(serve.stdout);
  return serving
    ? { id: 'tailscale', status: 'pass', title, detail: `${dns || 'connected'}; serving port ${port}` }
    : { id: 'tailscale', status: 'warn', title, detail: `${dns || 'connected'}; nothing serves port ${port} yet`, fix: `sudo tailscale serve --bg --https=8443 http://127.0.0.1:${port}   (then use wss://${dns || '<machine>.<tailnet>.ts.net'}:8443)` };
}

// ── whole run ───────────────────────────────────────────────────────────────

export async function runChecks(p: Probes, t: DoctorTarget): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(checkNode(p));
  results.push(await checkClaude(p, t.claudeBinaryPath));
  results.push(await checkGit(p));
  results.push(...(await checkGh(p)));
  results.push(await checkRipgrep(p));
  const { listen, running, health } = await checkListen(p, t);
  results.push(listen, running);
  results.push(...checkDataDir(p, t.dataDir));
  results.push(...checkTokens(p, t.dataDir));
  results.push(checkCredentials(p, t.credentialFiles));
  results.push(checkWorkspaces(p, t.workspaces));
  results.push(...checkDisk(p, [{ label: 'data', path: t.dataDir }, ...t.workspaces.slice(0, 3).map((w) => ({ label: w, path: w }))]));
  let ntp: boolean | null = null;
  if (p.platform === 'linux') {
    const r = await p.run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], 5000);
    if (r.ok) ntp = r.stdout.trim() === 'yes';
  }
  results.push(checkClockSkew(p, health.reachable ? health : null, ntp));
  results.push(await checkTailscale(p, t.port));
  return results;
}

export interface Summary { pass: number; warn: number; fail: number; skip: number }

export function summarize(results: CheckResult[]): Summary {
  const s: Summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) s[r.status]++;
  return s;
}

/** 0 when nothing failed (and, with `strict`, nothing warned). */
export function doctorExitCode(results: CheckResult[], strict: boolean): number {
  const s = summarize(results);
  return s.fail > 0 || (strict && s.warn > 0) ? 1 : 0;
}

const LABEL: Record<Status, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };

export function formatReport(results: CheckResult[], version: string): string[] {
  const width = Math.max(...results.map((r) => r.title.length), 4);
  const lines = [`agent-threads doctor ${version}`, ''];
  for (const r of results) {
    lines.push(`  ${LABEL[r.status]}  ${r.title.padEnd(width)}  ${r.detail}`);
    if (r.fix && r.status !== 'pass') lines.push(`  ${' '.repeat(4)}  ${' '.repeat(width)}  fix: ${r.fix}`);
  }
  const s = summarize(results);
  lines.push('', `${s.pass} passed, ${s.warn} warning${s.warn === 1 ? '' : 's'}, ${s.fail} failed${s.skip ? `, ${s.skip} skipped` : ''}`);
  return lines;
}

// ── the real machine ────────────────────────────────────────────────────────

function runCommand(cmd: string, args: string[], timeoutMs = 8000): Promise<CommandResult> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          resolve({ ok: false, stdout: stdout ?? '', stderr: code === 'ENOENT' ? `ENOENT ${cmd}` : (stderr || err.message) });
        } else resolve({ ok: true, stdout, stderr });
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
    }
  });
}

export function realProbes(env: NodeJS.ProcessEnv = process.env): Probes {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    env,
    home: homedir(),
    now: () => Date.now(),
    run: runCommand,
    stat(path) {
      try {
        const s = statSync(path);
        return { mode: s.mode & 0o777, uid: s.uid, isDirectory: s.isDirectory() };
      } catch { return null; }
    },
    readFile(path) {
      try { return readFileSync(path, 'utf8'); } catch { return null; }
    },
    readDir(path) {
      try { return readdirSync(path); } catch { return null; }
    },
    disk(path) {
      try {
        // statfs the nearest existing ancestor: a not-yet-created workspace is on its parent's filesystem.
        let p = path;
        while (!existsSync(p) && p !== '/' && p.includes('/')) p = p.slice(0, p.lastIndexOf('/')) || '/';
        const s = statfsSync(p);
        return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
      } catch { return null; }
    },
    canWrite(path) {
      try { accessSync(path, constants.W_OK); return true; } catch { return false; }
    },
    findClaude: (explicit) => findClaudeBinary(explicit, env),
    async health(baseUrl) {
      try {
        const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(4000) });
        const date = res.headers.get('date');
        return { reachable: true, status: res.status, body: await res.text(), ...(date && Number.isFinite(Date.parse(date)) ? { serverTime: Date.parse(date) } : {}) };
      } catch (e) {
        const cause = (e as { cause?: { code?: string } }).cause;
        return { reachable: false, error: cause?.code ?? (e instanceof Error ? e.message : String(e)) };
      }
    },
  };
}

/** Where a systemd-run daemon may keep the Claude credential, for the presence check. */
export function defaultCredentialFiles(home = homedir()): string[] {
  return [
    '/etc/agent-threads/env',
    '/etc/agent-threads/claude-token',
    join(home, '.config/agent-threads/env'),
    join(home, '.config/agent-threads/claude-token'),
  ];
}


// ── target ──────────────────────────────────────────────────────────────────

export interface DoctorFlags {
  dataDir?: string;
  url?: string;
  listen?: string;
  port?: number;
  workspaces?: string[];
  claudeBinaryPath?: string;
}

/**
 * What to inspect: flags, then the environment, then the data directory's `config.json`, then the defaults,
 * the same precedence as `serve`. Read-only (unlike `resolveConfig`, it never creates a directory).
 */
export function resolveDoctorTarget(flags: DoctorFlags, p: Probes): DoctorTarget {
  const env = p.env;
  const dirs = [env.DATA_DIR, '/var/lib/agent-threads', join(p.home, '.agent-threads'), join(p.home, '.local/state/agent-threads')].filter((d): d is string => !!d);
  const dataDir = flags.dataDir ?? dirs.find((d) => p.stat(d)?.isDirectory) ?? dirs[0] ?? join(p.home, '.agent-threads');
  let file: { listen?: unknown; port?: unknown; workspaces?: unknown; claudeBinaryPath?: unknown } = {};
  try {
    const raw = p.readFile(join(dataDir, 'config.json'));
    if (raw) file = JSON.parse(raw) as typeof file;
  } catch { /* an unreadable config shows up as its own finding when the daemon fails to start */ }
  const envPort = env.AGENT_THREADS_PORT ? Number(env.AGENT_THREADS_PORT) : undefined;
  const port = flags.port ?? envPort ?? (typeof file.port === 'number' ? file.port : DEFAULT_PORT);
  const listen = flags.listen ?? env.AGENT_THREADS_LISTEN ?? (typeof file.listen === 'string' ? file.listen : DEFAULT_LISTEN);
  const envList = (v: string | undefined): string[] | undefined => (v ? v.split(':').filter(Boolean) : undefined);
  const fileWs = Array.isArray(file.workspaces) ? file.workspaces.filter((w): w is string => typeof w === 'string') : undefined;
  const workspaces = (flags.workspaces ?? envList(env.AGENT_THREADS_WORKSPACES) ?? fileWs ?? DEFAULT_WORKSPACES).map((w) => (w === '~' ? p.home : w.startsWith('~/') ? join(p.home, w.slice(2)) : w));
  const host = isWildcardAddress(listen) ? '127.0.0.1' : listen;
  const baseUrl = flags.url
    ? flags.url.replace(/^ws/i, 'http').replace(/\/v1\/ws\/?$/, '').replace(/\/+$/, '')
    : env.AGENT_THREADS_URL
      ? env.AGENT_THREADS_URL.replace(/^ws/i, 'http').replace(/\/v1\/ws\/?$/, '').replace(/\/+$/, '')
      : `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const claudeBinaryPath = flags.claudeBinaryPath ?? (env.AGENT_THREADS_CLAUDE_BINARY || undefined) ?? (typeof file.claudeBinaryPath === 'string' ? file.claudeBinaryPath : undefined);
  return { dataDir, listen, port, baseUrl, workspaces, ...(claudeBinaryPath ? { claudeBinaryPath } : {}), credentialFiles: defaultCredentialFiles(p.home) };
}
