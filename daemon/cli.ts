/**
 * `agent-threads` command line:
 *
 *   agent-threads serve [--listen H] [--port N] [--data-dir D] [--allow-origin O]... [--i-know-this-is-open]
 *   agent-threads token create --name N [--scope read|control|admin]
 *   agent-threads token list
 *   agent-threads token revoke <id|name>
 */
import { ensureDir } from './fsutil';
import { resolveConfig, defaultDataDir, type ConfigInputs } from './config';
import { startDaemon } from './server';
import { TOKEN_SCOPES, TokenStore, type TokenScope } from './tokenStore';
import { DAEMON_VERSION } from './version';

const USAGE = `agent-threads ${DAEMON_VERSION}

Usage:
  agent-threads serve [options]           run the daemon
  agent-threads token create --name N [--scope read|control|admin]
  agent-threads token list
  agent-threads token revoke <id|name>
  agent-threads --version

serve options:
  --listen <host>        bind address (default 127.0.0.1; use "tailscale serve" for wss)
  --port <n>             port (default 7433)
  --data-dir <dir>       state directory (env DATA_DIR; default /var/lib/agent-threads or ~/.agent-threads)
  --allow-origin <o>     browser Origin allowed to connect (repeatable; env AGENT_THREADS_ALLOWED_ORIGINS, comma separated)
  --i-know-this-is-open  required to bind 0.0.0.0 / ::
  --workspace <dir>      directory sessions may run in (repeatable; env AGENT_THREADS_WORKSPACES, colon separated; default /srv/workspaces)
  --readonly-workspace <dir>  like --workspace, but the harness's edit tools are denied and acceptEdits/auto/bypass modes are refused there (repeatable; env AGENT_THREADS_READONLY_WORKSPACES; shell commands are not blocked)
  --allow-bypass         accept permissionMode bypassPermissions (off by default; config.json allowBypass)
  --max-concurrent-turns <n>   turns running at once (default 3)
  --idle-reap-minutes <n>      stop a session idle this long; the next send resumes it (default 30, 0 = off)
  --journal-ttl-days <n>       drop replay-journal entries older than this (default 7, 0 = keep); a client away longer resyncs
  --journal-max-mb <n>         cap one thread's replay journal at about this many MB (default 64, 0 = no cap)
  --claude-binary <path> path to the claude CLI (env AGENT_THREADS_CLAUDE_BINARY; default: PATH, ~/.npm-global/bin, ~/.local/bin)
  --fake-harness         scripted stand-in instead of Claude (tests and smoke runs only)

The token commands accept --data-dir too.
`;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
  bools: Set<string>;
}

const BOOLEAN_FLAGS = new Set(['i-know-this-is-open', 'help', 'version', 'allow-bypass', 'fake-harness']);

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positionals: [], flags: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.positionals.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) { out.bools.add(name); continue; }
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    out.flags.set(name, [...(out.flags.get(name) ?? []), value]);
  }
  return out;
}

const one = (p: Parsed, name: string): string | undefined => p.flags.get(name)?.at(-1);

function dataDirOf(p: Parsed): string {
  return one(p, 'data-dir') ?? (process.env.DATA_DIR || undefined) ?? defaultDataDir();
}

function fmt(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString();
}

