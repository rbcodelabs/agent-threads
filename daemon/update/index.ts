/** Wiring for the daemon: real network, filesystem and supervisor probes, each overridable for tests. */
import type { DaemonConfig } from '../config';
import { applyUpdate, type Applied } from './apply';
import { AutoUpdater } from './autoUpdater';
import type { ActivitySource } from './idle';
import { assessInstall, realInstallProbe, runningBundlePath, type InstallAssessment } from './install';
import { githubReleases, type FetchLike, type LatestRelease, type ReleaseSource } from './release';
import { DAEMON_VERSION } from '../version';

export interface AutoUpdateOverrides {
  assessment?: InstallAssessment;
  fetch?: FetchLike;
  releases?: ReleaseSource;
  apply?: (release: LatestRelease) => Promise<Applied>;
  bundlePath?: string;
  currentVersion?: string;
  tickMs?: number;
  initialDelayMs?: number;
  retryBaseMs?: number;
  intervalMs?: number;
  quietMs?: number;
  runVersion?: (file: string) => Promise<string>;
}

export interface CreateAutoUpdaterInput {
  config: DaemonConfig;
  activity: ActivitySource;
  audit: (record: Record<string, unknown>) => void;
  log: (line: string) => void;
  onRestart: (info: { to: string }) => void;
  now?: () => number;
  overrides?: AutoUpdateOverrides;
}

export async function createAutoUpdater(i: CreateAutoUpdaterInput): Promise<AutoUpdater> {
  const ov = i.overrides ?? {};
  const bundlePath = ov.bundlePath ?? runningBundlePath();
  const currentVersion = ov.currentVersion ?? DAEMON_VERSION;
  const assessment = ov.assessment ?? await assessInstall(realInstallProbe(bundlePath), 'daemon');
  const fetchImpl: FetchLike = ov.fetch ?? ((url, init) => fetch(url, init));
  return new AutoUpdater({
    dataDir: i.config.dataDir,
    currentVersion,
    enabled: i.config.autoUpdate,
    assessment,
    intervalMs: ov.intervalMs ?? i.config.autoUpdateIntervalMinutes * 60_000,
    quietMs: ov.quietMs ?? i.config.autoUpdateQuietMinutes * 60_000,
    ...(ov.tickMs !== undefined ? { tickMs: ov.tickMs } : {}),
    ...(ov.initialDelayMs !== undefined ? { initialDelayMs: ov.initialDelayMs } : {}),
    ...(ov.retryBaseMs !== undefined ? { retryBaseMs: ov.retryBaseMs } : {}),
    releases: ov.releases ?? githubReleases({ fetch: fetchImpl }),
    apply: ov.apply ?? ((release) => applyUpdate({
      release, currentVersion, bundlePath: bundlePath!, dataDir: i.config.dataDir, nodePath: process.execPath, fetch: fetchImpl, log: i.log,
      ...(ov.runVersion ? { runVersion: ov.runVersion } : {}),
      ...(i.now ? { now: i.now } : {}),
    })),
    activity: i.activity,
    ...(i.now ? { now: i.now } : {}),
    log: i.log,
    audit: i.audit,
    onRestart: i.onRestart,
  });
}
