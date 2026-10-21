/**
 * Local daemon: derive a status and an ordered, idempotent plan from OBSERVED
 * facts. Pure and total: no I/O, no clock.
 *
 * Why observe-then-reconcile rather than a hand-kept state variable: Geode can
 * crash, a user can `container rm`, the runtime can restart. Persisted state is
 * only intent (`enabled`); everything else is read from the world each time it
 * is needed. Design: docs/local-daemon-design.md section 5.
 */

import { PROTOCOL_VERSION } from '../protocol/envelope';
import { compareVersions } from '../remote/DaemonClient';
import type { HarnessProbeResult } from './parse';
import { MIN_LOCAL_DAEMON_VERSION, normalizeHarnesses, type LocalHarness } from './spec';

export type ContainerPresence = 'absent' | 'foreign' | 'stopped' | 'running';

export interface WelcomeFacts {
  daemonVersion: string;
  protocol: number;
  minClientVersion: string;
}

export interface Observed {
  supported: boolean;
  unsupportedReason?: string;
  runtimeInstalled: boolean;
  runtimeRunning: boolean;
  /** The thin image for the target version exists locally. */
  imageReady: boolean;
  /** Both named volumes exist. */
  volumesPresent: boolean;
  /**
   * Our labelled container, or `foreign` when the name is taken by a container we did not create (never touched),
   * or `absent`.
   */
  container: ContainerPresence;
  /** From the container's labels, when it is ours and exists. */
  containerVersion?: string;
  containerSpec?: string;
  health: 'ok' | 'down' | 'na';
  /** What the running daemon said in `welcome`, when it was reachable with our token. */
  welcome?: WelcomeFacts;
  tokenInKeychain: boolean;
  tokenAccepted: 'yes' | 'no' | 'unknown';
  /** The Claude sign-in token is in the keychain (it can be written into the data volume). */
  credentialInKeychain: boolean;
  /**
   * The credential file is in the data volume. Probed by `exec` while the container runs; for a stopped container
   * this is the last known value (the volume persists).
   */
  credentialInVolume: boolean;
  /** The Remote daemons entry exists and points at the current port and token secret. */
  registered: boolean;
  /** Harnesses the user turned on (absent = Claude only). */
  harnesses?: LocalHarness[];
  /** From a probe of the running container: which CLIs are in the image and which logins exist. Absent when not running or unknown. */
  harnessProbe?: HarnessProbeResult;
}

export interface Desired {
  /** Set once the user has run Set up; cleared by Remove. */
  enabled: boolean;
  pluginVersion: string;
  /**
   * Signature of the spec for the version the container ALREADY runs (or the plugin version when there is no
   * container). Version bumps are an explicit Update, never silent drift.
   */
  specSignature: string;
}

export type LocalDaemonStatus =
  | 'unsupported'
  | 'not-set-up'
  | 'conflict'
  | 'stopped'
  | 'running'
  | 'needs-sign-in'
  | 'degraded';

export type DegradedReason = 'health-down' | 'token-rejected' | 'incompatible' | 'credential-not-applied';

/** `available`: works, Update offered. `required`: incompatible, must update. `plugin-too-old`: update the plugin. */
export type UpdateState = 'none' | 'available' | 'required' | 'plugin-too-old';

export type PlanAction =
  | 'install-runtime'
  | 'start-runtime'
  | 'pull-image'
  | 'build-image'
  | 'create-volumes'
  | 'prepare-volumes'
  | 'remove-container'
  | 'create-container'
  | 'start-container'
  | 'restart-container'
  | 'apply-credential'
  | 'mint-token'
  | 'register';

export interface Assessment {
  status: LocalDaemonStatus;
  degraded?: DegradedReason;
  update: UpdateState;
  /** The container's spec differs from what would be created now (recreate to apply). */
  drift: boolean;
  /** Claude credential is missing; the daemon runs but a turn would fail. */
  needsSignIn: boolean;
  /** Ordered actions that bring the daemon to Running from here. Empty when nothing is needed. */
  plan: PlanAction[];
}

/** The version rule (design section 8). Pure so it is table-testable. */
export function assessDaemonVersion(pluginVersion: string, daemonVersion: string, welcome?: WelcomeFacts): UpdateState {
  if (welcome) {
    if (welcome.protocol !== PROTOCOL_VERSION) return 'required';
    if (compareVersions(pluginVersion, welcome.minClientVersion) < 0) return 'plugin-too-old';
  }
  if (compareVersions(daemonVersion, MIN_LOCAL_DAEMON_VERSION) < 0) return 'required';
  return compareVersions(daemonVersion, pluginVersion) === 0 ? 'none' : 'available';
}

