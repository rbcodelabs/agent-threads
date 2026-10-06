/**
 * Shared utility functions for the Agent Dashboard and Kanban Board views.
 */

import { resolveProjectName } from './pathUtils';

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Formats the remaining time until a scheduled wake-up fires as a short,
 * human phrase: "now", "in 45s", "in 4m", "in 1h 5m". Used by both the Agent
 * Dashboard waiting rows and the chat-view scheduled-activity pill.
 */
export function formatWakeupCountdown(fireAt: number, now = Date.now()): string {
  const remaining = fireAt - now;
  if (remaining <= 0) return 'now';
  const totalSeconds = Math.round(remaining / 1000);
  if (totalSeconds < 60) return `in ${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
}

export function shortenPath(p: string, vaultRoot?: string): string {
  if (vaultRoot && p.startsWith(vaultRoot)) {
    const rel = p.slice(vaultRoot.length).replace(/^\//, '');
    return rel || '/';
  }
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
  const parts = p.split('/');
  return parts.length > 4 ? '…/' + parts.slice(-2).join('/') : p;
}

/**
 * Builds a human-readable label for a working-directory path, shared across the
 * conversation view, Agent Dashboard, and Kanban board.
 *
 * When the path is inside a git repo the label is "project · branch" (or just
 * "project" when the branch name matches the repo name). Otherwise it falls back
 * to the shortened filesystem path from `shortenPath`.
 */
export function buildCwdLabel(cwd: string, vaultRoot?: string): string {
  if (!cwd) return '';
  const projectName = resolveProjectName(cwd);
  if (projectName) {
    const lastSegment = cwd.replace(/\/$/, '').split('/').pop() ?? '';
    return (lastSegment && lastSegment !== projectName)
      ? `${projectName} · ${lastSegment}`
      : projectName;
  }
  return shortenPath(cwd, vaultRoot);
}

/** Compact project + directory label used by the desktop composer context pill. */
export function buildComposerContextLabel(projectName: string | undefined, cwd: string): string {
  const basename = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  if (!projectName) return basename;
  if (!basename || projectName.trim().toLocaleLowerCase() === basename.toLocaleLowerCase()) {
    return projectName;
  }
  return `${projectName} · ${basename}`;
}

/**
 * Returns true when the error message looks like an AWS SSO token expiry that
 * requires running `aws sso login` to refresh credentials.
 */
export function isAwsSsoError(err?: string): boolean {
  if (!err) return false;
  return /token.*expir|expir.*token|aws sso login|sso.*session.*expir|Error loading SSO/i.test(err);
}

/**
 * Splits an error message into a one-line headline and an optional stack
 * trace, so the UI can show a clean, short error card with the noisy
 * technical detail tucked behind a disclosure instead of dumping the whole
 * thing into a `<pre>` block. Errors constructed with a trailing
 * `\n\nStack: ...` suffix (see ClaudeSession.ts) are split there; anything
 * else is returned as-is with no stack.
 */
export function splitErrorMessage(message: string): { headline: string; stack?: string } {
  const idx = message.indexOf('\n\nStack:');
  if (idx === -1) return { headline: message };
  return { headline: message.slice(0, idx), stack: message.slice(idx + 2) }; // keep "Stack: ..." in the details
}

/**
 * Extracts the AWS_PROFILE value from a KEY=VALUE extra-env block, if present.
 */
export function extractAwsProfile(extraEnv: string): string | null {
  const match = extraEnv.match(/(?:^|\n)AWS_PROFILE=([^\s]+)/);
  return match ? match[1] : null;
}

/**
 * Returns an env object suitable for `child_process.exec` that prepends the
 * common Homebrew / user-local bin directories to PATH, so subprocesses can
 * find tools like `aws`, `gh`, `jq`, and `git` despite Obsidian's minimal PATH.
 * Shared by the AWS SSO reauth button and the status-line service.
 */
export function execEnv(): NodeJS.ProcessEnv {
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin'];
  const home = process.env.HOME;
  if (home) extraPath.push(`${home}/.local/bin`);
  const currentPath = process.env.PATH ?? '';
  return {
    ...process.env,
    ...(home ? { HOME: home } : {}),
    PATH: `${extraPath.join(':')}:${currentPath}`,
  };
}

/** @deprecated Alias for {@link execEnv}; kept for existing AWS call sites. */
export function awsExecEnv(): NodeJS.ProcessEnv {
  return execEnv();
}
