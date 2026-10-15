/**
 * `agent-threads install`: set this user up to run the daemon as a systemd USER service.
 *
 * Idempotent: every step checks before it acts, so running it again is how you upgrade (the unit is
 * rewritten when the node or bundle path changed) and never loses data (the env file, the credential
 * file and the data directory are created if missing and never overwritten). `--dry-run` prints the
 * plan and touches nothing. It does not create tokens, does not touch a system unit, and does not
 * need root. The system-wide unit is installed by hand (docs/remote-daemon.md, "systemd, system-wide").
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CliError, EXIT } from './exit';
import { MANAGED_MARKER, renderUnit } from './units';

export interface InstallOptions {
  dryRun: boolean;
  noStart: boolean;
  force: boolean;
  workspace?: string;
  port?: number;
  node: string;
  bundle: string;
}

/** The side effects, injectable. */
export interface InstallSys {
  platform: string;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  read(path: string): string | null;
  mode(path: string): number | null;
  mkdir(path: string, mode: number): void;
  write(path: string, data: string, mode: number): void;
  chmod(path: string, mode: number): void;
  /** Run a command; returns its stdout, or throws. */
  exec(cmd: string, args: string[]): string;
}

export function realInstallSys(): InstallSys {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    exists: (p) => existsSync(p),
    read: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    mode: (p) => { try { return statSync(p).mode & 0o777; } catch { return null; } },
    mkdir: (p, mode) => { mkdirSync(p, { recursive: true, mode }); },
    write: (p, data, mode) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data, { mode }); chmodSync(p, mode); },
    chmod: (p, mode) => { chmodSync(p, mode); },
    exec: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  };
}

export const ENV_TEMPLATE = `# agent-threads daemon environment (systemd EnvironmentFile). Keep this file mode 0600.
#
# Claude credential. Either sign in once as this user (run \`claude\`), or put a long-lived token here
# (from \`claude setup-token\`). A token in this file is passed only to the claude processes the daemon starts.
#CLAUDE_CODE_OAUTH_TOKEN=
#ANTHROPIC_API_KEY=
#
# GitHub, for pushes and pull requests from agent sessions (a fine-grained token scoped to the repos you want):
#GH_TOKEN=
`;

export interface InstallPlan {
  /** One line per action, in order, in the form it was (or would be) taken. */
  steps: string[];
  nextSteps: string[];
  unitPath: string;
  envFile: string;
  changed: boolean;
}

export function runInstall(opts: InstallOptions, sys: InstallSys, say: (line: string) => void): InstallPlan {
  if (sys.platform !== 'linux') throw new CliError('`agent-threads install` sets up a systemd user service and only works on Linux; on macOS run `agent-threads serve` yourself, or see docs/remote-daemon.md for Docker', EXIT.USAGE);
  const xdgConfig = sys.env.XDG_CONFIG_HOME || join(sys.home, '.config');
  const configDir = join(xdgConfig, 'agent-threads');
  const envFile = join(configDir, 'env');
  const credFile = join(configDir, 'claude-token');
  const unitDir = join(xdgConfig, 'systemd/user');
  const unitPath = join(unitDir, 'agent-threads.service');
  const workspace = opts.workspace ?? join(sys.home, 'workspaces'); // the unit's default is %h/workspaces
  const steps: string[] = [];
  let changed = false;
  const act = (line: string, fn: () => void): void => {
    steps.push(opts.dryRun ? `would: ${line}` : line);
    if (!opts.dryRun) fn();
    changed = true;
  };
  const ok = (line: string): void => { steps.push(`ok: ${line}`); };

  if (!opts.dryRun) {
    try { sys.exec('systemctl', ['--user', '--version']); } catch {
      throw new CliError('systemctl --user is not available here (no systemd user manager). Use `agent-threads serve` under tmux, or Docker (docs/remote-daemon.md)', EXIT.FAILED);
    }
  }

  if (sys.exists(configDir)) ok(`${configDir} exists`);
  else act(`create ${configDir} (0700)`, () => sys.mkdir(configDir, 0o700));

  for (const [file, content, what] of [[envFile, ENV_TEMPLATE, 'environment file'], [credFile, '', 'Claude token credential file (may stay empty if you sign in with `claude`)']] as const) {
    if (sys.exists(file)) {
      const m = sys.mode(file);
      if (m !== null && m & 0o077) act(`tighten ${file} to 0600 (was ${m.toString(8)})`, () => sys.chmod(file, 0o600));
      else ok(`${file} exists`);
    } else {
      act(`create ${file} (0600): ${what}`, () => sys.write(file, content, 0o600));
    }
  }

  if (sys.exists(workspace)) ok(`workspace ${workspace} exists`);
  else act(`create workspace ${workspace}`, () => sys.mkdir(workspace, 0o755));

  const unit = renderUnit({ variant: 'user', node: opts.node, bundle: opts.bundle, port: opts.port, workspace: opts.workspace });
  const existing = sys.read(unitPath);
  if (existing === unit) {
    ok(`${unitPath} is up to date`);
  } else if (existing !== null && !existing.includes(MANAGED_MARKER) && !opts.force) {
    throw new CliError(`${unitPath} exists and was not written by \`agent-threads install\`; refusing to overwrite it (use --force, or move it aside). Local changes belong in a drop-in: systemctl --user edit agent-threads`, EXIT.FAILED);
  } else {
    act(`${existing === null ? 'write' : 'update'} ${unitPath}`, () => sys.write(unitPath, unit, 0o644));
  }

  if (!opts.dryRun) {
    if (changed) {
      try { sys.exec('systemctl', ['--user', 'daemon-reload']); steps.push('systemctl --user daemon-reload'); } catch (e) { throw new CliError(`systemctl --user daemon-reload failed: ${msg(e)}`, EXIT.FAILED); }
    }
    if (!opts.noStart) {
      try { sys.exec('systemctl', ['--user', 'enable', '--now', 'agent-threads.service']); steps.push('systemctl --user enable --now agent-threads (restart to pick up a changed unit: systemctl --user restart agent-threads)'); }
      catch (e) { throw new CliError(`could not enable and start the service: ${msg(e)}\nSee: journalctl --user -u agent-threads -e`, EXIT.FAILED); }
    }
  } else {
    steps.push(`would: systemctl --user daemon-reload${opts.noStart ? '' : ' && systemctl --user enable --now agent-threads'}`);
  }

  const next = [
    'Create a token for Geode (shown once):   agent-threads token create --name geode --scope control',
    'Create one for this machine\'s CLI:       agent-threads token create --name cli --scope control --save',
    `Claude sign-in: run \`claude\` once as this user, or put CLAUDE_CODE_OAUTH_TOKEN=... in ${envFile}`,
    'Keep it running after you log out:        loginctl enable-linger "$USER"',
    'Reach it from Geode over wss:              sudo tailscale serve --bg --https=8443 http://127.0.0.1:7433',
    'Check everything:                          agent-threads doctor',
  ];
  for (const s of steps) say(s);
  say('');
  say('Next steps:');
  for (const n of next) say(`  ${n}`);
  return { steps, nextSteps: next, unitPath, envFile, changed };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
