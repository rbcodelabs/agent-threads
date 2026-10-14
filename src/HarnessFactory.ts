import { CodexSession } from './CodexSession';
import { OpenCodeSession } from './OpenCodeSession';
import { ThreadSession } from './ThreadSession';
import type { HarnessSession } from './HarnessSession';
import { RemoteHarnessSession } from './remote/RemoteHarnessSession';
import type { RemoteDaemonResolver } from './remote/DaemonRegistry';
import type { PluginSettings, Thread } from './types';

/** Central harness selection point. ThreadManager never constructs adapters directly. */
export function createHarnessSession(
  thread: Thread,
  settings: PluginSettings,
  remoteDaemons?: RemoteDaemonResolver,
): HarnessSession {
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
    return new RemoteHarnessSession(client, thread);
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
