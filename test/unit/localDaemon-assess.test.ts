import { describe, it, expect } from 'vitest';
import { assess, assessDaemonVersion, type Desired, type Observed, type PlanAction } from '../../src/localDaemon/assess';
import { MIN_LOCAL_DAEMON_VERSION } from '../../src/localDaemon/spec';

const PLUGIN = '0.65.0';
const desired = (over: Partial<Desired> = {}): Desired => ({ enabled: true, pluginVersion: PLUGIN, specSignature: 'sig', ...over });
const healthyRunning = (over: Partial<Observed> = {}): Observed => ({
  supported: true, runtimeInstalled: true, runtimeRunning: true, imageReady: true, volumesPresent: true,
  container: 'running', containerVersion: PLUGIN, containerSpec: 'sig', health: 'ok',
  welcome: { daemonVersion: PLUGIN, protocol: 1, minClientVersion: '0.0.0' },
  tokenInKeychain: true, tokenAccepted: 'yes', credentialInKeychain: true, credentialInVolume: true, registered: true,
  ...over,
});
const fresh = (over: Partial<Observed> = {}): Observed => ({
  supported: true, runtimeInstalled: false, runtimeRunning: false, imageReady: false, volumesPresent: false,
  container: 'absent', health: 'na', tokenInKeychain: false, tokenAccepted: 'unknown',
  credentialInKeychain: false, credentialInVolume: false, registered: false, ...over,
});

