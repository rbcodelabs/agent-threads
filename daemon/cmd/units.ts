/**
 * The systemd unit files, generated from one template so `agent-threads install` (which writes the
 * user unit) and the reference copies in deploy/ cannot drift: test/unit/daemon-cli-units.test.ts
 * renders both variants with canonical paths and compares them to deploy/agent-threads*.service.
 *
 * Both variants share the parts that matter:
 *   Restart=on-failure   come back after a crash, not after `systemctl stop`.
 *   KillMode=mixed       SIGTERM goes to the daemon ALONE so it can close its sessions and flush its
 *                        journals before anything under it disappears; then systemd SIGKILLs whatever
 *                        is still in the unit's cgroup. That last step is what matters here: each
 *                        session is a `claude` child process, and if the daemon dies by SIGKILL those
 *                        children would be orphaned and keep running (and spending tokens) unless
 *                        systemd reaps the control group. Verified on systemd 259: with `mixed`,
 *                        both `systemctl stop` and a SIGKILL of the daemon leave no child alive.
 *                        (`control-group` also reaps, but signals every process at once.)
 *   EnvironmentFile      a 0600 file the operator owns, for the Claude token and GH_TOKEN. Optional ("-").
 *   LoadCredential       the Claude token as a systemd credential ($CREDENTIALS_DIRECTORY/claude-token),
 *                        which the daemon reads itself; the file may be EMPTY when `claude` is logged in but it
 *                        MUST EXIST: systemd refuses to start a unit whose credential file is missing, and there
 *                        is no optional form (verified on systemd 259). `agent-threads install` creates it
 *                        (0600, empty); for the system unit create it with the commands in docs/remote-daemon.md.
 *   StateDirectory       the journal, tokens and logs; created and owned by systemd.
 *   ReadWritePaths       under ProtectSystem=strict the unit can only write where it is told. The agent
 *                        runs builds and installs packages, so the unit limits WHERE it can write, not
 *                        WHAT it can execute; the VM is the real boundary (docs/remote-daemon.md).
 */

export type UnitVariant = 'user' | 'system';

export interface UnitParams {
  variant: UnitVariant;
  /** Absolute path of the node binary. */
  node: string;
  /** Absolute path of dist/agent-threads.cjs. */
  bundle: string;
  port?: number;
  /** Folder sessions may run in (default: ~/workspaces for the user unit, /srv/workspaces for the system unit). */
  workspace?: string;
}

/** The paths used for the checked-in reference copies. */
export const CANONICAL_NODE = '/usr/bin/node';
export const CANONICAL_BUNDLE = '/opt/agent-threads/dist/agent-threads.cjs';
/** Written into units `agent-threads install` generates; install refuses to overwrite a unit without it unless --force. */
export const MANAGED_MARKER = '# Managed by `agent-threads install`';

/**
 * One word of an ExecStart line. systemd splits the line on whitespace, honours double quotes and backslash escapes,
 * and expands `%` specifiers and `$VAR` even inside quotes, so a path from the operator is quoted and has those
 * characters escaped; a newline (or any control character) would start a new directive and is refused outright.
 */
export function unitWord(value: string, what: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${what} must not contain a newline or other control character`);
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

export function renderUnit(p: UnitParams): string {
  const port = p.port ?? 7433;
  const user = p.variant === 'user';
  const lines: string[] = [];
  const add = (...l: string[]): void => { lines.push(...l); };

  add(
    user ? `${MANAGED_MARKER} (user unit). Local changes belong in a drop-in: systemctl --user edit agent-threads` : '# agent-threads system unit. Local changes belong in a drop-in: systemctl edit agent-threads',
    '[Unit]',
    'Description=agent-threads daemon (remote Claude Code sessions)',
    'Documentation=https://github.com/rbcodelabs/agent-threads/blob/main/docs/remote-daemon.md',
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=300',
    'StartLimitBurst=10',
    '',
    '[Service]',
    'Type=simple',
  );
  if (!user) add('User=agent-threads', 'Group=agent-threads');
  add(
    // The default user workspace is a specifier (%h) on purpose; anything the operator supplied is escaped.
    `ExecStart=${unitWord(p.node, 'node path')} ${unitWord(p.bundle, 'bundle path')} serve --listen 127.0.0.1 --port ${port} --workspace ${p.workspace !== undefined ? unitWord(p.workspace, '--workspace') : (user ? '"%h/workspaces"' : '"/srv/workspaces"')}`,
    user ? 'WorkingDirectory=%h' : 'WorkingDirectory=/srv/workspaces',
  );
  // The system user's HOME (where `claude` keeps its login and sessions) lives under the state directory.
  if (!user) add('ExecStartPre=/bin/mkdir -p /var/lib/agent-threads/home');
  add(
    '',
    '# Credentials. With a `claude` login in the daemon user\'s home neither needs a value, but the credential file',
    '# below must still exist (an empty file is fine): systemd will not start the unit without it.',
    user ? 'EnvironmentFile=-%E/agent-threads/env' : 'EnvironmentFile=-/etc/agent-threads/env',
    user ? 'LoadCredential=claude-token:%E/agent-threads/claude-token' : 'LoadCredential=claude-token:/etc/agent-threads/claude-token',
    '',
    '# State: journals, tokens, raw logs.',
    'StateDirectory=agent-threads',
    'StateDirectoryMode=0700',
    user ? 'Environment=DATA_DIR=%S/agent-threads' : 'Environment=DATA_DIR=/var/lib/agent-threads',
    user ? 'Environment=HOME=%h' : 'Environment=HOME=/var/lib/agent-threads/home',
    '',
    '# Come back after a crash; stay down after `systemctl stop`.',
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '# SIGTERM the daemon alone so it can flush; then SIGKILL the rest of the control group, so a killed daemon',
    '# cannot leave `claude` processes behind.',
    'KillMode=mixed',
    'KillSignal=SIGTERM',
    'SendSIGKILL=yes',
    'TimeoutStopSec=30',
    '',
    '# Confinement. This limits where the agent can write, not what it can run (see docs/remote-daemon.md).',
    'NoNewPrivileges=yes',
  );
  if (!user) {
    add(
      'PrivateTmp=yes',
      'ProtectSystem=strict',
      'ProtectHome=read-only',
      'ProtectKernelTunables=yes',
      'ProtectControlGroups=yes',
      'RestrictSUIDSGID=yes',
      'ReadWritePaths=/var/lib/agent-threads -/srv/workspaces',
    );
  }
  add('LimitNOFILE=65536', '', '[Install]', `WantedBy=${user ? 'default.target' : 'multi-user.target'}`, '');
  return lines.join('\n');
}
