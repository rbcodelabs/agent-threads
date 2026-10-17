/**
 * Local daemon: builds the real controller from a small host interface.
 * Geode-only wiring (the only file here that touches Node I/O directly); every
 * Node built-in is required inside a function so the plugin bundle still loads
 * on mobile, where this is never called.
 */

import type { LocalDaemonSettings, RemoteDaemonConfig } from '../types';
import { daemonWsUrl, probeDaemon, type WebSocketFactory } from '../remote/DaemonClient';
import { signInToClaudeInContainer, type SpawnLike } from '../claudeContainerAuthCli';
import { runnerEnv, createDefaultVmCommandRunner } from '../containerCli';
import { LocalDaemonController, type LocalDaemonDeps } from './controller';
import { LocalDaemonGithubDelivery, type LocalDaemonGithubDeps } from './githubDelivery';
import { LocalDaemonSessionPrep, type SessionPrepDeps } from './sessionPrep';
import { nodeFs } from './containerFiles';
import { nodeAwsCopyFs } from './awsCopy';
import { createDefaultRuntimeApi } from './runtime';
import { parseHealthz } from './parse';
import { LOCAL_DAEMON_ID, type ExternalRootInput } from './spec';

export interface LocalDaemonHost {
  /** Absolute vault path on disk, or null (mobile / non-filesystem vault). */
  vaultBasePath(): string | null;
  pluginVersion: string;
  /** Keychain access by logical secret name (the host applies `secretStorageKey`). */
  getSecret(name: string): string | undefined;
  setSecret(name: string, value: string): void;
  getLocalDaemonSettings(): LocalDaemonSettings | undefined;
  setLocalDaemonSettings(next: LocalDaemonSettings): void;
  getRemoteDaemons(): RemoteDaemonConfig[];
  setRemoteDaemons(next: RemoteDaemonConfig[]): void;
  saveSettings(): Promise<void>;
  /** The Remote daemons list changed: connection clients must be refreshed. */
  onRegistryChanged(): void;
  /** Geode's connected external roots; absent on Obsidian / older Geode. */
  externalRoots?(): Promise<ExternalRootInput[] | null | undefined>;
  createSocket: WebSocketFactory;
  log?(message: string): void;
}

function httpGetHealth(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let http: typeof import('http');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      http = require('http') as typeof import('http');
    } catch {
      resolve(false);
      return;
    }
    if (!http?.get) { resolve(false); return; }
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve(res.statusCode === 200 && parseHealthz(body).ok));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function isDirectorySync(path: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('fs') as typeof import('fs')).statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when something accepts a TCP connection on host 127.0.0.1:port (500 ms budget). */
function probeHostLoopbackPort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let net: typeof import('net');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      net = require('net') as typeof import('net');
    } catch {
      resolve(false);
      return;
    }
    if (!net?.connect) { resolve(false); return; }
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function createLocalDaemonController(host: LocalDaemonHost): LocalDaemonController {
  const deps: LocalDaemonDeps = {
    vaultPath: () => host.vaultBasePath(),
    pluginVersion: host.pluginVersion,
    isDirectory: isDirectorySync,
    runtime: createDefaultRuntimeApi(),
    createRunner: () => createDefaultVmCommandRunner(),
    healthz: (port) => httpGetHealth(port, 1500),
    probeDaemon: (url, token) => probeDaemon({
      url: daemonWsUrl(url),
      token,
      createSocket: host.createSocket,
      clientVersion: host.pluginVersion,
    }),
    portFree: async (port) => !(await probeHostLoopbackPort(port)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    secrets: { get: (n) => host.getSecret(n), set: (n, v) => host.setSecret(n, v) },
    loadSettings: () => host.getLocalDaemonSettings(),
    saveSettings: async (next) => {
      host.setLocalDaemonSettings(next);
      await host.saveSettings();
    },
    getRegistered: () => host.getRemoteDaemons().find((d) => d.id === LOCAL_DAEMON_ID),
    register: async (config) => {
      const list = host.getRemoteDaemons();
      const i = list.findIndex((d) => d.id === config.id);
      host.setRemoteDaemons(i >= 0 ? list.map((d, j) => (j === i ? config : d)) : [...list, config]);
      await host.saveSettings();
      host.onRegistryChanged();
    },
    unregister: async () => {
      host.setRemoteDaemons(host.getRemoteDaemons().filter((d) => d.id !== LOCAL_DAEMON_ID));
      await host.saveSettings();
      host.onRegistryChanged();
    },
    signInRunner: (opts) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawn } = require('child_process') as typeof import('child_process');
      return signInToClaudeInContainer({
        spawn: spawn as unknown as SpawnLike,
        hostEnv: runnerEnv() as NodeJS.ProcessEnv,
        containerName: opts.containerName,
        containerBinaryPath: opts.containerBinaryPath,
        onProgress: opts.onProgress,
        onUrl: opts.onUrl,
        onCodePrompt: opts.onCodePrompt,
      });
    },
    ...(host.externalRoots ? { externalRoots: () => host.externalRoots!() } : {}),
    log: host.log,
  };
  return new LocalDaemonController(deps);
}

/** Delivers the Geode GitHub connection to the managed daemon (see githubDelivery.ts). Geode-only, like the rest of this file. */
export function createLocalDaemonGithubDelivery(
  host: Pick<LocalDaemonGithubDeps, 'broker' | 'isEnabled' | 'getEmailOverride' | 'log'> & { vaultBasePath(): string | null },
): LocalDaemonGithubDelivery {
  return new LocalDaemonGithubDelivery({
    broker: host.broker,
    isEnabled: host.isEnabled,
    vaultPath: () => host.vaultBasePath(),
    runner: () => createDefaultVmCommandRunner(),
    ...(host.getEmailOverride ? { getEmailOverride: host.getEmailOverride } : {}),
    ...(host.log ? { log: host.log } : {}),
  });
}

/** Prepares the managed daemon for a session: environment, skills, AWS (see sessionPrep.ts). Geode-only, like the rest of this file. */
export function createLocalDaemonSessionPrep(
  host: Pick<SessionPrepDeps, 'resolveEnv' | 'skillPlugins' | 'awsProfiles' | 'hostAwsConfigPath' | 'log'> & { vaultBasePath(): string | null },
): LocalDaemonSessionPrep {
  return new LocalDaemonSessionPrep({
    vaultPath: () => host.vaultBasePath(),
    runner: () => createDefaultVmCommandRunner(),
    resolveEnv: host.resolveEnv,
    skillPlugins: host.skillPlugins,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    homeDir: () => (require('os') as typeof import('os')).homedir(),
    awsProfiles: host.awsProfiles,
    ...(host.hostAwsConfigPath ? { hostAwsConfigPath: host.hostAwsConfigPath } : {}),
    fs: nodeFs(),
    awsFs: nodeAwsCopyFs(),
    ...(host.log ? { log: host.log } : {}),
  });
}
