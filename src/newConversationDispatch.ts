import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import type { AgentHarness, ImageAttachment } from './types';
import type { DispatchInput, DispatchPayload } from './DispatchInput';
import type { SlashCommandRegistry } from './SlashCommandContributions';
import type { PluginSettings } from './types';
import { buildMessageWithAttachment, deriveDispatchTitle } from './attachmentUtils';
import { goalKickoffMessage, parseDispatchDirective } from './slashCommands';
import { handleContributedDispatch } from './slashCommandRouting';

/** Options understood by `ClaudeThreadsPlugin.dispatchNewThread`. */
export interface DispatchNewThreadOptions {
  model?: string;
  goal?: string;
  loop?: { intervalSeconds: number };
  agentHarness?: AgentHarness;
  projectId?: string;
  remote?: { daemonId: string; cwd: string };
}

export interface NewConversationDispatchDeps {
  app: App;
  settings: Pick<PluginSettings, 'escalationEnabled' | 'escalationKeyword'>;
  slashCommands?: SlashCommandRegistry;
  dispatchNewThread: (
    text: string,
    images: ImageAttachment[] | undefined,
    titleHint: string,
    opts: DispatchNewThreadOptions,
  ) => Promise<string>;
  /** Composer that produced the payload; restored when the dispatch is refused. */
  input: DispatchInput;
  /** Project chosen in the composer ('' / undefined = deliberately no project). */
  projectId?: string;
}

/**
 * The first-send path of a new conversation: contributed (peer) commands, then
 * the core `/model`, `/goal` and `/loop` directives, `@[[file]]` mention
 * expansion, and finally `dispatchNewThread`.
 *
 * Returns the created thread id, or `null` when nothing was created (a peer
 * command owned the submission, or the directive was malformed and the draft
 * was put back). This is the single implementation behind the former
 * Agents List and Kanban dispatch boxes.
 */
export async function dispatchNewConversation(
  deps: NewConversationDispatchDeps,
  payload: DispatchPayload,
): Promise<string | null> {
  const { images, attachment, agentHarness, remote } = payload;
  let text = payload.text;
  let opts: DispatchNewThreadOptions = {
    agentHarness,
    remote,
    projectId: deps.projectId || undefined,
  };
  let titleText = text;

  if (await handleContributedDispatch({
    registry: deps.slashCommands, text, images, attachment, agentHarness,
    projectId: opts.projectId, input: deps.input,
  })) return null;

  const directive = parseDispatchDirective(
    text,
    deps.settings.escalationEnabled ? deps.settings.escalationKeyword : undefined,
  );
  if (directive) {
    if (directive.error) {
      new Notice(directive.error);
      deps.input.restoreFailedDraft(text, images, attachment);
      return null;
    }
    if (directive.kind === 'model') {
      if (!directive.rest && images.length === 0 && !attachment) {
        new Notice('Include a prompt after /model — e.g. "/model opus fix the login bug"');
        deps.input.restoreFailedDraft(text, images, attachment);
        return null;
      }
      opts = { ...opts, model: directive.model };
      text = titleText = directive.rest;
    } else if (directive.kind === 'goal') {
      opts = { ...opts, goal: directive.goal };
      text = goalKickoffMessage(directive.goal);
      titleText = directive.goal;
    } else if (directive.kind === 'loop') {
      opts = { ...opts, loop: { intervalSeconds: directive.intervalSeconds } };
      text = titleText = directive.prompt;
    }
    // 'escalate' directives always carry `error` (handled above) — no success
    // case, so the raw text is dispatched as-is via ThreadManager's keyword path.
  }

  let messageText = buildMessageWithAttachment(text, attachment);

  // Resolve @[[basename]] file mentions — append each file's content as context.
  const mentions = [...messageText.matchAll(/@\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
  if (mentions.length > 0) {
    const fileContextParts: string[] = [];
    for (const basename of mentions) {
      const file = deps.app.vault.getMarkdownFiles().find((f) => f.basename === basename);
      if (!file) continue;
      try {
        const content = await deps.app.vault.cachedRead(file);
        fileContextParts.push(`**File: ${file.path}**\n\`\`\`\n${content}\n\`\`\``);
      } catch { /* skip unreadable file */ }
    }
    if (fileContextParts.length > 0) {
      messageText = messageText + '\n\n---\nReferenced files:\n\n' + fileContextParts.join('\n\n');
    }
  }

  const titleHint = deriveDispatchTitle(titleText, attachment, images.length);
  return deps.dispatchNewThread(
    messageText,
    images.length > 0 ? images : undefined,
    titleHint,
    opts,
  );
}