function claudeEnabled(o: Observed): boolean {
  return normalizeHarnesses(o.harnesses).includes('claude');
}

/** Only the Claude credential gates the status line; Codex and OpenCode sign-in state is shown per harness, never blocking. */
function needsSignIn(o: Observed): boolean {
  return claudeEnabled(o) && !o.credentialInKeychain && !o.credentialInVolume;
}

function needsToken(o: Observed): boolean {
  // A fresh volume has no tokens, so a keychain token from an earlier life of the daemon is stale.
  return !o.tokenInKeychain || o.tokenAccepted === 'no' || !o.volumesPresent;
}

/** Steps to create a fresh container from nothing (image, volumes, ownership, run). */
function createSteps(o: Observed): PlanAction[] {
  const steps: PlanAction[] = [];
  if (!o.imageReady) steps.push('pull-image', 'build-image');
  if (!o.volumesPresent) steps.push('create-volumes');
  steps.push('prepare-volumes', 'create-container');
  return steps;
}

export function assess(o: Observed, d: Desired): Assessment {
  const base = { drift: false, needsSignIn: false, update: 'none' as UpdateState };
  if (!o.supported) return { ...base, status: 'unsupported', plan: [] };

  // Without a running runtime the container, image and volumes cannot be observed. Plan only the runtime steps;
  // the caller re-observes and plans again (reconcile loop), so the plan never guesses at unseen facts.
  if (!o.runtimeInstalled || !o.runtimeRunning) {
    const plan: PlanAction[] = [];
    if (!o.runtimeInstalled) plan.push('install-runtime');
    plan.push('start-runtime');
    return { ...base, status: d.enabled ? 'stopped' : 'not-set-up', plan };
  }

  if (o.container === 'foreign') return { ...base, status: 'conflict', plan: [] };

  const registerStep: PlanAction[] = o.registered ? [] : ['register'];
  const tokenStep: PlanAction[] = needsToken(o) ? ['mint-token'] : [];

  if (o.container === 'absent') {
    if (!d.enabled) return { ...base, status: 'not-set-up', plan: [...createSteps(o), ...tokenStep, ...registerStep] };
    // Enabled but the container vanished (user ran `container rm`): recreate from the volumes we still have.
    return { ...base, status: 'stopped', needsSignIn: needsSignIn(o), plan: [...createSteps(o), ...tokenStep, ...registerStep] };
  }

  const version = o.containerVersion ?? d.pluginVersion;
  const drift = o.containerSpec !== undefined && o.containerSpec !== d.specSignature;
  const update = assessDaemonVersion(d.pluginVersion, o.welcome?.daemonVersion ?? version, o.welcome);
  const common = { drift, update, needsSignIn: needsSignIn(o) };

  if (o.container === 'stopped') {
    // An incompatible daemon is not started as is: it is rebuilt at the plugin version. A merely different one is
    // started unchanged (updates are prompt-only).
    const recreate = drift || update === 'required';
    const plan: PlanAction[] = recreate
      ? ['remove-container', ...(o.imageReady ? [] : (['pull-image', 'build-image'] as PlanAction[])), 'prepare-volumes', 'create-container']
      : ['start-container'];
    return { ...common, status: 'stopped', plan: [...plan, ...tokenStep, ...registerStep] };
  }

  // running
  if (o.health === 'down') {
    return { ...common, status: 'degraded', degraded: 'health-down', plan: ['restart-container', ...tokenStep, ...registerStep] };
  }
  if (update === 'required' || update === 'plugin-too-old') {
    return { ...common, status: 'degraded', degraded: 'incompatible', plan: [] };
  }
  if (needsToken(o)) {
    return { ...common, status: 'degraded', degraded: 'token-rejected', plan: [...tokenStep, ...registerStep] };
  }
  if (claudeEnabled(o) && !o.credentialInVolume && o.credentialInKeychain) {
    return { ...common, status: 'degraded', degraded: 'credential-not-applied', plan: ['apply-credential', ...registerStep] };
  }
  if (needsSignIn(o)) return { ...common, status: 'needs-sign-in', plan: registerStep };
  return { ...common, status: 'running', plan: registerStep };
}
