/**
 * Shared definitions for built-in slash commands shown in the DispatchInput
 * autocomplete dropdown. Single source of truth — ThreadsView, AgentDashboard,
 * and KanbanView all import from here so the lists can't drift apart.
 */

import { parseLoopArgs } from './loopUtils';
import type { PluginSettings } from './types';

export interface SlashCommand {
  name: string;
  description: string;
}

/** Commands available inside an open thread (ThreadsView intercepts all of these). */
export const THREAD_BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize conversation history to free up context' },
  { name: 'clear', description: 'Clear conversation history and start fresh' },
  { name: 'cost', description: 'Show token usage and cost for this session' },
  { name: 'model', description: 'Set persistent model: /model fable|opus|sonnet|haiku|default' },
  { name: 'goal', description: 'Set a persistent goal for this thread: /goal <text> · /goal clear' },
  { name: 'loop', description: 'Re-run a prompt on an interval: /loop 5m <prompt> · /loop stop' },
  { name: 'ephemeral', description: 'Mark this thread as ephemeral: sessions will not be persisted to disk' },
  { name: 'context', description: 'Show current context window usage breakdown' },
  { name: 'usage', description: 'Show token usage, quota windows, and account activity' },
  { name: 'create-pr', description: 'Send the configured Create PR message (add --draft for the draft message)' },
];

/**
 * Commands advertised in the dashboard/kanban dispatch boxes, which create a
 * new thread from the typed text. Allowlist with dispatch-specific wording —
 * /compact, /clear, and /cost are thread-scoped and meaningless before a
 * session exists; the variants of /goal and /loop that manage existing state
 * (clear/stop) only work inside a thread.
 */
export const DISPATCH_BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'model', description: 'Dispatch on a specific model: /model fable|opus|sonnet|haiku <prompt>' },
  { name: 'goal', description: 'Dispatch a thread with a persistent goal: /goal <text>' },
  { name: 'loop', description: 'Dispatch a thread that re-runs a prompt: /loop 10m <prompt>' },
];

/**
 * Builds the /escalate (or renamed keyword) popup entry from live settings.
 * Returns null when escalation is disabled, the keyword is empty, or the
 * keyword doesn't start with "/" (a non-slash keyword can't be a slash
 * command). Shared by ThreadsView and the dispatch boxes so the wording
 * differs only slightly by context.
 */
export function escalationCommand(
  settings: { escalationEnabled: boolean; escalationKeyword: string; escalationModel: string },
  dispatch = false,
): SlashCommand | null {
  if (!settings.escalationEnabled) return null;
  const keyword = (settings.escalationKeyword ?? '').trim();
  if (!keyword.startsWith('/') || keyword.length < 2) return null;
  const model = settings.escalationModel || 'opus';
  return {
    name: keyword.slice(1),
    description: dispatch
      ? `Dispatch on the escalation model (${model}): ${keyword} <prompt>`
      : `Escalate this turn to ${model}: ${keyword} <prompt>`,
  };
}

/** Argument completions for /model — shown after typing "/model ". */
export const MODEL_ARG_COMPLETIONS: SlashCommand[] = [
  { name: 'fable', description: 'Claude Fable 5 — most capable' },
  { name: 'opus', description: 'Claude Opus' },
  { name: 'sonnet', description: 'Claude Sonnet — speed/quality balance' },
  { name: 'haiku', description: 'Claude Haiku — fastest, cheapest' },
  { name: 'default', description: 'Reset to the Default model setting / CLI default' },
];

/** Argument completions keyed by command name, for DispatchInput.argCompletions. */
export const THREAD_ARG_COMPLETIONS: Record<string, SlashCommand[]> = {
  model: MODEL_ARG_COMPLETIONS,
  goal: [{ name: 'clear', description: 'Clear the goal for this thread' }],
  loop: [{ name: 'stop', description: 'Stop the loops running in this thread' }],
};

export const DISPATCH_ARG_COMPLETIONS: Record<string, SlashCommand[]> = {
  model: MODEL_ARG_COMPLETIONS,
};

/**
 * Maps /model argument aliases to the model id passed to the CLI.
 * `undefined` means "reset to the default model". Shared by ThreadsView
 * (thread-scoped /model) and the dispatch boxes (leading /model prefix).
 */
export const MODEL_ALIASES: Record<string, string | undefined> = {
  fable: 'fable',
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  default: undefined,
  reset: undefined,
};

export interface DispatchModelPrefix {
  /** Resolved model id, or undefined for default/reset. Unset when error is present. */
  model?: string;
  /** Prompt text remaining after the /model command. */
  rest: string;
  /** Set when the command is malformed (missing or unknown model name). */
  error?: string;
}

export const MODEL_USAGE_HINT = 'Usage: /model fable|opus|sonnet|haiku|default <prompt>';

