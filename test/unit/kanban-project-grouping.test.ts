/**
 * @vitest-environment jsdom
 */

import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (name: string) => name }));
vi.mock('../../src/DispatchInput', () => ({
  DispatchInput: class {
    mount() {}
    destroy() {}
    setValue() {}
  },
}));

import { KanbanView } from '../../src/KanbanView';
import type { Project, Thread } from '../../src/types';

interface TestProject extends Project {
  effectiveCwd: string;
}

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    cwd: '/unknown',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Thread;
}

function makeProject(id: string, name: string, effectiveCwd: string): TestProject {
  return { id, name, effectiveCwd, cwdOverride: effectiveCwd, vaultFolder: name, createdAt: 1 };
}

function renderKanbanBoard(
  threads: Thread[],
  projects: TestProject[],
  kanbanGroupBy: 'folder' | 'project' = 'project',
): HTMLElement {
  const projectById = new Map(projects.map(project => [project.id, project]));
  const manager = {
    vaultRoot: '/vault',
    getThreads: () => threads,
    getProjects: () => projects,
    getProject: (id: string) => projectById.get(id),
    getProjectCwd: (project: TestProject) => project.effectiveCwd,
    isRunning: () => false,
    hasPendingPermission: () => false,
    hasPendingQuestion: () => false,
    hasPendingPlan: () => false,
    hasActiveBackgroundTasks: () => false,
    isAwaitingSandboxDecision: () => false,
    isRunStale: () => false,
    getAgentRuns: () => [],
  };
  const plugin = {
    manager,
    settings: {
      kanbanGroupBy,
      stackScheduledThreads: false,
      orchestratorThreadId: undefined,
      alwaysAllowedTools: [],
      extraEnv: '',
    },
    hasPendingWakeup: () => false,
    getActiveThreadId: () => null,
  };

  const view = new KanbanView({} as never, plugin as never) as unknown as {
    boardEl: HTMLElement;
    headerCountEl: HTMLElement;
    render: () => void;
  };
  view.boardEl = document.createElement('div');
  view.headerCountEl = document.createElement('div');
  view.render();
  return view.boardEl;
}

const renderProjectColumns = (threads: Thread[], projects: TestProject[]): HTMLElement =>
  renderKanbanBoard(threads, projects, 'project');

function columns(board: HTMLElement): Array<{ label: string; cards: string[] }> {
  return Array.from(board.querySelectorAll<HTMLElement>('.ct-kanban-project-col')).map(column => ({
    label: column.querySelector<HTMLElement>('.ct-kanban-col-label')?.textContent ?? '',
    cards: Array.from(column.querySelectorAll<HTMLElement>('.ct-kanban-card-title')).map(card => card.textContent ?? ''),
  }));
}

