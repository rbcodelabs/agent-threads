/**
 * Test harness for the local daemon: a real controller wired to the fake `container` binary through the REAL
 * command runner (so spawn, stdin `input`, abort and timeouts are the production code paths), with in-memory
 * keychain, settings and registry.
 */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDefaultVmCommandRunner } from '../../src/containerCli';
import { LocalDaemonController, type LocalDaemonDeps } from '../../src/localDaemon/controller';
import type { RuntimeApi } from '../../src/localDaemon/runtime';
import { LOCAL_DAEMON_TOKEN_SECRET } from '../../src/localDaemon/registration';
import { CONTAINER_AUTH_TOKEN_SECRET } from '../../src/claudeContainerAuthCli';
import { LABEL_VERSION, containerNameFor, dataVolumeFor } from '../../src/localDaemon/spec';
import type { LocalDaemonSettings, RemoteDaemonConfig } from '../../src/types';
import type { ProbeResult } from '../../src/remote/DaemonClient';

export interface FakeState {
  images: Record<string, { published?: boolean; built?: boolean }>;
  volumes: Record<string, { owner: number; credential?: string; tokens?: Array<{ id: string; name: string; token: string; revokedAt: number | null }> }>;
  containers: Record<string, { state: 'running' | 'stopped'; labels: Record<string, string>; hostPort: number; volumes: string[]; env: string[]; cmd: string[]; publish: string }>;
  calls: string[][];
  portsTaken?: number[];
  unhealthy?: boolean;
  eaccess?: boolean;
}

export interface HarnessOptions {
  pluginVersion?: string;
  vaultPath?: string;
  fail?: string[];
  runtime?: { supported?: boolean; installed?: boolean; running?: boolean; reason?: string };
  settings?: LocalDaemonSettings;
  secrets?: Record<string, string>;
  maskedDirs?: string[];
  /** What Geode's `externalRoots.listMountRoots()` reports (a function so a test can change it between calls). */
  externalRoots?: () => Array<{ rootId?: string; label?: string; path?: string }>;
  /** Extra directories that exist on the (fake) host, besides the vault's config dirs. */
  existingDirs?: string[];
  signIn?: LocalDaemonDeps['signInRunner'];
  harnessSignIn?: LocalDaemonDeps['harnessSignInRunner'];
  existingRegistration?: RemoteDaemonConfig;
}

const FAKE = resolve(__dirname, 'fake-container.mjs');

export function makeHarness(opts: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ld-test-'));
  const statePath = join(dir, 'state.json');
  const wrapper = join(dir, 'container');
  writeFileSync(wrapper, `#!/bin/sh\nFAKE_CONTAINER_STATE='${statePath}' FAKE_CONTAINER_FAIL="$(cat '${join(dir, 'fail')}' 2>/dev/null)" exec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  const failFile = join(dir, 'fail');
  writeFileSync(failFile, (opts.fail ?? []).join(','));
  const vaultPath = opts.vaultPath ?? join(dir, 'vault');
  mkdirSync(join(vaultPath, '.geode'), { recursive: true });
  mkdirSync(join(vaultPath, '.obsidian'), { recursive: true });
  const pluginVersion = opts.pluginVersion ?? '0.65.0';

  const readState = (): FakeState => (existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { images: {}, volumes: {}, containers: {}, calls: [] });
  const writeState = (s: FakeState) => writeFileSync(statePath, JSON.stringify(s));

  const secrets = new Map<string, string>(Object.entries(opts.secrets ?? {}));
  let settings: LocalDaemonSettings | undefined = opts.settings;
  let registered: RemoteDaemonConfig | undefined = opts.existingRegistration;
  const runtimeState = { supported: true, installed: true, running: true, reason: undefined as string | undefined, ...opts.runtime };
  const runtimeCalls: string[] = [];
  const runtime: RuntimeApi = {
    status: async () => ({
      supported: runtimeState.supported,
      ...(runtimeState.reason ? { reason: runtimeState.reason } : {}),
      ...(runtimeState.installed ? { detected: { binary: wrapper, source: 'managed' as const } } : {}),
      running: runtimeState.running,
    }),
    install: async () => { runtimeCalls.push('install'); runtimeState.installed = true; return { binary: wrapper }; },
    start: async () => { runtimeCalls.push('start'); runtimeState.running = true; },
  };

  const name = containerNameFor(vaultPath);
  const healthy = (port: number) => {
    const s = readState();
    return !s.unhealthy && Object.values(s.containers).some((c) => c.state === 'running' && c.hostPort === port);
  };

  const deps: LocalDaemonDeps = {
    vaultPath: () => vaultPath,
    pluginVersion,
    isDirectory: (p) => (opts.existingDirs ?? []).includes(p) || (opts.maskedDirs ?? ['.geode', '.obsidian']).some((d) => p.endsWith(`/${d}`)),
    ...(opts.externalRoots ? { externalRoots: async () => opts.externalRoots!() } : {}),
    runtime,
    createRunner: () => createDefaultVmCommandRunner(wrapper),
    healthz: async (port) => healthy(port),
    probeDaemon: async (_url, token): Promise<ProbeResult> => {
      const s = readState();
      const c = s.containers[name];
      const vol = s.volumes[dataVolumeFor(vaultPath)];
      const valid = vol?.tokens?.some((t) => t.token === token && t.revokedAt === null);
      if (!c || c.state !== 'running') return { ok: false, status: 'unreachable', detail: 'down' };
      if (!valid) return { ok: false, status: 'unauthorized', detail: 'bad token' };
      return { ok: true, info: { daemonId: 'd', daemonVersion: c.labels[LABEL_VERSION] ?? '0.0.0', protocol: 1, minClientVersion: '0.0.0', capabilities: [], epoch: 'e' } };
    },
    portFree: async (port) => !(readState().portsTaken ?? []).includes(port),
    sleep: async () => undefined,
    secrets: { get: (n) => secrets.get(n) || undefined, set: (n, v) => { secrets.set(n, v); } },
    loadSettings: () => settings,
    saveSettings: async (next) => { settings = next; },
    getRegistered: () => registered,
    register: async (c) => { registered = c; },
    unregister: async () => { registered = undefined; },
    ...(opts.signIn ? { signInRunner: opts.signIn } : {}),
    ...(opts.harnessSignIn ? { harnessSignInRunner: opts.harnessSignIn } : {}),
    healthAttempts: 3,
    healthDelayMs: 0,
  };
  const controller = new LocalDaemonController(deps);
  return {
    controller, deps, dir, vaultPath, name, wrapper, pluginVersion,
    readState, writeState, secrets, runtimeState, runtimeCalls,
    /** Change which CLI calls fail from now on (e.g. `pull:404`). */
    setFail(list: string[]) { writeFileSync(failFile, list.join(',')); },
    get settings() { return settings; },
    get registered() { return registered; },
    setSettings(s: LocalDaemonSettings | undefined) { settings = s; },
    setRegistered(r: RemoteDaemonConfig | undefined) { registered = r; },
    token: () => secrets.get(LOCAL_DAEMON_TOKEN_SECRET),
    claude: () => secrets.get(CONTAINER_AUTH_TOKEN_SECRET),
    calls: () => readState().calls.map((c) => c.join(' ')),
  };
}

export type Harness = ReturnType<typeof makeHarness>;
