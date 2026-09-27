import { CodexSession } from './CodexSession';
import { OpenCodeSession } from './OpenCodeSession';
import { ThreadSession } from './ThreadSession';
import type { HarnessSession } from './HarnessSession';
import type { PluginSettings, Thread } from './types';

/** Central harness selection point. ThreadManager never constructs adapters directly. */
export function createHarnessSession(thread: Thread, settings: PluginSettings): HarnessSession {
  switch (thread.agentHarness) {
    case 'codex':
      return new CodexSession(settings.codexBinaryPath);
    case 'opencode':
      return new OpenCodeSession(settings.opencodeBinaryPath || 'opencode');
    default:
      return new ThreadSession(settings.claudeBinaryPath);
  }
}
