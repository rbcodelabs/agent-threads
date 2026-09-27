import { describe, expect, it, vi } from 'vitest';
import { createDesignSlashCommand, type DesignSlashCommandDependencies } from '../harness/design-plugin/designSlashCommand';
import type { SlashCommandContext, SlashCommandHost } from '../../src/SlashCommandContributions';

function fixture() {
  const deps: DesignSlashCommandDependencies = {
    getState: vi.fn(() => ({ hasArtifacts: false })),
    isDesktopFilesystem: vi.fn(() => true),
    prepare: vi.fn(async () => ({ artifact: { title: 'Pricing' }, instructions: 'kickoff instructions' })),
    send: vi.fn(async () => {}),
    dispatch: vi.fn(async () => 'new-thread'),
  };
  const controller = new AbortController();
  const host: SlashCommandHost = { signal: controller.signal, report: vi.fn() };
  const context: SlashCommandContext = { surface: 'thread', text: '/design pricing', args: 'pricing', threadId: 'original-thread', hasImages: false, hasAttachment: false };
  const command = createDesignSlashCommand(deps);
  return { deps, host, context, command, controller };
}

describe('Design slash command contribution', () => {
  it('provides the existing descriptions for both surfaces', () => {
    const { command } = fixture();
    expect(command.name).toBe('design');
    expect(command.thread?.description).toBe('Create or revise a live static UI artifact: /design <brief>');
    expect(command.dispatch?.description).toBe('Dispatch a thread with a live static UI artifact: /design <brief>');
  });

  it('requires a brief for an empty thread', async () => {
    const { command, deps, context, host } = fixture();
    const result = await command.thread!.invoke({ ...context, args: '' }, host);
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('Include a brief') });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('requires desktop filesystem before preparing', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.isDesktopFilesystem).mockReturnValue(false);
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'error', message: 'Design artifacts require a desktop vault with local filesystem access.' });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Existing title'])('reopens a bare command using existing title %s without sending', async existingTitle => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.getState).mockReturnValue({ hasArtifacts: true, existingTitle });
    expect(await command.thread!.invoke({ ...context, args: '' }, host)).toEqual({ status: 'ok' });
    expect(deps.prepare).toHaveBeenCalledWith('original-thread', existingTitle ?? 'Design artifact');
    expect(host.report).toHaveBeenCalledWith('Opened design artifact: Pricing');
    expect(deps.send).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Existing title'])('starts create/revise for existing title %s using prepared instructions', async existingTitle => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.getState).mockReturnValue({ hasArtifacts: !!existingTitle, existingTitle });
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'ok' });
    expect(deps.prepare).toHaveBeenCalledWith('original-thread', 'pricing');
    expect(deps.send).toHaveBeenCalledWith('original-thread', 'kickoff instructions');
    expect(host.report).toHaveBeenCalledWith(existingTitle ? 'Revising design artifact…' : 'Design artifact created. Starting design turn…');
  });

  it('returns preparation error without attempting send', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.prepare).mockRejectedValue(new Error('storage failed'));
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'error', message: 'Could not prepare the design artifact: storage failed' });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('reports asynchronous send failure after successful preparation', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.send).mockRejectedValue(new Error('session failed'));
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'ok' });
    await vi.waitFor(() => expect(host.report).toHaveBeenCalledWith('Failed to start design turn: session failed', true));
  });

  it('does not await completion of the design turn', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.send).mockReturnValue(new Promise(() => {}));
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'ok' });
    expect(deps.send).toHaveBeenCalledOnce();
  });

  it('does nothing for a missing originating thread', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.getState).mockReturnValue(null);
    expect(await command.thread!.invoke(context, host)).toEqual({ status: 'ok' });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('does not prepare a command already cancelled', async () => {
    const { command, deps, context, host, controller } = fixture();
    controller.abort();
    expect(await command.thread!.invoke(context, host)).toMatchObject({ status: 'error' });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('does not send or report when cancelled during preparation', async () => {
    const { command, deps, context, host, controller } = fixture();
    vi.mocked(deps.prepare).mockImplementation(async () => {
      controller.abort();
      return { artifact: { title: 'Pricing' }, instructions: 'kickoff' };
    });
    expect(await command.thread!.invoke(context, host)).toMatchObject({ status: 'error' });
    expect(deps.send).not.toHaveBeenCalled();
    expect(host.report).not.toHaveBeenCalled();
  });

  it('requires a dispatch brief before checking attachments', async () => {
    const { command, deps, context, host } = fixture();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', args: '', hasImages: true }, host)).toEqual({ status: 'error', message: 'Include a brief — e.g. "/design a responsive pricing page for a developer tool"' });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each(['hasImages', 'hasAttachment'] as const)('rejects dispatch with %s', async attachment => {
    const { command, deps, context, host } = fixture();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', [attachment]: true }, host)).toEqual({ status: 'error', message: 'Design dispatch does not support attachments yet. Remove them and try again.' });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', undefined] as const)('dispatches preserving harness %s', async agentHarness => {
    const { command, deps, context, host } = fixture();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch', agentHarness }, host)).toEqual({ status: 'ok' });
    expect(deps.dispatch).toHaveBeenCalledWith('pricing', agentHarness);
  });

  it('returns dispatch failure with the existing error prefix', async () => {
    const { command, deps, context, host } = fixture();
    vi.mocked(deps.dispatch).mockRejectedValue('navigation failed');
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch' }, host)).toEqual({ status: 'error', message: 'Could not create design artifact: navigation failed' });
  });

  it('does not dispatch when cancelled', async () => {
    const { command, deps, context, host, controller } = fixture();
    controller.abort();
    expect(await command.dispatch!.invoke({ ...context, surface: 'dispatch' }, host)).toMatchObject({ status: 'error' });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
