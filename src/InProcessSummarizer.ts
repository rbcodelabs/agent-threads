import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'os';
import type { ChatMessage } from './types';
import { parseExtraEnv } from './types';
import { buildTranscript } from './summarization';

type ProgressCallback = (status: string) => void;

export interface SummarizeResult {
  title: string;
  summary: string;
}

/** Empty result — the contract for "nothing to update". Callers must not persist it. */
const NO_RESULT: SummarizeResult = { title: '', summary: '' };

/**
 * Sentinel the model is told to emit when the new content warrants no change.
 * Handled in `parseJsonResult` so it can never leak into a thread title.
 */
export const NO_SUMMARY_SENTINEL = 'NO_SUMMARY';

/**
 * Number of `query()` calls made by this module since process start (or since
 * the last reset). Exists purely as instrumentation for the summarizer
 * spawn-storm regression: each call boots a `claude` subprocess, so this
 * counter is a direct proxy for spawn count.
 */
let queryCount = 0;

export function getSummarizerQueryCount(): number {
  return queryCount;
}

export function resetSummarizerQueryCount(): void {
  queryCount = 0;
}

export class InProcessSummarizer {
  /**
   * Managed policy (docs/managed-policy.md): awaited before every `claude` subprocess this class would start. It
   * throws when the administrator forbids running Claude on this computer. Titles and summaries are cosmetic, so a
   * refusal simply leaves them as they were.
   */
  spawnGuard?: () => Promise<void>;

  /**
   * Summarize a thread's messages.
   *
   * When `priorSummary` + `lastSummarizedAt` are supplied the method runs in
   * incremental mode: it filters to only the messages that arrived after
   * `lastSummarizedAt` and asks Claude to integrate them into the existing
   * summary rather than regenerating from scratch. Falls back to a full
   * re-summarize when no prior context is available.
   */
  async summarize(
    messages: ChatMessage[],
    claudeBinaryPath: string,
    modelAlias: string,
    extraEnv: string,
    onProgress?: ProgressCallback,
    priorSummary?: string,
    lastSummarizedAt?: number,
    priorTitle?: string,
  ): Promise<SummarizeResult> {
    // Incremental path: prior summary + known cutoff → only send the delta.
    // `buildTranscript` applies the cutoff itself so empty tool-only messages
    // after the cutoff can't masquerade as new content.
    if (priorSummary && lastSummarizedAt !== undefined) {
      const delta = buildTranscript(messages, {
        maxMessages: 10,
        maxCharsPerMessage: 600,
        maxTotalChars: 2000,
        since: lastSummarizedAt,
      });
      if (delta) {
        return this._summarizeIncremental(
          delta,
          priorSummary,
          claudeBinaryPath,
          modelAlias,
          extraEnv,
          onProgress,
          priorTitle,
        );
      }
      // No new content since last summarization — fall through to full summarize
    }

    // Full summarize: first time, or no usable prior state
    const transcript = buildTranscript(messages, {
      maxMessages: 20,
      maxCharsPerMessage: 600,
      maxTotalChars: 3000,
    });

    // Nothing with real content to summarize. Return empty WITHOUT calling the
    // model — this is both the "Transcript empty" title fix and one fewer spawn.
    if (!transcript) return NO_RESULT;

    const prompt =
      'Below is a conversation transcript inside <transcript> tags. ' +
      priorContextClause(priorTitle, priorSummary) +
      'Output a JSON object with exactly two fields:\n' +
      '- "title": a 3-5 word tab title for the conversation (be specific, e.g. "Fix auth middleware bug")\n' +
      '- "summary": a 2-3 sentence summary covering what is being worked on, key decisions, and current status\n\n' +
      `If the transcript contains nothing worth summarizing, or the existing title and summary already describe it accurately, output exactly ${NO_SUMMARY_SENTINEL} instead of JSON.\n` +
      'Otherwise output ONLY the JSON object, no markdown fences, no other text.\n\n' +
      `<transcript>\n${transcript}\n</transcript>`;

    onProgress?.('Summarizing…');

    return parseJsonResult((await this._runQuery(prompt, claudeBinaryPath, modelAlias, extraEnv)).trim());
  }

  /**
   * Incremental helper: integrates a slice of new messages into an existing
   * summary. Sends only the delta to Claude — cheaper and faster than a full
   * re-summarize on long threads.
   */
  private async _summarizeIncremental(
    delta: string,
    priorSummary: string,
    claudeBinaryPath: string,
    modelAlias: string,
    extraEnv: string,
    onProgress?: ProgressCallback,
    priorTitle?: string,
  ): Promise<SummarizeResult> {
    const titleClause = priorTitle?.trim()
      ? 'Existing title:\n<existing_title>\n' + priorTitle.trim() + '\n</existing_title>\n\n'
      : '';

    const prompt =
      'You are updating an existing conversation summary with new messages.\n\n' +
      titleClause +
      'Existing summary:\n<existing_summary>\n' + priorSummary + '\n</existing_summary>\n\n' +
      'New messages since the last summary:\n<new_messages>\n' + delta + '\n</new_messages>\n\n' +
      'Output a JSON object with exactly two fields:\n' +
      '- "title": a 3-5 word tab title for the conversation (be specific, e.g. "Fix auth middleware bug")\n' +
      '- "summary": a 2-3 sentence summary covering what is being worked on, key decisions, and current status — integrate both the prior context and the new messages\n\n' +
      `If the new messages add nothing that changes the existing title or summary, output exactly ${NO_SUMMARY_SENTINEL} instead of JSON.\n` +
      'Otherwise output ONLY the JSON object, no markdown fences, no other text.';

    onProgress?.('Updating summary…');

    return parseJsonResult((await this._runQuery(prompt, claudeBinaryPath, modelAlias, extraEnv)).trim());
  }