describe('assess', () => {
  it('unsupported wins over everything and plans nothing', () => {
    const a = assess(healthyRunning({ supported: false }), desired());
    expect(a).toMatchObject({ status: 'unsupported', plan: [] });
  });

  it('a fresh Mac: not set up, and what Set up would do', () => {
    const a = assess(fresh(), desired({ enabled: false }));
    expect(a.status).toBe('not-set-up');
    expect(a.plan).toEqual(['install-runtime', 'start-runtime']);
  });

  it('runtime installed and running but nothing else: full creation order', () => {
    const a = assess(fresh({ runtimeInstalled: true, runtimeRunning: true }), desired({ enabled: false }));
    expect(a.status).toBe('not-set-up');
    expect(a.plan).toEqual(['pull-image', 'build-image', 'create-volumes', 'prepare-volumes', 'create-container', 'mint-token', 'register']);
  });

  it('enabled but the runtime is stopped (after a reboot): stopped, start the runtime first', () => {
    const a = assess(fresh({ runtimeInstalled: true, runtimeRunning: false, credentialInVolume: true, credentialInKeychain: true, tokenInKeychain: true, registered: true }), desired());
    expect(a).toMatchObject({ status: 'stopped', plan: ['start-runtime'] });
  });

  it('a foreign container with our name is never touched', () => {
    const a = assess(healthyRunning({ container: 'foreign' }), desired());
    expect(a).toMatchObject({ status: 'conflict', plan: [] });
  });

  it('enabled, container removed by the user: recreate from the surviving image and volumes, keep the token', () => {
    const a = assess(healthyRunning({ container: 'absent', health: 'na', welcome: undefined, tokenAccepted: 'unknown', containerVersion: undefined, containerSpec: undefined }), desired());
    expect(a.status).toBe('stopped');
    expect(a.plan).toEqual(['prepare-volumes', 'create-container']);
  });

  it('volumes wiped: a keychain token from the old life is stale and is re-minted', () => {
    const a = assess(healthyRunning({ container: 'absent', volumesPresent: false, health: 'na', welcome: undefined }), desired());
    expect(a.plan).toEqual(['create-volumes', 'prepare-volumes', 'create-container', 'mint-token']);
  });

  it('stopped container: just start it (updates are prompt-only)', () => {
    const a = assess(healthyRunning({ container: 'stopped', health: 'na', welcome: undefined, containerVersion: '0.64.0' }), desired());
    expect(a.status).toBe('stopped');
    expect(a.update).toBe('available');
    expect(a.plan).toEqual(['start-container']);
  });

  it('stopped container with a drifted spec is recreated, not started', () => {
    const a = assess(healthyRunning({ container: 'stopped', health: 'na', welcome: undefined, containerSpec: 'old' }), desired());
    expect(a.drift).toBe(true);
    expect(a.plan).toEqual(['remove-container', 'prepare-volumes', 'create-container']);
  });

  it('stopped container too old to talk to is rebuilt at the plugin version', () => {
    const a = assess(healthyRunning({ container: 'stopped', health: 'na', welcome: undefined, containerVersion: '0.1.0', imageReady: false }), desired());
    expect(a.update).toBe('required');
    expect(a.plan).toEqual(['remove-container', 'pull-image', 'build-image', 'prepare-volumes', 'create-container']);
  });

  it('running and healthy is Running with an empty plan', () => {
    expect(assess(healthyRunning(), desired())).toMatchObject({ status: 'running', update: 'none', drift: false, needsSignIn: false, plan: [] });
  });

  it('running but not registered: only registration is planned', () => {
    expect(assess(healthyRunning({ registered: false }), desired()).plan).toEqual(['register']);
  });

  it('running, drifted spec: stays Running and reports drift for an explicit Apply', () => {
    const a = assess(healthyRunning({ containerSpec: 'old' }), desired());
    expect(a).toMatchObject({ status: 'running', drift: true, plan: [] });
  });

  it('older but compatible daemon: Running with an update offered', () => {
    const a = assess(healthyRunning({ containerVersion: '0.64.0', welcome: { daemonVersion: '0.64.0', protocol: 1, minClientVersion: '0.0.0' } }), desired());
    expect(a).toMatchObject({ status: 'running', update: 'available', plan: [] });
  });

  it('health down: degraded, restart', () => {
    const a = assess(healthyRunning({ health: 'down', welcome: undefined, tokenAccepted: 'unknown' }), desired());
    expect(a).toMatchObject({ status: 'degraded', degraded: 'health-down', plan: ['restart-container'] });
  });

  it('token rejected: degraded, rotate the token', () => {
    const a = assess(healthyRunning({ tokenAccepted: 'no', welcome: undefined }), desired());
    expect(a).toMatchObject({ status: 'degraded', degraded: 'token-rejected', plan: ['mint-token'] });
  });

  it('no token in the keychain at all: rotate', () => {
    expect(assess(healthyRunning({ tokenInKeychain: false, tokenAccepted: 'unknown', welcome: undefined }), desired()).plan).toEqual(['mint-token']);
  });

  it('protocol mismatch: degraded incompatible, nothing automatic', () => {
    const a = assess(healthyRunning({ welcome: { daemonVersion: PLUGIN, protocol: 2, minClientVersion: '0.0.0' } }), desired());
    expect(a).toMatchObject({ status: 'degraded', degraded: 'incompatible', update: 'required', plan: [] });
  });

  it('plugin older than the daemon allows: update the plugin', () => {
    const a = assess(healthyRunning({ welcome: { daemonVersion: PLUGIN, protocol: 1, minClientVersion: '9.0.0' } }), desired());
    expect(a).toMatchObject({ status: 'degraded', degraded: 'incompatible', update: 'plugin-too-old' });
  });

  it('no Claude credential anywhere: needs sign-in (daemon still runs)', () => {
    const a = assess(healthyRunning({ credentialInKeychain: false, credentialInVolume: false }), desired());
    expect(a).toMatchObject({ status: 'needs-sign-in', needsSignIn: true, plan: [] });
  });

  it('credential in the keychain but not yet in the volume: apply it', () => {
    const a = assess(healthyRunning({ credentialInKeychain: true, credentialInVolume: false }), desired());
    expect(a).toMatchObject({ status: 'degraded', degraded: 'credential-not-applied', plan: ['apply-credential'] });
  });
});

