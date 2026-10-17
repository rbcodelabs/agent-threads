/**
 * Local daemon: builds the real controller from a small host interface.
 * Geode-only wiring (the only file here that touches Node I/O directly); every
 * Node built-in is required inside a function so the plugin bundle still loads
 * on mobile, where this is never called.
 */

import type { LocalDaemonSettings, RemoteDaemonConfig } from '../types';
import { daemonWsUrl, probeDaemon, type WebSocketFactory } from '../remote/DaemonClient';
import { signInToClaudeInContainer, type SpawnLike } from '../claudeContainerAuthCli';
import { runnerEnv, createDefaultVmCommandRunner } from '../sandboxVm';
import { probeHostLoopbackPort } from '../vmPortForward';
import { LocalDaemonController, type LocalDaemonDeps } from './controller';
import { createDefaultRuntimeApi } from './runtime';
import { parseHealthz } from './parse';
import { LOCAL_DAEMON_ID } from './spec';

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
    log: host.log,
  };
  return new LocalDaemonController(deps);
}
