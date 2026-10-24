/**
 * hostExecPrefix.ts — scoped "Always allow" for `host_exec`.
 *
 * The user may always-allow a command PREFIX (a program, or program + leading
 * subcommand such as `npm test`). Later `host_exec` calls whose tokenized argv
 * starts with that prefix run without a card.
 *
 * Because the command is executed by `/bin/sh -c`, the only safe way to reason
 * about "what will run" is to accept a deliberately tiny grammar and refuse
 * everything else: tokens separated by spaces/tabs, each made only of
 * {@link SAFE_TOKEN}. Anything the shell could interpret (quotes, escapes,
 * globs, expansions, redirects, chaining, newlines, comments, env-assignment
 * prefixes, path-qualified programs) fails tokenization, so it is never
 * auto-approved and never offered "Always allow"; the card is shown as today.
 */
import { isHostExecPermission } from './toolNameUtils';

/** Characters with no special meaning to /bin/sh when unquoted mid-word. */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,.\-/]+$/;

/** Exact program names (lowercase basename) that must never be always-allowed. */
const DENIED_PROGRAMS: ReadonlySet<string> = new Set([
  // shells and shell builtins that run strings
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash', 'busybox',
  'eval', 'exec', 'source', '.', 'command', 'builtin', 'trap',
  // privilege / wrappers that run other commands
  'sudo', 'doas', 'su', 'env', 'xargs', 'nohup', 'nice', 'time', 'timeout', 'watch', 'setsid',
  'script', 'screen', 'tmux', 'at', 'crontab', 'launchctl',
  // network and remote access
  'ssh', 'scp', 'sftp', 'rsync', 'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'socat',
  // destructive / low-level
  'rm', 'rmdir', 'dd', 'mkfs', 'shred', 'truncate', 'diskutil', 'mount', 'umount',
  'mv', 'cp', 'ln', 'chmod', 'chown', 'chgrp', 'tee', 'install',
  'kill', 'killall', 'pkill', 'reboot', 'shutdown', 'halt',
  // arbitrary-code runners
  'npx', 'pnpx', 'bunx', 'osascript', 'pwsh', 'powershell', 'cmd', 'awk', 'gawk', 'sed', 'find',
  'docker', 'podman', 'kubectl', 'defaults', 'security',
]);

/** Interpreters with optional version suffix (python3.11, node20). */
const DENIED_INTERPRETER = /^(python|pypy|node|nodejs|deno|bun|perl|ruby|php|lua|tclsh|wish|irb|java)[\d.]*$/;

/** Tools whose first argument is a subcommand worth scoping to. */
const MULTI_COMMAND_PROGRAMS: ReadonlySet<string> = new Set(['npm', 'git', 'pnpm', 'yarn', 'cargo']);

/**
 * Subcommands that execute arbitrary user-supplied code or rewrite config, so a
 * `<tool> <sub>` prefix would be as broad as the shell. No offer is made.
 */
const UNSCOPABLE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'exec', 'x', 'dlx', 'create', 'init', 'config', 'alias', 'link', 'install-test', 'rebuild',
  'publish', 'login', 'logout', 'adduser', 'token', 'credential', 'daemon', 'submodule', 'filter-branch',
  'rm', 'remove', 'clean', 'push', 'reset', 'checkout', 'switch', 'restore', 'rebase', 'revert',
]);

/** Subcommands that take a script name; the prefix then includes it (`npm run build`). */
const SCRIPT_SUBCOMMANDS: ReadonlySet<string> = new Set(['run', 'run-script']);

/**
 * Splits `command` into argv tokens, or returns null when the command uses any
 * syntax outside the tiny safe grammar (see module header).
 */
export function tokenizeSimpleCommand(command: string): string[] | null {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (trimmed === '') return null;
  const tokens = trimmed.split(/[ \t]+/);
  if (!tokens.every((t) => SAFE_TOKEN.test(t))) return null;
  // `FOO=bar cmd` sets env for the child: not a plain argv, never accepted.
  if (tokens[0].includes('=')) return null;
  // Path-qualified programs (`./x`, `/bin/sh`) are cwd-dependent or sidestep the denylist.
  if (tokens[0].includes('/')) return null;
  // Leading `-` or `.` as a program name is never a real tool.
  if (tokens[0].startsWith('-') || tokens[0] === '.') return null;
  return tokens;
}

