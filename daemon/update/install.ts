/**
 * Can this install replace its own bundle, and what does it do to replace it?
 *
 * Detection, not assumption: an install is "updatable" only when it runs from the release bundle, is not in a
 * container, can write the directory the bundle lives in, and a supervisor will start it again after it exits. Anything
 * else is reported with the reason and never modified.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface InstallProbe {
  platform: string;
  env: NodeJS.ProcessEnv;
  /** Absolute path of the running bundle, or undefined when not running from one (source checkout, npm). */
  bundlePath: string | undefined;
  exists(path: string): boolean;
  readText(path: string): string | null;
  canWriteDir(path: string): boolean;
  run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }>;
}

export type InstallKind = 'systemd' | 'container' | 'source' | 'unsupported';

export interface InstallAssessment {
  available: boolean;
  kind: InstallKind;
  /** Why not (when `available` is false), or a note on how it was judged. */
  reason?: string;
  bundlePath?: string;
  /** The supervising systemd unit and its `Restart=` value, when found. */
  unit?: { name: string; scope: 'user' | 'system'; restart: string };
}

/** Restart= values that bring a service back after a non-zero exit, which is how an update restart is signalled. */
export const RESTARTS_ON_NONZERO_EXIT = new Set(['always', 'on-failure']);

export function realInstallProbe(bundlePath: string | undefined = runningBundlePath(), env: NodeJS.ProcessEnv = process.env): InstallProbe {
  return {
    platform: process.platform,
    env,
    bundlePath,
    exists: (p) => existsSync(p),
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    canWriteDir: (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } },
    run: (cmd, args, timeoutMs) => new Promise((resolve) => {
      try {
        execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', env: { PATH: env.PATH ?? '', XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? '', DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS ?? '' } }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }));
      } catch { resolve({ ok: false, stdout: '' }); }
    }),
  };
}

/** The release bundle this process runs from, if it is one (`agent-threads.cjs`), else undefined. */
export function runningBundlePath(): string | undefined {
  return typeof __filename === 'string' && __filename.endsWith('.cjs') ? __filename : undefined;
}

export function inContainer(p: InstallProbe): boolean {
  if (p.exists('/.dockerenv') || p.exists('/run/.containerenv')) return true;
  const cgroup = p.readText('/proc/1/cgroup') ?? '';
  return /(docker|containerd|kubepods|libpod|lxc)/.test(cgroup);
}

/** `0::/user.slice/user-1000.slice/user@1000.service/app.slice/agent-threads.service` -> the unit and its scope. */
export function unitFromCgroup(text: string): { name: string; scope: 'user' | 'system' } | null {
  for (const line of text.split('\n')) {
    const path = line.split(':').slice(2).join(':');
    const last = path.split('/').filter(Boolean).at(-1);
    if (last && last.endsWith('.service') && !/^user@\d+\.service$/.test(last)) {
      return { name: last, scope: /\/user@\d+\.service\//.test(path) ? 'user' : 'system' };
    }
  }
  return null;
}

async function restartPolicy(p: InstallProbe, name: string, scope: 'user' | 'system'): Promise<string | null> {
  const r = await p.run('systemctl', [...(scope === 'user' ? ['--user'] : []), 'show', name, '-p', 'Restart', '--value'], 4000);
  const v = r.stdout.trim();
  return r.ok && v ? v : null;
}

/**
 * `from: 'daemon'` runs inside the service, so its own cgroup names the unit. `from: 'cli'` runs from a shell, where
 * that is not possible: it looks for the unit `agent-threads` that `agent-threads install` creates (user, then system).
 */
export async function assessInstall(p: InstallProbe, from: 'daemon' | 'cli' = 'daemon'): Promise<InstallAssessment> {
  const no = (kind: InstallKind, reason: string): InstallAssessment => ({ available: false, kind, reason, ...(p.bundlePath ? { bundlePath: p.bundlePath } : {}) });
  if (p.platform !== 'linux') return no('unsupported', `auto-update supports Linux with systemd (this is ${p.platform}); upgrade by hand (docs/remote-daemon.md, "Upgrade")`);
  if (!p.bundlePath) return no('source', 'not running from the release bundle (agent-threads.cjs), e.g. a source checkout or an npm install; upgrade it the way it was installed');
  if (inContainer(p)) return no('container', 'running in a container: the daemon never rewrites its own image. Pull a newer image tag and recreate the container (docker compose pull && docker compose up -d), or let a watchtower-style updater do it (docs/remote-daemon.md, "Automatic updates")');
  const dir = dirname(p.bundlePath);
  if (!p.canWriteDir(dir)) return no('systemd', `${dir} is not writable by this user (a read-only or root-owned install, such as the system-wide unit); upgrade it by hand`);

  let unit: { name: string; scope: 'user' | 'system' } | null = null;
  if (from === 'daemon') {
    if (!p.env.INVOCATION_ID) return no('systemd', 'not started by systemd (no INVOCATION_ID), so nothing would restart it after the update; run it as a service (agent-threads install)');
    unit = unitFromCgroup(p.readText('/proc/self/cgroup') ?? '');
    if (!unit) return no('systemd', 'could not tell which systemd unit runs this process, so its Restart= policy is unknown');
  }
  const candidates = unit ? [unit] : [{ name: 'agent-threads.service', scope: 'user' as const }, { name: 'agent-threads.service', scope: 'system' as const }];
  for (const c of candidates) {
    const restart = await restartPolicy(p, c.name, c.scope);
    if (restart === null) continue;
    if (!RESTARTS_ON_NONZERO_EXIT.has(restart)) {
      return { ...no('systemd', `${c.name} has Restart=${restart}, so it would stay down after the update restart (needs on-failure or always)`), unit: { ...c, restart } };
    }
    return { available: true, kind: 'systemd', bundlePath: p.bundlePath, unit: { ...c, restart } };
  }
  return no('systemd', unit ? `could not read the Restart= policy of ${unit.name} (is systemctl reachable from the service?)` : 'no systemd unit named agent-threads was found to restart this daemon');
}
