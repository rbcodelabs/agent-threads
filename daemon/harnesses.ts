/**
 * The agent harnesses the daemon can host (claude, codex, opencode): which ones an operator enabled, where each
 * one's CLI lives, which credential it will use, and what each supports (advertised in `welcome.capabilities`).
 *
 * The scripted `fake` harness is not listed here: it is a test stand-in chosen with `config.harness`, never
 * something a client can request.
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const REAL_HARNESSES = ['claude', 'codex', 'opencode'] as const;
export type RealHarness = (typeof REAL_HARNESSES)[number];

export const isRealHarness = (v: unknown): v is RealHarness => typeof v === 'string' && (REAL_HARNESSES as readonly string[]).includes(v);

/** Executable name, the env var that names it explicitly, and the config.json key / flag it is also settable by. */
export const HARNESS_BINARY: Record<RealHarness, { exe: string; envVar: string; flag: string; configKey: string; installHint: string }> = {
  claude: { exe: 'claude', envVar: 'AGENT_THREADS_CLAUDE_BINARY', flag: '--claude-binary', configKey: 'claudeBinaryPath', installHint: 'install Claude Code for the daemon user' },
  codex: { exe: 'codex', envVar: 'AGENT_THREADS_CODEX_BINARY', flag: '--codex-binary', configKey: 'codexBinaryPath', installHint: 'install Codex for the daemon user (npm i -g @openai/codex)' },
  opencode: { exe: 'opencode', envVar: 'AGENT_THREADS_OPENCODE_BINARY', flag: '--opencode-binary', configKey: 'opencodeBinaryPath', installHint: 'install OpenCode for the daemon user (npm i -g opencode-ai)' },
};

/** Where an operator's CLI usually lives, after PATH. */
function candidateBinaries(exe: string, env: NodeJS.ProcessEnv, home: string): string[] {
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, exe));
  return [
    ...onPath,
    join(home, '.npm-global/bin', exe),
    join(home, '.local/bin', exe),
    ...(exe === 'claude' ? [join(home, '.claude/local/claude')] : []),
    ...(exe === 'opencode' ? [join(home, '.opencode/bin/opencode')] : []),
    `/usr/local/bin/${exe}`,
    `/usr/bin/${exe}`,
  ];
}

/** The CLI for a harness: the explicit path if given (and executable), else PATH and the usual install dirs. */
export function findHarnessBinary(harness: RealHarness, explicit?: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const executable = (p: string): boolean => {
    try { accessSync(p, constants.X_OK); return true; } catch { return false; }
  };
  if (explicit) return executable(explicit) ? explicit : null;
  return candidateBinaries(HARNESS_BINARY[harness].exe, env, home).find(executable) ?? null;
}

export function missingBinaryMessage(harness: RealHarness): string {
  const b = HARNESS_BINARY[harness];
  return `${b.exe} CLI not found: ${b.installHint} or set ${b.configKey} / ${b.envVar}`;
}

const readable = (p: string): boolean => {
  try { accessSync(p, constants.R_OK); return true; } catch { return false; }
};

/**
 * Which credential a Codex / OpenCode process will use, for the startup log (never the value). Like Claude they
 * inherit the daemon's environment and HOME, so a login made once as the daemon user is reused.
 */
export function describeHarnessCredential(harness: Exclude<RealHarness, 'claude'>, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (harness === 'codex') {
    if (env.CODEX_API_KEY) return 'CODEX_API_KEY (environment)';
    if (env.OPENAI_API_KEY) return 'OPENAI_API_KEY (environment)';
    const codexHome = env.CODEX_HOME || join(env.HOME || home, '.codex');
    return readable(join(codexHome, 'auth.json')) ? `existing Codex login (${codexHome})` : 'none found: run `codex login` once as the daemon user, or set CODEX_API_KEY / OPENAI_API_KEY';
  }
  const providerKeys = HARNESS_SECRET_ENV.filter((k) => k !== 'CODEX_API_KEY' && env[k]);
  if (providerKeys.length) return `${providerKeys.join(', ')} (environment)`;
  const data = env.XDG_DATA_HOME || join(env.HOME || home, '.local/share');
  return readable(join(data, 'opencode', 'auth.json')) ? `existing OpenCode login (${join(data, 'opencode')})` : 'none found: run `opencode auth login` once as the daemon user, or set a provider API key in the environment';
}

/** Secret environment variables of the non-Claude harnesses (provider keys), for log redaction and credential lookup. */
export const HARNESS_SECRET_ENV = ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY'] as const;

/** Systemd `LoadCredential=` form of the Claude token (`$CREDENTIALS_DIRECTORY/claude-token`). */
export function readClaudeCredentialFile(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try { return readFileSync(join(dir, 'claude-token'), 'utf8').trim() || undefined; } catch { return undefined; }
}

/**
 * What each harness supports on a daemon session, checked against its adapter (`src/CodexSession.ts`,
 * `src/OpenCodeSession.ts`, `src/ThreadSession.ts`). No local harness implements the optional child-agent controls
 * (`sendAgentMessage` / `interruptAgent`), so there is no `child_agents` feature. Advertised as `harness.<kind>.<feature>`:
 *   set_model, set_permission_mode  live switching (`session.setModel` / `session.setPermissionMode`)
 *   usage, context_usage            usage snapshot and context-window breakdown
 *   mcp_status                      per-MCP-server connection state is reported
 *   host_tools                      the daemon's `claude_threads` worktree tools and the client's proxied host tools
 *                                   (Claude: in-process MCP servers that follow the live manifest; Codex and
 *                                   OpenCode: dynamic tools fixed when the session starts)
 *   session_options                 `spec.sessionOptions` (thinking, agents, betas, ...) is honoured in full; Codex
 *                                   takes only `effort`, OpenCode none
 */
export const HARNESS_FEATURES: Record<RealHarness, readonly string[]> = {
  claude: ['set_model', 'set_permission_mode', 'usage', 'context_usage', 'mcp_status', 'host_tools', 'session_options'],
  codex: ['set_model', 'set_permission_mode', 'usage', 'context_usage', 'host_tools'],
  opencode: ['set_model', 'set_permission_mode', 'usage', 'context_usage', 'host_tools'],
};

export function harnessCapabilities(harnesses: readonly RealHarness[]): string[] {
  return harnesses.flatMap((h) => [`harness.${h}`, ...HARNESS_FEATURES[h].map((f) => `harness.${h}.${f}`)]);
}
