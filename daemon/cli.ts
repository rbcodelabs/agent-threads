/**
 * `agent-threads` command line. Server side: `serve`, `token`, `doctor`, `install`. Client side
 * (talks to a daemon over the wire protocol): `list`, `attach`, `run`.
 */
import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from './fsutil';
import { runAttach } from './cmd/attach';
import { CLI_TOKEN_FILE, connectDaemon, resolveConnectionSettings } from './cmd/connection';
import {
  doctorExitCode, formatReport, realProbes, resolveDoctorTarget, runChecks, summarize,
} from './cmd/doctor';
import { CliError, EXIT, exitCodeFor, messageOf } from './cmd/exit';
import { formatPush, parseTtl, preparePush, pushCreds } from './cmd/creds';
import { runInstall, realInstallSys } from './cmd/install';
import { runUpdate } from './cmd/update';
import { applyUpdate } from './update/apply';
import { evaluateBoot, watchHealth } from './update/guard';
import { assessInstall, realInstallProbe, runningBundlePath } from './update/install';
import { githubReleases } from './update/release';
import { AuditLog } from './auditLog';
import { parseBoolEnv, readConfigFile, DEFAULT_AUTO_UPDATE_INTERVAL_MINUTES, DEFAULT_AUTO_UPDATE_QUIET_MINUTES } from './config';
import { PROTOCOL_VERSION } from '../src/protocol';
import { fetchThreads, formatTable, jsonRecord, sortRows } from './cmd/list';
import { processRuntime, type CliRuntime, type RawIo } from './cmd/runtime';
import { runRun } from './cmd/run';
import { resolveConfig, defaultDataDir, type ConfigInputs } from './config';
import { startDaemon } from './server';
import { TOKEN_SCOPES, TokenStore, type TokenScope } from './tokenStore';
import { DAEMON_VERSION, MIN_CLIENT_VERSION } from './version';

