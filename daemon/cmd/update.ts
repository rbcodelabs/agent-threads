/**
 * `agent-threads update --check | --apply [--now]`.
 *
 * `--check` is read-only: current vs latest stable, whether auto-update is on and possible here, and (from the
 * running daemon's `update-status.json`) when an update would be applied. `--apply` is the manual path through the
 * same safe procedure as the automatic one (download, checksum, sanity check, keep `.prev`, atomic swap) and then
 * asks a running daemon to restart onto it when idle; `--now` skips only that idle wait.
 */
import { CliError, EXIT } from './exit';
import { UpdateError, UpdateHeld, type LatestRelease, type ReleaseSource } from '../update/release';
import { isMajorBump, isNewerVersion, parseStableVersion } from '../update/semver';
import type { Applied } from '../update/apply';
import type { InstallAssessment } from '../update/install';
import { readState, readStatus, withUpdateLock, writeRequest, type UpdateStatus } from '../update/state';

export interface UpdateSettings {
  enabled: boolean;
  intervalMinutes: number;
  quietMinutes: number;
}

export interface UpdateDeps {
  currentVersion: string;
  dataDir: string;
  releases: ReleaseSource;
  assess(): Promise<InstallAssessment>;
  apply(release: LatestRelease): Promise<Applied>;
  /** Auto-update settings as config/env say (the CLI cannot see the daemon's flags). */
  settings(): UpdateSettings;
  now(): number;
  pidAlive(pid: number): boolean;
}

export interface UpdateOptions { check: boolean; apply: boolean; now: boolean; json: boolean }

export interface UpdateReport {
  current: string;
  latest: string | null;
  relation: 'update_available' | 'up_to_date' | 'ahead' | 'unknown';
  /** Why the latest release will not be applied automatically, if so. */
  heldReason?: string;
  autoUpdate: UpdateSettings & { source: 'daemon' | 'config' };
  install: { available: boolean; kind: string; reason?: string; unit?: string; restart?: string };
  daemon: { running: boolean; phase?: string; pendingVersion?: string; waiting?: UpdateStatus['waiting']; lastCheckAt?: number; nextCheckAt?: number; lastError?: string; statusAt?: number } | null;
  /** One sentence: when (or whether) an update would be applied. */
  when: string;
}

const min = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;
const at = (ms: number): string => new Date(ms).toISOString();

export function buildReport(i: {
  current: string; latest: LatestRelease | null; settings: UpdateSettings; install: InstallAssessment; status: UpdateStatus | null; daemonRunning: boolean; heldReason?: string;
}): UpdateReport {
  const { current, latest, install, status } = i;
  const relation: UpdateReport['relation'] = !latest || !parseStableVersion(current) ? 'unknown'
    : isNewerVersion(latest.version, current) ? 'update_available'
      : latest.version === current ? 'up_to_date' : 'ahead';
  // A running daemon knows its own flags; otherwise config and environment are the best we can say.
  const fromDaemon = i.daemonRunning && status !== null;
  const settings = fromDaemon ? { enabled: status.enabled, intervalMinutes: status.intervalMinutes, quietMinutes: status.quietMinutes } : i.settings;
  const canAuto = settings.enabled && (fromDaemon ? status.available : install.available);

  let when: string;
  if (relation !== 'update_available') when = 'nothing to apply';
  else if (i.heldReason) when = `not automatically: ${i.heldReason}`;
  else if (fromDaemon && status.pendingVersion) {
    when = status.waiting
      ? `${status.pendingVersion} is installed; restarting once idle (${status.waiting.busyThreads} busy thread(s), ${min(status.waiting.quietRemainingMs)} of quiet still needed)`
      : `${status.pendingVersion} is installed; the daemon is about to restart onto it`;
  } else if (!settings.enabled) when = 'not automatically (auto-update is off); run `agent-threads update --apply`';
  else if (!canAuto) when = 'not automatically: this install cannot update itself (see above); upgrade by hand';
  else if (fromDaemon && status.nextCheckAt) when = `at the daemon's next check (${at(status.nextCheckAt)}), then once it has been idle for ${settings.quietMinutes} min`;
  else when = `at the daemon's next check (every ${settings.intervalMinutes} min), then once it has been idle for ${settings.quietMinutes} min`;

  return {
    current,
    latest: latest?.version ?? null,
    relation,
    ...(i.heldReason ? { heldReason: i.heldReason } : {}),
    autoUpdate: { ...settings, source: fromDaemon ? 'daemon' : 'config' },
    install: { available: install.available, kind: install.kind, ...(install.reason ? { reason: install.reason } : {}), ...(install.unit ? { unit: install.unit.name, restart: install.unit.restart } : {}) },
    daemon: status
      ? {
        running: i.daemonRunning, phase: status.phase, ...(status.pendingVersion ? { pendingVersion: status.pendingVersion } : {}),
        ...(status.waiting ? { waiting: status.waiting } : {}), ...(status.lastCheckAt ? { lastCheckAt: status.lastCheckAt } : {}),
        ...(status.nextCheckAt ? { nextCheckAt: status.nextCheckAt } : {}), ...(status.lastError ? { lastError: status.lastError } : {}), statusAt: status.updatedAt,
      }
      : null,
    when,
  };
}

