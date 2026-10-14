import * as fs from 'fs';
import * as path from 'path';
import { CodexSession } from './CodexSession';
import { OpenCodeSession } from './OpenCodeSession';
import { ReplaySession, parseReplayScript, type ReplayScript } from './ReplaySession';
import { ThreadSession } from './ThreadSession';
import type { HarnessSession } from './HarnessSession';
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
  env: Record<string, string | undefined> = process.env,
): HarnessSession {
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
