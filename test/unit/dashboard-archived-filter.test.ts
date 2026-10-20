import { describe, expect, it } from 'vitest';
import { filterArchivedThreads } from '../../src/dashboardProjectGroups';
import type { Thread } from '../../src/types';

const t = (id: string, status: string, updatedAt: number, extra: Partial<Thread> = {}): Thread =>
  ({ id, title: id, status, updatedAt, messages: [], ...extra }) as unknown as Thread;

describe('filterArchivedThreads', () => {
  it('keeps only archived threads that are not live, newest first', () => {
    const out = filterArchivedThreads(
      [t('a', 'archived', 1), t('b', 'archived', 3), t('c', 'waiting', 5), t('d', 'archived', 2)],
      new Set(['d']),
      '',
    );
    expect(out.map(x => x.id)).toEqual(['b', 'a']);
  });

  it('matches the search query against title, summary and recap', () => {
    const threads = [
      t('x', 'archived', 1, { title: 'Auth cleanup' }),
      t('y', 'archived', 2, { summary: 'moved auth routes' }),
      t('z', 'archived', 3, { recap: 'unrelated' }),
    ];
    expect(filterArchivedThreads(threads, new Set(), 'auth').map(x => x.id)).toEqual(['y', 'x']);
  });
});
