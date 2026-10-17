import { assess, type Observed } from '../../src/localDaemon/assess';
import type { LocalDaemonSnapshot } from '../../src/localDaemon/controller';

const PLUGIN = '0.65.0';
const running: Observed = {
  supported: true, runtimeInstalled: true, runtimeRunning: true, imageReady: true, volumesPresent: true, container: 'running',
  containerVersion: PLUGIN, containerSpec: 's', health: 'ok', welcome: { daemonVersion: PLUGIN, protocol: 1, minClientVersion: '0.0.0' },
  tokenInKeychain: true, tokenAccepted: 'yes', credentialInKeychain: true, credentialInVolume: true, registered: true,
};

export function snap(over: Partial<Observed> = {}, extra: Partial<LocalDaemonSnapshot> = {}, enabled = true): LocalDaemonSnapshot {
  const observed = { ...running, ...over };
  return {
    assessment: assess(observed, { enabled, pluginVersion: PLUGIN, specSignature: 's' }),
    observed,
    daemonVersion: observed.containerVersion,
    pluginVersion: PLUGIN,
    port: 7433,
    vaultPath: '/Users/user/Vault',
    mounts: [
      { host: '/Users/user/Vault', guest: '/vault', readOnly: false },
      { host: '/Users/user/Vault/.geode', guest: '/vault/.geode', readOnly: true },
      { host: '/Users/user/Vault/.obsidian', guest: '/vault/.obsidian', readOnly: true },
    ],
    busy: null,
    lastError: null,
    ...extra,
  };
}