export function formatReport(r: UpdateReport): string[] {
  const rel = { update_available: 'update available', up_to_date: 'up to date', ahead: 'newer than the latest release', unknown: 'unknown' }[r.relation];
  const lines = [
    `current:      ${r.current}`,
    `latest:       ${r.latest ?? '(no stable release found)'}  (${rel})`,
    `auto-update:  ${r.autoUpdate.enabled ? `on, checks every ${r.autoUpdate.intervalMinutes} min, restarts after ${r.autoUpdate.quietMinutes} min idle` : 'off'}${r.autoUpdate.source === 'config' ? ' (from config/environment; the daemon was not seen running)' : ''}`,
    `this install: ${r.install.available ? `can update itself${r.install.unit ? ` (${r.install.unit}, Restart=${r.install.restart})` : ''}` : `cannot update itself: ${r.install.reason ?? r.install.kind}`}`,
  ];
  if (r.daemon) {
    lines.push(`daemon:       ${r.daemon.running ? 'running' : 'not running (status is from its last run)'}, ${r.daemon.phase}${r.daemon.lastError ? `, last error: ${r.daemon.lastError}` : ''}`);
    if (r.daemon.lastCheckAt) lines.push(`last check:   ${at(r.daemon.lastCheckAt)}`);
  }
  lines.push(`applies:      ${r.when}`);
  return lines;
}

/** Why a release will not be applied automatically, from what is known before downloading it. */
function heldReasonFor(dataDir: string, release: LatestRelease | null, current: string): string | undefined {
  if (!release || !isNewerVersion(release.version, current)) return undefined;
  if (isMajorBump(release.version, current)) return `${release.version} is a new major version`;
  const held = readState(dataDir).held;
  if (held && held.version === release.version) return held.reason;
  const rolled = readState(dataDir).rolledBack;
  if (rolled && rolled.from === release.version) return `${release.version} was rolled back after failing to start; paused until a newer release`;
  return undefined;
}

async function latestOrThrow(deps: UpdateDeps): Promise<LatestRelease | null> {
  try { return await deps.releases.latest(); } catch (err) {
    throw new CliError(`could not check for updates: ${err instanceof Error ? err.message : String(err)}`, EXIT.FAILED);
  }
}

export async function runUpdate(o: UpdateOptions, deps: UpdateDeps, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  if (o.check === o.apply) throw new CliError('usage: agent-threads update --check | --apply [--now]', EXIT.USAGE);
  if (o.now && !o.apply) throw new CliError('--now only goes with --apply', EXIT.USAGE);
  const install = await deps.assess();
  const status = readStatus(deps.dataDir);
  const daemonRunning = !!status && deps.pidAlive(status.pid);

  if (o.check) {
    const latest = await latestOrThrow(deps);
    const report = buildReport({ current: deps.currentVersion, latest, settings: deps.settings(), install, status, daemonRunning, heldReason: heldReasonFor(deps.dataDir, latest, deps.currentVersion) });
    if (o.json) out(JSON.stringify(report)); else for (const l of formatReport(report)) out(l);
    return EXIT.OK;
  }

  if (!install.available) throw new CliError(`this install cannot be updated in place: ${install.reason ?? install.kind}`, EXIT.FAILED);
  const latest = await latestOrThrow(deps);
  if (!latest || !isNewerVersion(latest.version, deps.currentVersion)) {
    const msg = latest ? `already up to date (${deps.currentVersion}; latest stable is ${latest.version})` : 'no stable release with a daemon bundle was found';
    if (o.json) out(JSON.stringify({ applied: false, current: deps.currentVersion, latest: latest?.version ?? null, message: msg })); else out(msg);
    return EXIT.OK;
  }
  let applied: Applied | null;
  try {
    applied = await withUpdateLock(deps.dataDir, () => deps.apply(latest), deps.now);
  } catch (e) {
    if (e instanceof UpdateHeld) throw new CliError(e.reason, EXIT.FAILED);
    if (e instanceof UpdateError) throw new CliError(`update failed at the ${e.stage} step; the installed bundle was not changed: ${e.message}`, EXIT.FAILED);
    throw e;
  }
  if (!applied) throw new CliError('another update is in progress (update.lock); try again in a minute', EXIT.FAILED);
  writeRequest(deps.dataDir, { version: applied.to, now: o.now, requestedAt: deps.now() });

  let note: string;
  if (!daemonRunning) note = 'No running daemon was found; start or restart it yourself to run the new version (for the user service: systemctl --user restart agent-threads).';
  else if (status && !status.available) note = `The running daemon cannot restart itself (${status.reason ?? 'unsupported install'}); restart it yourself to run the new version.`;
  else if (o.now) note = 'Asked the running daemon to restart now (a running turn will be closed as daemon_restarted and resumes on the next message).';
  else note = `Asked the running daemon to restart onto it once it is idle (no turn or open request, quiet for ${status?.quietMinutes ?? 2} min). A running turn is never interrupted.`;
  if (o.json) out(JSON.stringify({ applied: true, from: applied.from, to: applied.to, previous: applied.prevPath, note }));
  else {
    out(`installed ${applied.to} (was ${applied.from}); the previous bundle is kept at ${applied.prevPath}`);
    out(note);
  }
  return EXIT.OK;
}
