import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_TEMPLATE, runInstall, type InstallOptions, type InstallSys } from '../../daemon/cmd/install';
import { CANONICAL_BUNDLE, CANONICAL_NODE, MANAGED_MARKER, renderUnit, unitWord } from '../../daemon/cmd/units';

const root = resolve(__dirname, '../..');
const deployFile = (f: string): string => readFileSync(resolve(root, 'deploy', f), 'utf8');

describe('systemd units', () => {
  it('deploy/ reference copies match the generator (run: node scripts/gen-units.mts)', () => {
    expect(deployFile('agent-threads.service')).toBe(renderUnit({ variant: 'system', node: CANONICAL_NODE, bundle: CANONICAL_BUNDLE }));
    expect(deployFile('agent-threads.user.service')).toBe(renderUnit({ variant: 'user', node: CANONICAL_NODE, bundle: CANONICAL_BUNDLE }));
  });

  for (const variant of ['user', 'system'] as const) {
    it(`${variant}: carries the settings the design requires`, () => {
      const u = renderUnit({ variant, node: '/n', bundle: '/b.cjs' });
      expect(u).toMatch(/^Restart=on-failure$/m);
      // SIGTERM to the daemon alone (it flushes), then SIGKILL for the rest of the cgroup so a killed daemon orphans nothing.
      expect(u).toMatch(/^KillMode=mixed$/m);
      expect(u).toMatch(/^SendSIGKILL=yes$/m);
      expect(u).toMatch(/^EnvironmentFile=-/m);
      expect(u).toMatch(/^LoadCredential=claude-token:/m);
      expect(u).toMatch(/^StateDirectory=agent-threads$/m);
      expect(u).toMatch(/^NoNewPrivileges=yes$/m);
      expect(u).toContain('--listen 127.0.0.1');
      expect(u).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN=\S/);
    });
  }
  it('quotes ExecStart words and escapes the characters systemd expands', () => {
    const u = renderUnit({ variant: 'user', node: '/opt/my node/bin/node', bundle: '/b 100%/a"b$c.cjs', workspace: '/srv/my work/100%' });
    const exec = u.split('\n').find((l) => l.startsWith('ExecStart='))!;
    expect(exec).toBe('ExecStart="/opt/my node/bin/node" "/b 100%%/a\\"b$$c.cjs" serve --listen 127.0.0.1 --port 7433 --workspace "/srv/my work/100%%"');
    // The default workspace stays a specifier on purpose.
    expect(renderUnit({ variant: 'user', node: '/n', bundle: '/b.cjs' })).toContain('--workspace "%h/workspaces"');
  });
  it('refuses a newline or other control character in any path (it would start a new directive)', () => {
    expect(() => unitWord('/srv/x\nExecStartPost=/bin/evil', '--workspace')).toThrow(/newline/);
    expect(() => renderUnit({ variant: 'user', node: '/n', bundle: '/b.cjs', workspace: '/srv/x\nUser=root' })).toThrow(/--workspace/);
    expect(() => unitWord('/a\u0000b', 'x')).toThrow();
  });
  it('tells the operator the credential file must exist', () => {
    expect(renderUnit({ variant: 'system', node: '/n', bundle: '/b.cjs' })).toMatch(/must still exist/);
  });
  it('system: confines writes', () => {
    const u = renderUnit({ variant: 'system', node: '/n', bundle: '/b.cjs' });
    expect(u).toMatch(/^ProtectSystem=strict$/m);
    expect(u).toMatch(/^ReadWritePaths=\/var\/lib\/agent-threads -\/srv\/workspaces$/m);
    expect(u).toMatch(/^User=agent-threads$/m);
  });
});

function fakeSys(files: Record<string, { data: string; mode: number }> = {}, over: Partial<InstallSys> = {}): InstallSys & { files: typeof files; cmds: string[] } {
  const dirs = new Set<string>();
  const cmds: string[] = [];
  return {
    files, cmds, platform: 'linux', home: '/home/user', env: {},
    exists: (p) => p in files || dirs.has(p),
    read: (p) => files[p]?.data ?? null,
    mode: (p) => files[p]?.mode ?? null,
    mkdir: (p) => { dirs.add(p); },
    write: (p, data, mode) => { files[p] = { data, mode }; },
    chmod: (p, mode) => { files[p].mode = mode; },
    exec: (cmd, args) => { cmds.push(`${cmd} ${args.join(' ')}`); return ''; },
    ...over,
  };
}
const opts: InstallOptions = { dryRun: false, noStart: false, force: false, node: '/usr/bin/node', bundle: '/opt/at/agent-threads.cjs' };