/**
 * Parses a leading "/model <name>" prefix on text typed into a dispatch box.
 * Returns null when the text is not a /model command (dispatch it as-is).
 * Returns { error } when the model name is missing or unknown.
 * Otherwise returns the resolved model and the remaining prompt text —
 * callers decide how to handle an empty prompt (e.g. images may be attached).
 */
export function parseDispatchModelPrefix(text: string): DispatchModelPrefix | null {
  if (!/^\/model(\s|$)/i.test(text.trim())) return null;
  const m = text.trim().match(/^\/model\s+(\S+)\s*([\s\S]*)$/i);
  if (!m) return { rest: '', error: MODEL_USAGE_HINT };
  const arg = m[1].toLowerCase();
  if (!(arg in MODEL_ALIASES)) {
    return { rest: m[2].trim(), error: `Unknown model "${m[1]}". Use: fable, opus, sonnet, haiku, default` };
  }
  return { model: MODEL_ALIASES[arg], rest: m[2].trim() };
}

/**
 * The kickoff message sent when a goal is set — used by ThreadsView (/goal in
 * a thread) and by the dispatch boxes (/goal creating a new thread), so the
 * behavior is identical in both places.
 */
export function goalKickoffMessage(goal: string): string {
  return (
    `Work toward the goal that was just set for this thread: "${goal}". ` +
    'Start now and keep going until it is met or you are blocked on input only I can provide.'
  );
}

/**
 * Resolves the message sent by the "Create PR" / "Create draft PR" bar
 * button (or the matching slash command). Blank settings use the built-in
 * defaults so existing and new installations remain usable.
 */
export function resolveCreatePrMessage(
  settings: Pick<PluginSettings, 'createPrMessage' | 'createDraftPrMessage'>,
  draft: boolean,
): string {
  const configured = draft ? settings.createDraftPrMessage : settings.createPrMessage;
  const fallback = draft ? '/create-pr --draft' : '/create-pr';
  return configured?.trim() || fallback;
}

/** A dispatch-box command directive parsed from typed text. */
export type DispatchDirective =
  | { kind: 'model'; model: string | undefined; rest: string; error?: string }
  | { kind: 'goal'; goal: string; error?: string }
  | { kind: 'loop'; intervalSeconds: number; prompt: string; error?: string }
  | { kind: 'escalate'; error: string };

/**
 * Parses a leading built-in command on text typed into a dispatch box.
 * Returns null for plain prompts (dispatch as-is). When `error` is set the
 * input is a recognized command with bad/missing arguments — show the error
 * and do not create a thread.
 *
 * `escalationKeyword` is optional — when passed, a bare keyword with no
 * prompt text is caught and reported as a usage error (matching /goal's
 * behavior) instead of silently falling through to be dispatched as-is.
 * Anything else involving the keyword (including `<keyword> <prompt>`) is
 * left alone — it returns null here so the caller's existing keyword-based
 * escalation routing (ThreadManager.resolveModel/stripKeyword) handles it.
 */
export function parseDispatchDirective(text: string, escalationKeyword?: string): DispatchDirective | null {
  const model = parseDispatchModelPrefix(text);
  if (model) return { kind: 'model', model: model.model, rest: model.rest, error: model.error };

  const keyword = (escalationKeyword ?? '').trim();
  if (keyword && keyword.startsWith('/')) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bareMatch = new RegExp(`^${escaped}$`, 'i').test(text.trim());
    if (bareMatch) {
      return { kind: 'escalate', error: `Include a prompt — e.g. "${keyword} fix the failing build"` };
    }
  }

  const goalMatch = text.trim().match(/^\/goal(?:\s+([\s\S]+))?$/i);
  if (goalMatch) {
    const goal = (goalMatch[1] ?? '').trim();
    if (!goal) {
      return { kind: 'goal', goal: '', error: 'Include a goal — e.g. "/goal ship the v1 login flow"' };
    }
    if (/^(clear|off|done)$/i.test(goal)) {
      return { kind: 'goal', goal: '', error: `/goal ${goal} works inside a thread — include goal text to dispatch a new goal thread.` };
    }
    return { kind: 'goal', goal };
  }

  const loopMatch = text.trim().match(/^\/loop(?:\s+([\s\S]+))?$/i);
  if (loopMatch) {
    const arg = (loopMatch[1] ?? '').trim();
    if (/^(stop|off|cancel|clear)$/i.test(arg)) {
      return { kind: 'loop', intervalSeconds: 0, prompt: '', error: `/loop ${arg} works inside a thread — there is no loop here yet.` };
    }
    const parsed = parseLoopArgs(arg);
    if (!parsed) {
      return { kind: 'loop', intervalSeconds: 0, prompt: '', error: 'Usage: /loop <interval> <prompt> — interval like 30s, 5m, 1h. Example: /loop 10m check CI status' };
    }
    return { kind: 'loop', intervalSeconds: parsed.intervalSeconds, prompt: parsed.prompt };
  }

  return null;
}
