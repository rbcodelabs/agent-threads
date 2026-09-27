import type { SlashCommandContribution, SlashCommandResult } from '../../../src/SlashCommandContributions';

export interface DesignSlashCommandDependencies {
  getState(threadId: string): { hasArtifacts: boolean; existingTitle?: string } | null;
  isDesktopFilesystem(): boolean;
  prepare(threadId: string, brief: string): Promise<{ artifact: { title: string }; instructions: string }>;
  send(threadId: string, prompt: string): Promise<void>;
  dispatch(brief: string, harness?: 'claude' | 'codex'): Promise<string>;
}

const failure = (message: string): SlashCommandResult => ({ status: 'error', message });
const cancelled = (): SlashCommandResult => failure('Design command was cancelled.');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Design behavior with host adapters; command views know only the contribution contract. */
export function createDesignSlashCommand(deps: DesignSlashCommandDependencies): SlashCommandContribution {
  return {
    name: 'design',
    thread: {
      description: 'Create or revise a live static UI artifact: /design <brief>',
      invoke: async (context, host) => {
        if (host.signal.aborted) return cancelled();
        const threadId = context.threadId;
        const state = threadId ? deps.getState(threadId) : null;
        if (!threadId || !state) return { status: 'ok' };
        const brief = context.args;
        if (!brief && !state.hasArtifacts) {
          return failure('Include a brief — e.g. /design a responsive pricing page for a developer tool');
        }
        if (!deps.isDesktopFilesystem()) {
          return failure('Design artifacts require a desktop vault with local filesystem access.');
        }
        let prepared: Awaited<ReturnType<DesignSlashCommandDependencies['prepare']>>;
        try {
          prepared = await deps.prepare(threadId, brief || state.existingTitle || 'Design artifact');
        } catch (error) {
          return failure(`Could not prepare the design artifact: ${errorMessage(error)}`);
        }
        if (host.signal.aborted) return cancelled();
        if (!brief) {
          host.report(`Opened design artifact: ${prepared.artifact.title}`);
          return { status: 'ok' };
        }
        host.report(state.existingTitle !== undefined ? 'Revising design artifact…' : 'Design artifact created. Starting design turn…');
        // Sending starts a long-lived turn. Preparation is the command's
        // transaction boundary; a later session failure keeps the artifact.
        void Promise.resolve().then(() => {
          if (!host.signal.aborted) return deps.send(threadId, prepared.instructions);
        }).catch(error => {
          if (!host.signal.aborted) host.report(`Failed to start design turn: ${errorMessage(error)}`, true);
        });
        return { status: 'ok' };
      },
    },
    dispatch: {
      description: 'Dispatch a thread with a live static UI artifact: /design <brief>',
      invoke: async (context, host) => {
        if (host.signal.aborted) return cancelled();
        if (!context.args) return failure('Include a brief — e.g. "/design a responsive pricing page for a developer tool"');
        if (context.hasImages || context.hasAttachment) {
          return failure('Design dispatch does not support attachments yet. Remove them and try again.');
        }
        try {
          await deps.dispatch(context.args, context.agentHarness);
          return host.signal.aborted ? cancelled() : { status: 'ok' };
        } catch (error) {
          return failure(`Could not create design artifact: ${errorMessage(error)}`);
        }
      },
    },
  };
}
