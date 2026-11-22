import { describe, expect, it, vi } from 'vitest';
import { createThreadLinkHost } from '../../src/messageRenderer/threadLinkHost';

const threads = [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }];

function make(known: string[] = ['t1', 't2']) {
  const open = vi.fn();
  const notify = vi.fn();
  const host = createThreadLinkHost({ threads: () => threads, exists: (id) => known.includes(id), open, notify });
  return { host, open, notify };
}

describe('createThreadLinkHost (ThreadsView thread-link behaviour)', () => {
  it('resolves by id, across every thread it is given', () => {
    const { host } = make();
    expect(host.resolveThread('t2', 'whatever')).toEqual({ threadId: 't2', title: 'Two' });
    expect(host.resolveThread('nope', '')).toBeNull();
  });

  it('opens a thread that still exists', () => {
    const { host, open, notify } = make();
    host.openThread('t1');
    expect(open).toHaveBeenCalledWith('t1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('shows a notice instead of opening a thread that was archived after render', () => {
    const { host, open, notify } = make(['t2']);
    host.openThread('t1');
    expect(open).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('That thread no longer exists (it may have been archived or deleted).');
  });
});