/** True when the program (first token) may never be always-allowed. */
export function isDeniedHostExecProgram(program: string): boolean {
  const name = program.toLowerCase();
  return DENIED_PROGRAMS.has(name) || DENIED_INTERPRETER.test(name);
}

/**
 * The prefix offered on the card for `command`, as a space-joined string, or
 * null when no Always allow may be offered (complex syntax, denied program, or
 * a multi-command tool without a plain, scopable subcommand).
 */
export function deriveHostExecPrefix(command: string): string | null {
  const tokens = tokenizeSimpleCommand(command);
  if (!tokens) return null;
  const program = tokens[0];
  if (isDeniedHostExecProgram(program)) return null;
  if (!MULTI_COMMAND_PROGRAMS.has(program.toLowerCase())) return program;

  const sub = tokens[1];
  if (!sub || sub.startsWith('-') || sub.includes('=')) return null;
  if (UNSCOPABLE_SUBCOMMANDS.has(sub.toLowerCase())) return null;
  if (SCRIPT_SUBCOMMANDS.has(sub.toLowerCase())) {
    const script = tokens[2];
    if (!script || script.startsWith('-') || script.includes('=')) return null;
    return `${program} ${sub} ${script}`;
  }
  return `${program} ${sub}`;
}

/** A stored prefix is only honoured if it would still be offered today. */
function isUsablePrefix(prefix: string): string[] | null {
  if (typeof prefix !== 'string') return null;
  const tokens = tokenizeSimpleCommand(prefix);
  if (!tokens || isDeniedHostExecProgram(tokens[0])) return null;
  return tokens;
}

/**
 * True when `command` is a plain argv whose leading tokens equal one of the
 * stored prefixes. Token-wise, never a substring match: prefix `git` matches
 * `git status` but not `gitk` or `git-lfs`, and `npm test` does not match
 * `npm testing`.
 */
export function matchesHostExecPrefix(command: string, prefixes: readonly string[]): boolean {
  const tokens = tokenizeSimpleCommand(command);
  if (!tokens || isDeniedHostExecProgram(tokens[0])) return false;
  for (const stored of prefixes) {
    const want = isUsablePrefix(stored);
    if (!want || want.length > tokens.length) continue;
    if (want.every((t, i) => t === tokens[i])) return true;
  }
  return false;
}

/**
 * The card detail the host tool executor builds (`Run <tool> for a remote thread: <input JSON>`). The input is
 * the model's own, so only the part after the first `{` is parsed, and a truncated detail (never run) yields null.
 */
export function hostExecAlwaysAllowPrefixFromDetail(detail: string): string | null {
  const start = detail.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(detail.slice(start)) as { command?: unknown };
    return typeof parsed.command === 'string' ? deriveHostExecPrefix(parsed.command) : null;
  } catch {
    return null;
  }
}

/**
 * Prefix to offer as "Always allow" on a pending permission card, or null. Only host_exec cards: the tool exists
 * only for the managed local daemon, whose threads are `remote` threads, so no thread-kind check is made here;
 * the standing approval itself is applied (and re-checked) only where that daemon's tool group is built (main.ts).
 */
export function hostExecAlwaysAllowOffer(
  pending: { toolName: string; detail: string } | null | undefined,
  /** Managed policy `hostExec.allowAlways`: false removes the option (the per-call prompt stays). */
  allowAlways = true,
): string | null {
  if (!allowAlways || !pending || !isHostExecPermission(pending.toolName)) return null;
  return hostExecAlwaysAllowPrefixFromDetail(pending.detail);
}

/** Adds `prefix` (once) to the settings list. Returns true when it was added. */
export function addHostExecPrefix(settings: { hostExecAlwaysAllowedPrefixes: string[] }, prefix: string): boolean {
  if (!isUsablePrefix(prefix)) return false;
  if (!Array.isArray(settings.hostExecAlwaysAllowedPrefixes)) settings.hostExecAlwaysAllowedPrefixes = [];
  if (settings.hostExecAlwaysAllowedPrefixes.includes(prefix)) return false;
  settings.hostExecAlwaysAllowedPrefixes.push(prefix);
  return true;
}