  /**
   * Shared query runner — executes a prompt via the Claude CLI and returns the
   * raw text response. Single funnel for every public method on this class, so
   * the isolation options below cover all summarizer paths.
   *
   * Isolation matters: these are one-shot, one-sentence calls. Without
   * `settingSources: []` the SDK loads `~/.claude/settings.json` (the SDK
   * default is "all sources"), which boots the user's entire MCP server roster
   * as child processes for every title generation.
   */
  private async _runQuery(
    prompt: string,
    claudeBinaryPath: string,
    modelAlias: string,
    extraEnv: string,
  ): Promise<string> {
    await this.spawnGuard?.();
    queryCount++;
    let raw = '';
    for await (const msg of query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: claudeBinaryPath,
        permissionMode: 'default',
        model: modelAlias,
        cwd: os.tmpdir(),
        env: { ...process.env, ...parseExtraEnv(extraEnv) },
        // Don't read ~/.claude/settings.json, .claude/settings.json, or
        // .claude/settings.local.json. Omitting this loads all three.
        settingSources: [],
        // No MCP servers, and ignore any that would come in via other paths
        // (project .mcp.json, plugins, agent frontmatter).
        mcpServers: {},
        strictMcpConfig: true,
        // Disable all built-in tools. NOTE: `allowedTools` is an auto-approve
        // list, not a restriction — `tools: []` is the option that disables.
        tools: [],
        // One-shot. With no tools there is nothing to loop on, but this makes
        // it structurally impossible for a summarizer call to run away.
        maxTurns: 1,
      },
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') raw = block.text;
        }
      }
    }
    return raw;
  }

  async summarizeMessage(
    content: string,
    claudeBinaryPath: string,
    modelAlias: string,
    extraEnv: string,
  ): Promise<string> {
    // Nothing to summarize — skip the spawn rather than asking the model to
    // describe an empty response.
    if (!content.trim()) return '';
    // Trim to 3000 chars so haiku stays cheap
    const trimmed = content.slice(0, 3000);
    const prompt =
      'Summarize the following assistant response in exactly one concise sentence (max 25 words). ' +
      'Focus on what was done or decided. Output ONLY the sentence, no preamble.\n\n' +
      `<response>\n${trimmed}\n</response>`;

    return (await this._runQuery(prompt, claudeBinaryPath, modelAlias, extraEnv)).trim();
  }

  async generateForkPrompt(
    messages: ChatMessage[],
    focus: string,
    claudeBinaryPath: string,
    modelAlias: string,
    extraEnv: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    // Filter out compact markers AND empty tool-only messages, then take the
    // last 30, 800 chars each, max 6000 total. Filtering before slicing matters:
    // slicing first lets a run of empty messages evict all the real content.
    const transcript = buildTranscript(messages, {
      maxMessages: 30,
      maxCharsPerMessage: 800,
      maxTotalChars: 6000,
    });

    const focusClause = focus.trim()
      ? `The user wants the new thread to focus on: "${focus.trim()}"`
      : 'The user wants to continue and extend the work from this conversation in a new clean thread.';

    const prompt =
      'You are helping fork a conversation into a new, self-contained thread.\n\n' +
      'Conversation transcript:\n<transcript>\n' + transcript + '\n</transcript>\n\n' +
      focusClause + '\n\n' +
      'Generate a comprehensive starting message for the new thread. Requirements:\n' +
      '1. Distill the relevant context: what was decided, which files are involved, current state\n' +
      '2. Be written as a direct, actionable request — as if starting fresh\n' +
      '3. Do NOT write "based on our previous conversation" or "as we discussed"\n' +
      '4. Include specific details: file paths, decisions made, code snippets where relevant\n' +
      '5. Be self-contained so the new thread can stand completely alone\n\n' +
      'Output ONLY the starting message. No preamble, no explanation, no markdown fences.';

    onProgress?.('Generating fork prompt…');

    return (await this._runQuery(prompt, claudeBinaryPath, modelAlias, extraEnv)).trim();
  }

  unload(): void {}
}

/**
 * Prompt fragment carrying the thread's current title/summary into the full
 * summarize path, which previously ignored `priorSummary` entirely.
 */
function priorContextClause(priorTitle?: string, priorSummary?: string): string {
  const title = priorTitle?.trim();
  const summary = priorSummary?.trim();
  if (!title && !summary) return '';
  let clause = '\n\nFor context, this conversation currently has:\n';
  if (title) clause += `- title: ${title}\n`;
  if (summary) clause += `- summary: ${summary}\n`;
  return clause + '\nUse it as background; the transcript is authoritative.\n\n';
}

export function parseJsonResult(text: string): SummarizeResult {
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  // Explicit "nothing to change" from the model.
  if (!cleaned || cleaned.toUpperCase() === NO_SUMMARY_SENTINEL) return { ...NO_RESULT };

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const title = String(parsed.title ?? '').trim();
    const summary = String(parsed.summary ?? '').trim();
    // The model can also put the sentinel inside the JSON fields.
    return {
      title: title.toUpperCase() === NO_SUMMARY_SENTINEL ? '' : title,
      summary: summary.toUpperCase() === NO_SUMMARY_SENTINEL ? '' : summary,
    };
  } catch {
    // Unparseable. The old fallback stored the raw text as the summary, which
    // turned model refusals and error prose ("I don't have enough context…")
    // into the thread's persisted summary. Treat it as no update instead.
    return { ...NO_RESULT };
  }
}
