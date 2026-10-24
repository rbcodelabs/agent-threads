import * as fs from 'fs';
import * as path from 'path';
import { CodexSession } from './CodexSession';
import { OpenCodeSession } from './OpenCodeSession';
import { ReplaySession, parseReplayScript, type ReplayScript } from './ReplaySession';
import { ThreadSession } from './ThreadSession';
import type { HarnessSession } from './HarnessSession';
import { RemoteHarnessSession, type RemoteSessionDeps } from './remote/RemoteHarnessSession';
import type { RemoteDaemonResolver } from './remote/DaemonRegistry';
import { assertLaunchAllowed, policyTargetOfThread, type LaunchPolicy } from './managedPolicy';
import type { PluginSettings, Thread } from './types';

/**
 * Host-process variable that switches Claude threads to a scripted replay
 * (see ReplaySession). Used only to record product demos: unset, the factory
 * behaves exactly as if this feature did not exist.
 */
export const DEMO_SCRIPT_ENV = 'CLAUDE_THREADS_DEMO_SCRIPT';

const scriptCache = new Map<string, { mtimeMs: number; script: ReplayScript }>();

function loadDemoScript(file: string): ReplayScript {
  const resolved = path.resolve(file);
  const mtimeMs = fs.statSync(resolved).mtimeMs;
  const cached = scriptCache.get(resolved);
  if (cached?.mtimeMs === mtimeMs) return cached.script;
  const script = parseReplayScript(JSON.parse(fs.readFileSync(resolved, 'utf8')));
  scriptCache.set(resolved, { mtimeMs, script });
  return script;
}

/** Central harness selection point. ThreadManager never constructs adapters directly. */
export function createHarnessSession(
  thread: Thread,
  settings: PluginSettings,
  remoteDaemons?: RemoteDaemonResolver,
  remoteHooks?: Pick<RemoteSessionDeps, 'onPendingChanged' | 'log' | 'runAtTime' | 'hostTools' | 'hostToolSlots' | 'onNotice' | 'onCwdChanged' | 'hostName' | 'daemonName'>,
  env: Record<string, string | undefined> = process.env,
  launchPolicy?: LaunchPolicy,
): HarnessSession {
  // Last-resort synchronous guard: whatever the callers did, a refused (target, harness) pair never reaches a spawn,
  // a socket or a daemon.
  if (launchPolicy) assertLaunchAllowed(launchPolicy.policy, policyTargetOfThread(thread, remoteDaemons), thread.agentHarness ?? 'claude');
  // A remote thread runs on a daemon whatever its harness says.
  if (thread.remote) {
    const client = remoteDaemons?.clientFor(thread.remote.daemonId);
    if (!client) {
      throw new Error(
        remoteDaemons
          ? `The remote daemon "${remoteDaemons.nameOf(thread.remote.daemonId)}" is not configured. Add it under Settings, Remote daemons.`
          : 'Remote threads are not available on this host.',
      );
    }
    return new RemoteHarnessSession(client, thread, remoteHooks);
  }
  const demoScript = env[DEMO_SCRIPT_ENV];
  if (demoScript && (thread.agentHarness ?? 'claude') === 'claude') {
    return new ReplaySession(loadDemoScript(demoScript));
  }
  switch (thread.agentHarness) {
    case 'codex':
      return new CodexSession(settings.codexBinaryPath);
    case 'opencode':
      return new OpenCodeSession(settings.opencodeBinaryPath || 'opencode');
    default:
      return new ThreadSession(settings.claudeBinaryPath);
  }
}