describe('invariants over the fact space', () => {
  const bools = [true, false];
  const containers: Observed['container'][] = ['absent', 'foreign', 'stopped', 'running'];
  const healths: Observed['health'][] = ['ok', 'down', 'na'];
  const accepted: Observed['tokenAccepted'][] = ['yes', 'no', 'unknown'];
  const cases: Observed[] = [];
  for (const supported of bools) for (const installed of bools) for (const running of bools)
    for (const container of containers) for (const health of healths) for (const tokenAccepted of accepted)
      for (const imageReady of bools) for (const volumesPresent of bools) for (const cred of bools) {
        cases.push({
          supported, runtimeInstalled: installed, runtimeRunning: running, imageReady, volumesPresent, container,
          containerVersion: PLUGIN, containerSpec: 'sig', health, tokenInKeychain: tokenAccepted !== 'unknown', tokenAccepted,
          credentialInKeychain: cred, credentialInVolume: cred, registered: false,
        });
      }

  it('always returns exactly one known status and only known actions', () => {
    const statuses = new Set(['unsupported', 'not-set-up', 'conflict', 'stopped', 'running', 'needs-sign-in', 'degraded']);
    const actions = new Set<PlanAction>(['install-runtime', 'start-runtime', 'pull-image', 'build-image', 'create-volumes', 'prepare-volumes',
      'remove-container', 'create-container', 'start-container', 'restart-container', 'apply-credential', 'mint-token', 'register']);
    for (const o of cases) for (const enabled of bools) {
      const a = assess(o, desired({ enabled }));
      expect(statuses.has(a.status)).toBe(true);
      for (const p of a.plan) expect(actions.has(p)).toBe(true);
    }
  });

  it('unsupported always wins; a foreign container is never planned against', () => {
    for (const o of cases) {
      const a = assess(o, desired());
      if (!o.supported) expect(a).toMatchObject({ status: 'unsupported', plan: [] });
      if (o.supported && o.runtimeInstalled && o.runtimeRunning && o.container === 'foreign') expect(a).toMatchObject({ status: 'conflict', plan: [] });
      if (a.status === 'conflict') expect(a.plan).toEqual([]);
    }
  });

  it('never removes a container unless it is ours and stopped', () => {
    for (const o of cases) {
      const a = assess(o, desired());
      if (a.plan.includes('remove-container')) expect(o.container).toBe('stopped');
    }
  });

  it('runtime steps come first and alone when the runtime is down', () => {
    for (const o of cases) {
      if (!o.supported || (o.runtimeInstalled && o.runtimeRunning)) continue;
      const a = assess(o, desired());
      expect(a.plan.every((p) => p === 'install-runtime' || p === 'start-runtime')).toBe(true);
      expect(a.plan.at(-1)).toBe('start-runtime');
    }
  });

  it('create-container is always preceded by prepare-volumes, and mint/register come last', () => {
    for (const o of cases) {
      const { plan } = assess(o, desired());
      const create = plan.indexOf('create-container');
      if (create >= 0) expect(plan.indexOf('prepare-volumes')).toBeGreaterThanOrEqual(0);
      if (create >= 0) expect(plan.indexOf('prepare-volumes')).toBeLessThan(create);
      const mint = plan.indexOf('mint-token');
      if (mint >= 0 && create >= 0) expect(mint).toBeGreaterThan(create);
      const reg = plan.indexOf('register');
      if (reg >= 0) expect(reg).toBe(plan.length - 1);
    }
  });
});

describe('assessDaemonVersion (design section 8)', () => {
  const w = (over: Partial<{ daemonVersion: string; protocol: number; minClientVersion: string }> = {}) => ({ daemonVersion: PLUGIN, protocol: 1, minClientVersion: '0.0.0', ...over });
  it.each([
    ['equal', PLUGIN, undefined, 'none'],
    ['older but allowed', '0.64.0', undefined, 'available'],
    ['newer than the plugin', '0.66.0', undefined, 'available'],
    ['below the floor', '0.1.0', undefined, 'required'],
    ['protocol differs', PLUGIN, w({ protocol: 2 }), 'required'],
    ['plugin below minClientVersion', PLUGIN, w({ minClientVersion: '0.70.0' }), 'plugin-too-old'],
  ] as const)('%s', (_n, daemon, welcome, expected) => {
    expect(assessDaemonVersion(PLUGIN, daemon, welcome)).toBe(expected);
  });
  it('the floor itself is allowed', () => {
    expect(assessDaemonVersion(PLUGIN, MIN_LOCAL_DAEMON_VERSION)).toBe('available');
  });
});