export async function runCli(argv: string[], io: Io = consoleIo): Promise<number> {
  let p: Parsed;
  try { p = parseArgs(argv); } catch (e) { io.err((e as Error).message); return 2; }
  const [cmd, sub] = p.positionals;

  if (p.bools.has('version')) { io.out(DAEMON_VERSION); return 0; }
  if (!cmd || p.bools.has('help') || cmd === 'help') { io.out(USAGE); return cmd || p.bools.has('help') ? 0 : 2; }

  if (cmd === 'token') {
    const dataDir = dataDirOf(p);
    ensureDir(dataDir);
    const store = new TokenStore(dataDir);
    if (sub === 'create') {
      const name = one(p, 'name');
      const scope = (one(p, 'scope') ?? 'control') as TokenScope;
      if (!name) { io.err('token create needs --name'); return 2; }
      if (!TOKEN_SCOPES.includes(scope)) { io.err(`--scope must be one of ${TOKEN_SCOPES.join(', ')}`); return 2; }
      const { record, token } = store.create(name, scope);
      io.out(`id:     ${record.id}`);
      io.out(`name:   ${record.name}`);
      io.out(`scope:  ${scope}`);
      io.out(`token:  ${token}`);
      io.out('Store this token now; only its hash is kept and it cannot be shown again.');
      return 0;
    }
    if (sub === 'list') {
      const rows = store.list();
      if (rows.length === 0) io.out('(no tokens)');
      for (const r of rows) {
        io.out(`${r.id}  ${r.name}  scope=${r.scopes.join(',')}  created=${fmt(r.createdAt)}  lastUsed=${fmt(r.lastUsedAt)}${r.revokedAt ? `  REVOKED ${fmt(r.revokedAt)}` : ''}`);
      }
      return 0;
    }
    if (sub === 'revoke') {
      const target = p.positionals[2];
      if (!target) { io.err('token revoke needs an id or name'); return 2; }
      if (!store.revoke(target)) { io.err(`no active token "${target}"`); return 1; }
      io.out(`revoked ${target}`);
      return 0;
    }
    io.err('usage: agent-threads token create|list|revoke');
    return 2;
  }

  if (cmd === 'serve') {
    const flags: NonNullable<ConfigInputs['flags']> = {};
    const dataDir = one(p, 'data-dir');
    if (dataDir) flags.dataDir = dataDir;
    const listen = one(p, 'listen');
    if (listen !== undefined) flags.listen = listen;
    const port = one(p, 'port');
    if (port !== undefined) flags.port = Number(port);
    const origins = p.flags.get('allow-origin');
    if (origins) flags.allowedOrigins = origins;
    if (p.bools.has('i-know-this-is-open')) flags.acknowledgeOpen = true;
    const workspaces = p.flags.get('workspace');
    if (workspaces) flags.workspaces = workspaces;
    const readOnlyWorkspaces = p.flags.get('readonly-workspace');
    if (readOnlyWorkspaces) flags.readOnlyWorkspaces = readOnlyWorkspaces;
    if (p.bools.has('allow-bypass')) flags.allowBypass = true;
    if (p.bools.has('fake-harness')) flags.harness = 'fake';
    const maxTurns = one(p, 'max-concurrent-turns');
    if (maxTurns !== undefined) flags.maxConcurrentTurns = Number(maxTurns);
    const idle = one(p, 'idle-reap-minutes');
    if (idle !== undefined) flags.idleReapMinutes = Number(idle);
    const journalTtl = one(p, 'journal-ttl-days');
    if (journalTtl !== undefined) flags.journalTtlDays = Number(journalTtl);
    const journalMax = one(p, 'journal-max-mb');
    if (journalMax !== undefined) flags.journalMaxMb = Number(journalMax);
    const claudeBinary = one(p, 'claude-binary');
    if (claudeBinary) flags.claudeBinaryPath = claudeBinary;

    let config;
    try { config = resolveConfig({ flags }); } catch (e) { io.err((e as Error).message); return 2; }
    const daemon = await startDaemon({ config, log: (l) => io.out(l) });
    if (!daemon.tokens.hasActiveTokens) {
      io.out(`No tokens exist yet. Create one with: agent-threads token create --name <name> --scope admin --data-dir ${config.dataDir}`);
    }
    io.out(config.harness === 'fake' ? 'Session host: scripted fake harness (--fake-harness).' : 'Session host: Claude (ThreadSession).');
    await new Promise<void>((resolve) => {
      const shutdown = (sig: string) => {
        io.out(`${sig} received, shutting down`);
        void daemon.stop().then(resolve);
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    });
    return 0;
  }

  io.err(`unknown command "${cmd}"`);
  io.err(USAGE);
  return 2;
}