describe('KanbanView Project grouping identity', () => {
  it('groups an unassigned compass checkout under the configured Compass Project', () => {
    const compass = makeProject('project-compass', 'Compass', '/Users/rickbowman/projects/compass');
    const board = renderProjectColumns([
      makeThread('explicit', { projectId: compass.id, cwd: '/Users/rickbowman/projects/compass' }),
      makeThread('derived', { cwd: '/Users/rickbowman/projects/compass' }),
    ], [compass]);

    expect(columns(board)).toEqual([{ label: 'Compass', cards: ['explicit', 'derived'] }]);
  });

  it('keeps explicit Project assignment authoritative over a cwd match', () => {
    const alpha = makeProject('alpha', 'Alpha', '/repos/alpha');
    const beta = makeProject('beta', 'Beta', '/repos/beta');
    const board = renderProjectColumns([
      makeThread('assigned-alpha', { projectId: alpha.id, cwd: beta.effectiveCwd }),
      makeThread('assigned-beta', { projectId: beta.id, cwd: beta.effectiveCwd }),
    ], [alpha, beta]);

    expect(columns(board)).toEqual([
      { label: 'Alpha', cards: ['assigned-alpha'] },
      { label: 'Beta', cards: ['assigned-beta'] },
    ]);
  });

  it('does not merge unrelated Projects merely because their display names match', () => {
    const first = makeProject('first', 'Compass', '/repos/first');
    const second = makeProject('second', 'Compass', '/repos/second');
    const board = renderProjectColumns([
      makeThread('first-thread', { projectId: first.id, cwd: first.effectiveCwd }),
      makeThread('second-thread', { projectId: second.id, cwd: second.effectiveCwd }),
    ], [first, second]);

    expect(columns(board)).toEqual([
      { label: 'Compass', cards: ['first-thread'] },
      { label: 'Compass', cards: ['second-thread'] },
    ]);
  });

  it('matches a worktree to the Project using its origin repository path', () => {
    const compass = makeProject('project-compass', 'Compass', '/repos/compass');
    const board = renderProjectColumns([
      makeThread('worktree', {
        cwd: '/tmp/worktrees/compass-fix',
        originRepoPath: '/repos/compass/',
      }),
    ], [compass]);

    expect(columns(board)).toEqual([{ label: 'Compass', cards: ['worktree'] }]);
  });

  it('keeps an unknown cwd in its repository fallback group', () => {
    const compass = makeProject('project-compass', 'Compass', '/repos/compass');
    const board = renderProjectColumns([
      makeThread('unknown', { cwd: '/repos/unconfigured' }),
    ], [compass]);

    expect(columns(board)).toEqual([{ label: 'unconfigured', cards: ['unknown'] }]);
  });

  it('chooses the lexically smallest stable Project id when multiple Projects match', () => {
    const laterId = makeProject('z-project', 'Zeta', '/repos/shared');
    const earlierId = makeProject('a-project', 'Alpha', '/repos/shared');
    const board = renderProjectColumns([
      makeThread('ambiguous', { cwd: '/repos/shared' }),
    ], [laterId, earlierId]);

    expect(columns(board)).toEqual([{ label: 'Alpha', cards: ['ambiguous'] }]);
  });

  it('keeps legacy orphaned worktrees from the same persisted PR repository in one column', () => {
    const board = renderProjectColumns([
      makeThread('legacy-one', {
        cwd: '/tmp/claude-worktrees/stale-one',
        projectNameOverride: 'obsidian-claude-threads',
        prUrl: 'https://github.com/rbcodelabs/obsidian-claude-threads/pull/478',
      }),
      makeThread('legacy-two', {
        cwd: '/tmp/claude-worktrees/stale-two',
        projectNameOverride: 'obsidian-claude-threads',
        prUrl: 'https://github.com/rbcodelabs/obsidian-claude-threads/pull/479',
      }),
    ], []);

    expect(columns(board)).toEqual([{
      label: 'obsidian-claude-threads',
      cards: ['legacy-one', 'legacy-two'],
    }]);
  });

  it('uses the same persisted PR repository identity for legacy folder swimlanes', () => {
    const board = renderKanbanBoard([
      makeThread('legacy-one', {
        cwd: '/tmp/claude-worktrees/stale-one',
        projectNameOverride: 'obsidian-claude-threads',
        prUrl: 'https://github.com/rbcodelabs/obsidian-claude-threads/pull/478',
      }),
      makeThread('legacy-two', {
        cwd: '/tmp/claude-worktrees/stale-two',
        projectNameOverride: 'obsidian-claude-threads',
        prUrl: 'https://github.com/rbcodelabs/obsidian-claude-threads/pull/479',
      }),
    ], [], 'folder');

    const lanes = Array.from(board.querySelectorAll<HTMLElement>('.ct-kanban-lane'));
    expect(lanes).toHaveLength(1);
    expect(lanes[0].querySelector('.ct-kanban-lane-name')?.textContent).toBe('obsidian-claude-threads');
    expect(Array.from(lanes[0].querySelectorAll<HTMLElement>('.ct-kanban-card-title')).map(card => card.textContent)).toEqual([
      'legacy-one',
      'legacy-two',
    ]);
  });

  it('keeps same-looking legacy labels from different persisted PR repositories separate', () => {
    const board = renderProjectColumns([
      makeThread('first-owner', {
        cwd: '/tmp/claude-worktrees/stale-first-owner',
        projectNameOverride: 'shared-repo',
        prUrl: 'https://github.com/first-owner/shared-repo/pull/1',
      }),
      makeThread('second-owner', {
        cwd: '/tmp/claude-worktrees/stale-second-owner',
        projectNameOverride: 'shared-repo',
        prUrl: 'https://github.com/second-owner/shared-repo/pull/2',
      }),
    ], []);

    expect(columns(board)).toEqual([
      { label: 'shared-repo', cards: ['first-owner'] },
      { label: 'shared-repo', cards: ['second-owner'] },
    ]);
  });
});
