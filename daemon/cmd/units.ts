/**
 * The systemd unit files, generated from one template so `agent-threads install` (which writes the
 * user unit) and the reference copies in deploy/ cannot drift: test/unit/daemon-cli-units.test.ts
 * renders both variants with canonical paths and compares them to deploy/agent-threads*.service.
 *
 * Both variants share the parts that matter:
 *   Restart=on-failure   come back after a crash, not after `systemctl stop`.
 *   KillMode=control-group  stop (and on a kill, reap) EVERYTHING in the unit's cgroup. The default
 *                        for a service, spelled out because it is critical here: each session is a
 *                        `claude` child process, and if the daemon dies by SIGKILL those children
 *                        are orphaned and keep running (and spending tokens) unless systemd reaps
 *                        the whole control group.
 *   EnvironmentFile      a 0600 file the operator owns, for the Claude token and GH_TOKEN. Optional ("-").
 *   LoadCredential       the Claude token as a systemd credential ($CREDENTIALS_DIRECTORY/claude-token),
 *                        which the daemon reads itself; the file may be empty when `claude` is logged in.
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
    '',
    '[Service]',
    'Type=simple',
  );
  if (!user) add('User=agent-threads', 'Group=agent-threads');
  add(
    `ExecStart=${p.node} ${p.bundle} serve --listen 127.0.0.1 --port ${port} --workspace ${p.workspace ?? (user ? '%h/workspaces' : '/srv/workspaces')}`,
    user ? 'WorkingDirectory=%h' : 'WorkingDirectory=/srv/workspaces',
  );
  // The system user's HOME (where `claude` keeps its login and sessions) lives under the state directory.
  if (!user) add('ExecStartPre=/bin/mkdir -p /var/lib/agent-threads/home');
  add(
    '',
    '# Credentials. Both are optional in effect: with a `claude` login in the daemon user\'s home neither is needed.',
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
    'StartLimitIntervalSec=300',
    'StartLimitBurst=10',
    '',
    '# Stop and reap the whole control group, so a SIGKILLed daemon cannot leave `claude` processes behind.',
    'KillMode=control-group',
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