const USAGE = `agent-threads ${DAEMON_VERSION}

Usage:
  agent-threads serve [options]           run the daemon
  agent-threads list [--json]             threads on a daemon
  agent-threads attach <thread> [--from N|end] [--claim] [--until-idle] [--json]
                                          follow a thread's live stream (replays from a cursor first)
  agent-threads run [options] "<prompt>"  run one prompt in a new session and stream the answer
  agent-threads token create --name N [--scope read|control|admin] [--save]
  agent-threads token list
  agent-threads token revoke <id|name>
  agent-threads creds push <kind> [NAME...] [--stdin] [--ttl <s|15m|24h|7d>] [--remove]
                                          send credentials to a daemon (admin token); values never touch argv
  agent-threads doctor [--strict] [--json]  check this machine and the daemon
  agent-threads install [--dry-run] [--no-start]   set up the systemd user service (Linux)
  agent-threads update --check [--json]   current vs latest release, and whether/when auto-update would apply it
  agent-threads update --apply [--now] [--json]   install the latest stable release in place (checksum + sanity check, previous
                                          bundle kept), then ask a running daemon to restart onto it when idle; --now skips the idle wait
  agent-threads --version

Connecting (list, attach, run):
  --url <u>              daemon address (env AGENT_THREADS_URL; default ws://127.0.0.1:7433, or the port in the local config.json)
  --token <t>            access token (env AGENT_THREADS_TOKEN; default: <data-dir>/cli-token, see "token create --save").
                         A token on the command line is visible to other users in "ps" and stays in shell history; prefer the
                         environment variable or the saved file.
  --data-dir <dir>       where to look for the local token and config
  --connect-timeout <s>  seconds to wait for the daemon (default 10)
  --json                 NDJSON on stdout, one object per line (stable; see docs/remote-daemon.md)

attach: read-only unless --claim (which takes the thread's read-write seat if it is free and lets you
  answer permission/question/plan requests). --from N replays events after seq N (default 0 = all the
  daemon still holds); --from end follows live only. --until-idle exits once nothing is running.

run options:
  --cwd <dir>            folder ON THE DAEMON MACHINE (default: the shell's folder for a local daemon, else the daemon's default workspace)
  --permission-mode <m>  default | acceptEdits | plan | dontAsk | auto | bypassPermissions (default: default; dontAsk with --unattended)
  --model <m>            model for the session
  --harness <kind>       claude (default), codex or opencode; the daemon must have it enabled
  --thread <id>          continue an existing thread instead of starting a new one
  --detach               send the prompt, print the thread id, exit; the turn keeps running (attach to watch it)
  --unattended           nobody to answer: dontAsk mode DENIES tools that are not pre-approved; a request that
                         is raised anyway (explicit --permission-mode) is refused and the run exits 7
  Exit codes: 0 done, 1 error, 2 usage, 3 unreachable, 4 unauthorized, 5 incompatible protocol, 6 interrupted, 7 needed input, 130 Ctrl-C.
  Use "-" as the prompt to read it from stdin.

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
  --max-connections <n>        sockets accepted at once (default 64)
  --max-live-sessions <n>      sessions with a live claude process at once (default 8)
  --request-timeout-minutes <n>  cancel a permission/question nobody answers after this long (default 60, 0 = never)
  --harness <kind>       default harness: claude, codex or opencode (env AGENT_THREADS_HARNESS). Alone it also restricts the daemon to that one
  --harnesses <a,b,..>   harnesses a client may request (env AGENT_THREADS_HARNESSES, comma separated; config.json harnesses; default: all three)
  --claude-binary <path> path to the claude CLI (env AGENT_THREADS_CLAUDE_BINARY; default: PATH, ~/.npm-global/bin, ~/.local/bin)
  --codex-binary <path>  path to the codex CLI (env AGENT_THREADS_CODEX_BINARY; same default dirs)
  --opencode-binary <path>  path to the opencode CLI (env AGENT_THREADS_OPENCODE_BINARY; same default dirs)
  --auto-update          opt in: replace this daemon's own bundle with the newest stable release and restart when idle
                         (env AGENT_THREADS_AUTO_UPDATE=1, config.json autoUpdate). Only on a systemd install it can update safely;
                         never in a container. See docs/remote-daemon.md, "Automatic updates"
  --auto-update-interval-minutes <n>  how often to look for a release (default 360, minimum 15)
  --auto-update-quiet-minutes <n>     restart only after this long with no turn, request or client command (default 2)
  --fake-harness         scripted stand-in instead of Claude (tests and smoke runs only)

creds push: field values are read from standard input as a JSON object (--stdin) or from the environment variable of
  the same name (NAME). "NAME=value" on the command line is refused unless --allow-argv (it shows in "ps"). With
  --remove and no fields the kind is deleted. Output lists field names, never values.

The token and doctor commands accept --data-dir too.
`;

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Raw text without a newline (streamed tokens, prompts). Falls back to line-buffering `out`/`err`. */
  write?(text: string): void;
  writeErr?(text: string): void;
}

const consoleIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  write: (t) => { process.stdout.write(t); },
  writeErr: (t) => { process.stderr.write(t); },
};

/** Text writers for the client commands; an `Io` with only line methods is fed whole lines. */
export function toRawIo(io: Io): RawIo {
  const lineWriter = (emit: (line: string) => void): ((text: string) => void) => {
    let pending = '';
    return (text) => {
      pending += text;
      let i: number;
      while ((i = pending.indexOf('\n')) >= 0) { emit(pending.slice(0, i)); pending = pending.slice(i + 1); }
    };
  };
  return { out: io.write ? io.write.bind(io) : lineWriter((l) => io.out(l)), err: io.writeErr ? io.writeErr.bind(io) : lineWriter((l) => io.err(l)) };
}

export interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
  bools: Set<string>;
}

