import { Notice } from 'obsidian';
import type { DispatchInput } from './DispatchInput';
import type { ImageAttachment } from './types';
import type { SlashCommandRegistry } from './SlashCommandContributions';

/** A matched command owns the submission, including errors: never send it as a prompt. */
export async function handleContributedDispatch(args: {
  registry?: SlashCommandRegistry;
  text: string;
  images: ImageAttachment[];
  attachment: string | null;
  agentHarness?: 'claude' | 'codex';
  projectId?: string;
  input: DispatchInput;
}): Promise<boolean> {
  const result = await args.registry?.invoke({
    surface: 'dispatch', text: args.text, agentHarness: args.agentHarness,
    projectId: args.projectId, hasImages: args.images.length > 0, hasAttachment: !!args.attachment,
  }, message => { new Notice(message); });
  if (!result) return false;
  if (result.message) new Notice(result.message);
  if (result.status === 'error') args.input.restoreFailedDraft(args.text, args.images, args.attachment);
  return true;
}
