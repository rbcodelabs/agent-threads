/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (name: string) => name }));
vi.mock('../../src/DispatchInput', () => ({
  DispatchInput: class {
    mount(): void {}
  },
}));

import { AgentDashboard } from '../../src/AgentDashboard';
import { KANBAN_VIEW_TYPE, KanbanView } from '../../src/KanbanView';
import { buildDiagnosticsReport, type DiagnosticsInput } from '../../src/telemetry';

describe('Agent Board product metadata', () => {
  it('uses the Agent Board name and dedicated kanban icon without changing its view type', () => {
    const view = Object.create(KanbanView.prototype) as KanbanView;

    expect(view.getDisplayText()).toBe('Agent Board');
    expect(view.getIcon()).toBe('kanban');
    expect(view.getViewType()).toBe(KANBAN_VIEW_TYPE);
    expect(KANBAN_VIEW_TYPE).toBe('claude-threads:kanban');
  });

  it('the Agents List no longer carries an Agent Board button; the board stays reachable by command', () => {
    const dashboardSource = readFileSync(resolve(__dirname, '../../src/AgentDashboard.ts'), 'utf8');
    expect(dashboardSource).not.toContain('activateKanbanView');
    expect(dashboardSource).not.toContain('Open Agent Board');
    const mainSource = readFileSync(resolve(__dirname, '../../src/main.ts'), 'utf8');
    expect(mainSource).toMatch(/id: 'open-kanban-board',\s+name: 'Open Agent Board'/);
  });

  it('titles the Agents List by thread count only', () => {
    const view = Object.assign(Object.create(AgentDashboard.prototype), { displayedThreadCount: 14 }) as AgentDashboard;
    expect(view.getDisplayText()).toBe('14 threads');
    Object.assign(view, { displayedThreadCount: 1 });
    expect(view.getDisplayText()).toBe('1 thread');
  });

  it('uses the product name in user-visible diagnostics without renaming the internal counter', () => {
    const input: DiagnosticsInput = {
      pluginVersion: '0.0.0',
      host: { app: 'obsidian', version: '1.0.0', platform: 'darwin', arch: 'arm64' },
      system: { cpuCount: 8, totalMemMb: 16384, loadAvg: [0, 0, 0] },
      vault: { fileCount: 0, dataJsonSizeBytes: 0 },
      threads: { total: 0, running: 0 },
      counters: {
        rendersScheduled: 0,
        kanbanFullRebuilds: 3,
        spawns: { statusline: 0, gitdiff: 0, other: 0 },
        savesRequested: 0,
        savesWritten: 0,
      },
      perfSamples: [],
      longtask: { count: 0, worstMs: [] },
      logEntries: [],
      homedir: '/Users/test',
      generatedAt: 0,
    };

    const { markdown, json } = buildDiagnosticsReport(input);
    expect(markdown).toContain('- Agent Board full rebuilds: 3');
    expect(JSON.parse(json).counters.kanbanFullRebuilds).toBe(3);
  });

  it('renames the command palette entry while retaining its compatibility ID', () => {
    const mainSource = readFileSync(resolve(__dirname, '../../src/main.ts'), 'utf8');
    expect(mainSource).toMatch(/id: 'open-kanban-board',\s+name: 'Open Agent Board'/);
  });
});