const BOOLEAN_FLAGS = new Set([
  'i-know-this-is-open', 'help', 'version', 'allow-bypass', 'fake-harness',
  'auto-update', 'check', 'apply', 'now',
  'json', 'detach', 'unattended', 'claim', 'until-idle', 'strict', 'save', 'dry-run', 'no-start', 'force', 'remove', 'stdin', 'allow-argv',
]);

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positionals: [], flags: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--` ends the flags: everything after it is a positional (a prompt may start with dashes).
    if (a === '--') { out.positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-h') { out.bools.add('help'); continue; }
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

/**
 * After startup succeeded the daemon is serving other people's turns: a stray exception or rejected
 * promise (a bug, a malformed client frame that slipped past a guard) is logged and the process keeps
 * serving. Startup failures happen before this is installed and still exit non-zero. Returns the uninstaller.
 */
export function installCrashGuards(io: Io, proc: NodeJS.Process = process): () => void {
  const onError = (err: unknown): void => {
    io.err(`ERROR (continuing to serve): uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  };
  const onRejection = (reason: unknown): void => {
    io.err(`ERROR (continuing to serve): unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  };
  proc.on('uncaughtException', onError);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.off('uncaughtException', onError);
    proc.off('unhandledRejection', onRejection);
  };
}

export async function runCli(argv: string[], io: Io = consoleIo, runtime?: Partial<CliRuntime>): Promise<number> {
  let p: Parsed;
  try { p = parseArgs(argv); } catch (e) { io.err((e as Error).message); return 2; }
  const [cmd, sub] = p.positionals;

  // `--version --json` is what the updater runs on a downloaded bundle before swapping it in: the version and
  // the wire protocol it speaks. A bundle that predates this prints the bare version, which the updater accepts too.
  if (p.bools.has('version')) { io.out(p.bools.has('json') ? JSON.stringify({ version: DAEMON_VERSION, protocol: PROTOCOL_VERSION, minClientVersion: MIN_CLIENT_VERSION }) : DAEMON_VERSION); return 0; }
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
      const save = p.bools.has('save');
      if (save) {
        // The daemon keeps only a hash, so a same-machine CLI default needs this plaintext copy. 0600 in a 0700
        // directory: readable by the daemon's own user, which can already read every journal and run claude.
        writeFileAtomic(join(dataDir, CLI_TOKEN_FILE), `${token}\n`);
      }
      if (p.bools.has('json')) {
        io.out(JSON.stringify({ id: record.id, name: record.name, scope, ...(save ? { savedTo: join(dataDir, CLI_TOKEN_FILE) } : { token }) }));
        return 0;
      }
      io.out(`id:     ${record.id}`);
      io.out(`name:   ${record.name}`);
      io.out(`scope:  ${scope}`);
      if (save) {
        io.out(`saved:  ${join(dataDir, CLI_TOKEN_FILE)} (mode 0600): list/attach/run on this machine use it automatically`);
      } else {
        io.out(`token:  ${token}`);
        io.out('Store this token now; only its hash is kept and it cannot be shown again.');
      }
      return 0;
    }
    if (sub === 'list') {
      const rows = store.list();
      if (p.bools.has('json')) {
        for (const r of rows) io.out(JSON.stringify({ id: r.id, name: r.name, scope: r.scopes.at(-1) ?? 'read', createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt }));
        return 0;
      }
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
    const port = portFlag(p);
    if (port !== undefined) flags.port = port;
    const origins = p.flags.get('allow-origin');
    if (origins) flags.allowedOrigins = origins;
    if (p.bools.has('i-know-this-is-open')) flags.acknowledgeOpen = true;
    const workspaces = p.flags.get('workspace');
    if (workspaces) flags.workspaces = workspaces;
    const readOnlyWorkspaces = p.flags.get('readonly-workspace');
    if (readOnlyWorkspaces) flags.readOnlyWorkspaces = readOnlyWorkspaces;
    if (p.bools.has('allow-bypass')) flags.allowBypass = true;
    if (p.bools.has('auto-update')) flags.autoUpdate = true;
    const updateInterval = one(p, 'auto-update-interval-minutes');
    if (updateInterval !== undefined) flags.autoUpdateIntervalMinutes = Number(updateInterval);
    const updateQuiet = one(p, 'auto-update-quiet-minutes');
    if (updateQuiet !== undefined) flags.autoUpdateQuietMinutes = Number(updateQuiet);
    const harness = one(p, 'harness');
    if (harness) flags.harness = harness as NonNullable<ConfigInputs['flags']>['harness'];
    const harnesses = p.flags.get('harnesses');
    if (harnesses) flags.harnesses = harnesses.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean) as NonNullable<ConfigInputs['flags']>['harnesses'];
    if (p.bools.has('fake-harness')) flags.harness = 'fake';
    const maxTurns = one(p, 'max-concurrent-turns');
    if (maxTurns !== undefined) flags.maxConcurrentTurns = Number(maxTurns);
    const idle = one(p, 'idle-reap-minutes');
    if (idle !== undefined) flags.idleReapMinutes = Number(idle);
    const journalTtl = one(p, 'journal-ttl-days');
    if (journalTtl !== undefined) flags.journalTtlDays = Number(journalTtl);
    const journalMax = one(p, 'journal-max-mb');
    if (journalMax !== undefined) flags.journalMaxMb = Number(journalMax);
    const maxConnections = one(p, 'max-connections');
    if (maxConnections !== undefined) flags.maxConnections = Number(maxConnections);
    const maxLive = one(p, 'max-live-sessions');
    if (maxLive !== undefined) flags.maxLiveSessions = Number(maxLive);
    const requestTimeout = one(p, 'request-timeout-minutes');
    if (requestTimeout !== undefined) flags.requestTimeoutMinutes = Number(requestTimeout);
    const claudeBinary = one(p, 'claude-binary');
    if (claudeBinary) flags.claudeBinaryPath = claudeBinary;
    const codexBinary = one(p, 'codex-binary');
    if (codexBinary) flags.codexBinaryPath = codexBinary;
    const opencodeBinary = one(p, 'opencode-binary');
    if (opencodeBinary) flags.opencodeBinaryPath = opencodeBinary;

    let config;
    try { config = resolveConfig({ flags }); } catch (e) { io.err((e as Error).message); return 2; }
    // A freshly installed bundle counts itself in before it serves; after repeated failures to become healthy it
    // puts the previous bundle back and asks to be restarted (update/guard.ts).
    const guardDeps = {
      dataDir: config.dataDir, currentVersion: DAEMON_VERSION, bundlePath: runningBundlePath(),
      log: (l: string) => io.out(l),
      audit: (record: Record<string, unknown>) => { const a = new AuditLog(join(config.dataDir, 'audit.ndjson')); a.record(record); a.flushSync(); },
    };
    const boot = evaluateBoot(guardDeps);
    if (boot.action === 'rolled_back') {
      io.out(`restarting to run ${boot.to} again`);
      return EXIT.RESTART;
    }
    const health = boot.watch ? watchHealth(guardDeps, boot.watch, () => process.exit(1)) : null;

    let requestRestart: (to: string) => void = () => {};
    const daemon = await startDaemon({ config, log: (l) => io.out(l), onRestartRequested: (info) => requestRestart(info.to) });
    health?.listening();
    const uninstallGuards = installCrashGuards(io);
    if (!daemon.tokens.hasActiveTokens) {
      io.out(`No tokens exist yet. Create one with: agent-threads token create --name <name> --scope admin --data-dir ${config.dataDir}`);
    }
    io.out(config.harness === 'fake' ? 'Session host: scripted fake harness (--fake-harness).' : `Session host: ${config.harnesses.join(', ')} (default ${config.harness}).`);
    return new Promise<number>((resolve) => {
      let stopping = false;
      const finish = (code: number) => {
        if (stopping) return;
        stopping = true;
        health?.dispose();
        void daemon.stop().then(() => { uninstallGuards(); resolve(code); });
      };
      requestRestart = (to) => {
        io.out(`exiting ${EXIT.RESTART} (non-zero on purpose) so the supervisor starts the new bundle`);
        // Anything still holding the event loop open must not keep the old bundle alive after we asked to be replaced.
        setTimeout(() => process.exit(EXIT.RESTART), 15_000).unref();
        finish(EXIT.RESTART);
      };
      process.once('SIGINT', () => { io.out('SIGINT received, shutting down'); finish(0); });
      process.once('SIGTERM', () => { io.out('SIGTERM received, shutting down'); finish(0); });
    });
  }

  if (cmd === 'list' || cmd === 'attach' || cmd === 'run' || cmd === 'doctor' || cmd === 'install' || cmd === 'creds' || cmd === 'update') {
    const rt: CliRuntime = { ...processRuntime(), ...runtime };
    const raw = toRawIo(io);
    try {
      return await runClientCommand(cmd, p, io, raw, rt);
    } catch (err) {
      if (err instanceof CliError) { io.err(err.message); return err.code; }
      io.err(messageOf(err));
      return exitCodeFor(err);
    }
  }

  io.err(`unknown command "${cmd}"`);
  io.err(USAGE);
  return 2;
}

/** `--port`, validated: a typo must be a usage error, not NaN quietly becoming "the default" or a URL with `NaN` in it. */
export function portFlag(p: Parsed): number | undefined {
  const raw = one(p, 'port');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 0 || n > 65535) throw new CliError(`--port must be a whole number from 0 to 65535 (got "${raw}")`, EXIT.USAGE);
  return n;
}

const connFlags = (p: Parsed): { url?: string; token?: string; dataDir?: string; connectTimeoutMs?: number } => {
  const timeout = one(p, 'connect-timeout');
  if (timeout !== undefined && !(Number(timeout) > 0)) throw new CliError('--connect-timeout must be a number of seconds', EXIT.USAGE);
  return {
    ...(one(p, 'url') ? { url: one(p, 'url') } : {}),
    ...(one(p, 'token') ? { token: one(p, 'token') } : {}),
    ...(one(p, 'data-dir') ? { dataDir: one(p, 'data-dir') } : {}),
    ...(timeout !== undefined ? { connectTimeoutMs: Number(timeout) * 1000 } : {}),
  };
};

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8');
}

async function runClientCommand(cmd: string, p: Parsed, io: Io, raw: RawIo, rt: CliRuntime): Promise<number> {
  const json = p.bools.has('json');
  switch (cmd) {
    case 'list': {
      const flags = connFlags(p);
      const client = await connectDaemon(resolveConnectionSettings(flags, rt.env), { reconnect: false, connectTimeoutMs: flags.connectTimeoutMs, createSocket: rt.createSocket });
      try {
        const rows = sortRows(await fetchThreads(client));
        if (json) for (const r of rows) io.out(JSON.stringify(jsonRecord(r)));
        else for (const l of formatTable(rows)) io.out(l);
        return EXIT.OK;
      } finally {
        client.dispose();
      }
    }
    case 'attach': {
      const flags = connFlags(p);
      return runAttach({
        ...flags, thread: p.positionals[1], from: one(p, 'from'), claim: p.bools.has('claim'), untilIdle: p.bools.has('until-idle'), json,
      }, raw, rt);
    }
    case 'run': {
      const flags = connFlags(p);
      let prompt = p.positionals.slice(1).join(' ');
      if (prompt === '-') prompt = (await readAll(rt.stdin)).trim();
      return runRun({
        ...flags, prompt, json,
        ...(one(p, 'cwd') ? { cwd: one(p, 'cwd') } : {}),
        ...(one(p, 'permission-mode') ? { permissionMode: one(p, 'permission-mode') } : {}),
        ...(one(p, 'model') ? { model: one(p, 'model') } : {}),
        ...(one(p, 'harness') ? { harness: one(p, 'harness') } : {}),
        ...(one(p, 'thread') ? { thread: one(p, 'thread') } : {}),
        detach: p.bools.has('detach'), unattended: p.bools.has('unattended'),
      }, raw, rt);
    }
    case 'doctor': {
      const probes = realProbes(rt.env);
      const port = portFlag(p);
      const target = resolveDoctorTarget({
        ...(one(p, 'data-dir') ? { dataDir: one(p, 'data-dir') } : {}),
        ...(one(p, 'url') ? { url: one(p, 'url') } : {}),
        ...(one(p, 'listen') ? { listen: one(p, 'listen') } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(p.flags.get('workspace') ? { workspaces: p.flags.get('workspace') } : {}),
        ...(one(p, 'claude-binary') ? { claudeBinaryPath: one(p, 'claude-binary') } : {}),
        ...(one(p, 'codex-binary') ? { codexBinaryPath: one(p, 'codex-binary') } : {}),
        ...(one(p, 'opencode-binary') ? { opencodeBinaryPath: one(p, 'opencode-binary') } : {}),
      }, probes);
      const results = await runChecks(probes, target);
      const code = doctorExitCode(results, p.bools.has('strict'));
      if (json) {
        for (const r of results) io.out(JSON.stringify({ type: 'check', ...r }));
        io.out(JSON.stringify({ type: 'summary', ...summarize(results), exitCode: code }));
      } else {
        for (const l of formatReport(results, DAEMON_VERSION)) io.out(l);
      }
      return code;
    }
    case 'creds': {
      if (p.positionals[1] !== 'push') throw new CliError('usage: agent-threads creds push <kind> [NAME...] [--stdin] [--ttl N] [--remove]', EXIT.USAGE);
      const ttl = one(p, 'ttl');
      const opts = {
        kind: p.positionals[2] ?? '', specs: p.positionals.slice(3), ttlSec: ttl === undefined ? 0 : parseTtl(ttl),
        remove: p.bools.has('remove'), stdinJson: p.bools.has('stdin'), allowArgv: p.bools.has('allow-argv'),
      };
      const stdinText = opts.stdinJson ? await readAll(rt.stdin) : undefined;
      const fields = preparePush(opts, { env: rt.env, ...(stdinText !== undefined ? { stdinText } : {}), warn: (m) => io.err(m) });
      const flags = connFlags(p);
      const client = await connectDaemon(resolveConnectionSettings(flags, rt.env), { reconnect: false, connectTimeoutMs: flags.connectTimeoutMs, createSocket: rt.createSocket });
      try {
        const reply = await pushCreds(client, opts.kind, opts.remove ? 0 : opts.ttlSec, fields);
        if (json) io.out(JSON.stringify({ kind: reply.kind, fields: reply.fields, removed: reply.removed, expiresAt: reply.expiresAt ?? null }));
        else io.out(formatPush(reply));
        return EXIT.OK;
      } finally {
        client.dispose();
      }
    }
    case 'install': {
      const bundle = typeof __filename === 'string' && __filename.endsWith('.cjs') ? __filename : join(process.cwd(), 'dist/agent-threads.cjs');
      const port = portFlag(p);
      runInstall({
        dryRun: p.bools.has('dry-run'), noStart: p.bools.has('no-start'), force: p.bools.has('force'),
        ...(one(p, 'workspace') ? { workspace: one(p, 'workspace') } : {}),
        ...(port !== undefined ? { port } : {}),
        node: process.execPath, bundle,
      }, realInstallSys(), (l) => io.out(l));
      return EXIT.OK;
    }
    case 'update': {
      const dataDir = dataDirOf(p);
      const env = rt.env;
      const bundle = runningBundlePath();
      const fetchImpl = (url: string, init: Parameters<typeof fetch>[1]) => fetch(url, init);
      const currentVersion = DAEMON_VERSION;
      return runUpdate({ check: p.bools.has('check'), apply: p.bools.has('apply'), now: p.bools.has('now'), json }, {
        currentVersion,
        dataDir,
        releases: githubReleases({ fetch: fetchImpl }),
        assess: () => assessInstall(realInstallProbe(bundle, env), 'cli'),
        apply: (release) => applyUpdate({ release, currentVersion, bundlePath: bundle!, dataDir, nodePath: process.execPath, fetch: fetchImpl }),
        settings: () => {
          const file = readConfigFile(dataDir);
          return {
            enabled: parseBoolEnv(env.AGENT_THREADS_AUTO_UPDATE) ?? file.autoUpdate === true,
            intervalMinutes: Number(env.AGENT_THREADS_AUTO_UPDATE_INTERVAL_MINUTES) || file.autoUpdateIntervalMinutes || DEFAULT_AUTO_UPDATE_INTERVAL_MINUTES,
            quietMinutes: env.AGENT_THREADS_AUTO_UPDATE_QUIET_MINUTES !== undefined && env.AGENT_THREADS_AUTO_UPDATE_QUIET_MINUTES !== '' ? Number(env.AGENT_THREADS_AUTO_UPDATE_QUIET_MINUTES) : file.autoUpdateQuietMinutes ?? DEFAULT_AUTO_UPDATE_QUIET_MINUTES,
          };
        },
        now: () => Date.now(),
        pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
      }, (l) => io.out(l), (l) => io.err(l));
    }
    default:
      throw new CliError(`unknown command "${cmd}"`, EXIT.USAGE);
  }
}
