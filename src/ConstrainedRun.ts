import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { effectiveExtraEnv, parseExtraEnv, type PluginSettings } from './types';
import type { ConstrainedQueryInput, ConstrainedQueryOutput } from './PublicApi';
import { classifyClaudeAuthFailure, formatSignInExpiredMessage, shouldAutoRetryAuthError } from './claudeAuthRecovery';

type QueryFunction = typeof query;

class ClaudeAuthFailure extends Error {}

/**
 * Input-only Claude execution used by peer plugins for evaluation. The option
 * set is deliberately closed: callers cannot add tools, settings, plugins,
 * MCP servers, filesystem roots, or resumable session state.
 */
export function createConstrainedQueryRunner(
  getSettings: () => Pick<PluginSettings, 'claudeBinaryPath' | 'extraEnv' | 'provider'>,
  runQuery: QueryFunction = query,
  getAuthentication: () => Record<string, string> = () => ({}),
): (input: ConstrainedQueryInput) => Promise<ConstrainedQueryOutput> {
  return async ({ prompt, options, signal }) => {
    // Desktop-only execution path. Keep Node built-ins out of module init so
    // importing the plugin bundle remains safe on Obsidian Mobile.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const settings = getSettings();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-threads-constrained-'));
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(Math.max(options.timeoutMs, 1), 600_000));
    // Each attempt spawns a fresh CLI process. An expired/raced OAuth token
    // (claudeAuthRecovery.ts) gets exactly one retry — the new process
    // re-reads the keychain — then fails with a clear, actionable message.
    // Unattended: there is no one to click a sign-in button here.
    const attempt = async (): Promise<Extract<SDKMessage, { type: 'result' }> | undefined> => {
      let result: Extract<SDKMessage, { type: 'result' }> | undefined;
      let authFailure: string | null = null;
      try {
        for await (const message of runQuery({
          prompt,
          options: {
            abortController,
            pathToClaudeCodeExecutable: settings.claudeBinaryPath,
            env: constrainedEnvironment(cwd, { ...parseExtraEnv(effectiveExtraEnv(settings)), ...getAuthentication() }),
            cwd,
            model: options.model,
            systemPrompt: options.systemInstructions,
            tools: [],
            allowedTools: [],
            mcpServers: {},
            strictMcpConfig: true,
            settingSources: [],
            skills: [],
            plugins: [],
            persistSession: false,
            permissionMode: 'dontAsk',
            canUseTool: async () => ({ behavior: 'deny', message: 'Tools are disabled for constrained runs.' }),
            maxTurns: 1,
            maxBudgetUsd: options.maxBudgetUsd,
            enableFileCheckpointing: false,
          },
        })) {
          if (message.type === 'assistant' && message.message.content.some(block => block.type === 'tool_use')) throw new Error('Constraint violation: tool use emitted.');
          authFailure ??= classifyClaudeAuthFailure(message);
          if (message.type === 'result') result = message;
        }
      } catch (err) {
        const thrownAuthFailure = abortController.signal.aborted ? null : classifyClaudeAuthFailure(err);
        if (!thrownAuthFailure) throw err;
        authFailure = thrownAuthFailure;
      }
      if (authFailure && (!result || result.is_error)) throw new ClaudeAuthFailure(authFailure);
      return result;
    };

    try {
      let result: Extract<SDKMessage, { type: 'result' }> | undefined;
      for (let retries = 0; ; retries++) {
        try {
          result = await attempt();
          break;
        } catch (err) {
          if (!(err instanceof ClaudeAuthFailure)) throw err;
          if (!shouldAutoRetryAuthError(retries) || abortController.signal.aborted) {
            throw new Error(formatSignInExpiredMessage(err.message));
          }
        }
      }
      if (!result || result.subtype !== 'success' || result.is_error) throw new Error('Constrained run failed.');
      if (result.result.length > 100_000) throw new Error('Constrained run output exceeds the 100000 character limit.');
      return {
        output: result.result,
        usage: {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          costUsd: result.total_cost_usd,
          durationMs: result.duration_ms,
          turns: result.num_turns,
        },
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  };
}

const AUTH_ENV = /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION|DEFAULT_REGION|PROFILE|ROLE_ARN|WEB_IDENTITY_TOKEN_FILE)|GOOGLE_APPLICATION_CREDENTIALS)$/;
function constrainedEnvironment(cwd: string, configured: Record<string, string>): Record<string, string> {
  const source = { ...process.env, ...configured };
  const env: Record<string, string> = {
    HOME: cwd,
    TMPDIR: cwd,
    CLAUDE_CONFIG_DIR: cwd,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-threads/constrained-runs',
  };
  if (source.PATH) env.PATH = source.PATH;
  for (const [name, value] of Object.entries(source)) if (typeof value === 'string' && AUTH_ENV.test(name)) env[name] = value;
  return env;
}