describe('install', () => {
  it('sets everything up, enables the service, and prints next steps', () => {
    const sys = fakeSys();
    const lines: string[] = [];
    const plan = runInstall(opts, sys, (l) => lines.push(l));
    const unit = sys.files['/home/user/.config/systemd/user/agent-threads.service'];
    expect(unit.data).toContain('ExecStart="/usr/bin/node" "/opt/at/agent-threads.cjs" serve');
    expect(unit.data).toContain(MANAGED_MARKER);
    expect(sys.files['/home/user/.config/agent-threads/env']).toEqual({ data: ENV_TEMPLATE, mode: 0o600 });
    expect(sys.files['/home/user/.config/agent-threads/claude-token']).toEqual({ data: '', mode: 0o600 });
    expect(sys.cmds).toEqual(['systemctl --user --version', 'systemctl --user daemon-reload', 'systemctl --user enable --now agent-threads.service']);
    expect(plan.changed).toBe(true);
    expect(lines.join('\n')).toMatch(/token create --name geode/);
    expect(lines.join('\n')).toMatch(/enable-linger/);
  });

  it('is idempotent: a second run changes nothing, and never overwrites the env file', () => {
    const sys = fakeSys();
    runInstall(opts, sys, () => {});
    sys.files['/home/user/.config/agent-threads/env'].data = 'CLAUDE_CODE_OAUTH_TOKEN=mine\n';
    sys.cmds.length = 0;
    const plan = runInstall(opts, sys, () => {});
    expect(plan.changed).toBe(false);
    expect(sys.files['/home/user/.config/agent-threads/env'].data).toBe('CLAUDE_CODE_OAUTH_TOKEN=mine\n');
    expect(sys.cmds).not.toContain('systemctl --user daemon-reload');
  });

  it('rewrites a managed unit when the bundle moves, tightens loose modes, refuses a foreign unit', () => {
    const sys = fakeSys();
    runInstall(opts, sys, () => {});
    sys.files['/home/user/.config/agent-threads/env'].mode = 0o644;
    runInstall({ ...opts, bundle: '/elsewhere.cjs' }, sys, () => {});
    expect(sys.files['/home/user/.config/systemd/user/agent-threads.service'].data).toContain('/elsewhere.cjs');
    expect(sys.files['/home/user/.config/agent-threads/env'].mode).toBe(0o600);
    sys.files['/home/user/.config/systemd/user/agent-threads.service'].data = '[Service]\nExecStart=/mine\n';
    expect(() => runInstall(opts, sys, () => {})).toThrow(/not written by/);
    expect(() => runInstall({ ...opts, force: true }, sys, () => {})).not.toThrow();
  });

  it('--dry-run touches nothing', () => {
    const sys = fakeSys();
    const lines: string[] = [];
    runInstall({ ...opts, dryRun: true }, sys, (l) => lines.push(l));
    expect(Object.keys(sys.files)).toEqual([]);
    expect(sys.cmds).toEqual([]);
    expect(lines[0]).toMatch(/^would:/);
  });

  it('refuses outside Linux, and when there is no systemd user manager', () => {
    expect(() => runInstall(opts, fakeSys({}, { platform: 'darwin' }), () => {})).toThrow(/only works on Linux/);
    expect(() => runInstall(opts, fakeSys({}, { exec: () => { throw new Error('no'); } }), () => {})).toThrow(/no systemd user manager/);
  });
});

describe('install rejects a path that would break the unit', () => {
  it('a newline in --workspace is a usage error and writes nothing', () => {
    const sys = fakeSys();
    expect(() => runInstall({ ...opts, workspace: '/srv/x\nUser=root' }, sys, () => undefined)).toThrow(/--workspace/);
    expect(Object.keys(sys.files)).toEqual([]);
  });
});
