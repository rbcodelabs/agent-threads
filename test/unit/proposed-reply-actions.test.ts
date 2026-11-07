import { describe, expect, it, vi } from 'vitest';
import {
  approveProposedReply, clearProposedReply, discardProposedReply, takeProposedReplyForEdit,
  type ProposedReplyDeps,
} from '../../src/proposedReplyActions';

function setup(withReply = true) {
  const thread: { proposedReply?: { text: string; generatedAt: number } } = withReply ? { proposedReply: { text: 'do the thing', generatedAt: 5 } } : {};
  const log: string[] = [];
  const deps: ProposedReplyDeps = {
    getThread: (id) => (id === 't1' ? thread : undefined),
    notifyProposedReplyChanged: vi.fn(() => { log.push(`notify(proposal=${thread.proposedReply ? 'present' : 'cleared'})`); }),
    saveSettings: vi.fn(() => { log.push('save'); }),
    sendMessage: vi.fn(async (_id, text) => { log.push(`send(proposal=${thread.proposedReply ? 'present' : 'cleared'},${text})`); }),
  };
  return { thread, deps, log };
}

describe('proposedReplyActions', () => {
  it('Approve clears (notify + save) BEFORE sending, so a second click cannot double-send', async () => {
    const { deps, log, thread } = setup();
    await expect(approveProposedReply(deps, 't1')).resolves.toBe(true);
    expect(thread.proposedReply).toBeUndefined();
    expect(log).toEqual(['notify(proposal=cleared)', 'save', 'send(proposal=cleared,do the thing)']);
    // The proposal is gone, so a second Approve is a no-op.
    await expect(approveProposedReply(deps, 't1')).resolves.toBe(false);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('Approve leaves the proposal cleared and rethrows when the send fails', async () => {
    const { deps, thread } = setup();
    (deps.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await expect(approveProposedReply(deps, 't1')).rejects.toThrow('boom');
    expect(thread.proposedReply).toBeUndefined();
  });

  it('Approve on a thread with no proposal sends nothing', async () => {
    const { deps } = setup(false);
    await expect(approveProposedReply(deps, 't1')).resolves.toBe(false);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('Edit returns the text and clears without sending', () => {
    const { deps, thread } = setup();
    expect(takeProposedReplyForEdit(deps, 't1')).toBe('do the thing');
    expect(thread.proposedReply).toBeUndefined();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(takeProposedReplyForEdit(deps, 't1')).toBeUndefined();
  });

  it('Discard clears without sending; unknown thread is a no-op', () => {
    const { deps, thread } = setup();
    discardProposedReply(deps, 't1');
    expect(thread.proposedReply).toBeUndefined();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    clearProposedReply(deps, 'missing');
    expect(deps.notifyProposedReplyChanged).toHaveBeenCalledTimes(1);
  });
});
