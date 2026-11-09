/**
 * orchestrator-dock-command.test.ts
 *
 * Pins the Cmd+J command declaration (spike S2) and its fall-through contract.
 * Geode reads `{modifiers, code}`, Obsidian reads `{modifiers, key}`, so the one
 * declaration carries both. Geode treats ONLY an explicit `false` from
 * checkCallback(true) as "unavailable" (anything else swallows the keypress).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ORCHESTRATOR_DOCK_COMMAND_ID,
  ORCHESTRATOR_DOCK_HOTKEYS,
  orchestratorDockCommand,
} from '../../src/orchestratorDockCommand';

describe('orchestrator dock command declaration', () => {
  it('has the agreed id, name and dual-host Mod+J hotkey', () => {
    const cmd = orchestratorDockCommand(() => null);
    expect(cmd.id).toBe('focus-orchestrator-dock');
    expect(ORCHESTRATOR_DOCK_COMMAND_ID).toBe('focus-orchestrator-dock');
    expect(cmd.name).toBe('Ask the portfolio orchestrator');
    expect(cmd.hotkeys).toEqual([{ modifiers: ['Mod'], key: 'J', code: 'KeyJ' }]);
    expect(ORCHESTRATOR_DOCK_HOTKEYS).toEqual([{ modifiers: ['Mod'], key: 'J', code: 'KeyJ' }]);
  });

  it('does not declare the legacy `hotkey` string (hotkeys wins in Geode; Obsidian has no such field)', () => {
    expect('hotkey' in orchestratorDockCommand(() => null)).toBe(false);
  });
});

describe('orchestrator dock command checkCallback', () => {
  it('returns an EXPLICIT false when no Kanban view is active, so the key falls through', () => {
    const cmd = orchestratorDockCommand(() => null);
    expect(cmd.checkCallback(true)).toBe(false);
    expect(cmd.checkCallback(false)).toBe(false);
  });

  it('while checking, returns true without focusing', () => {
    const focus = vi.fn();
    const cmd = orchestratorDockCommand(() => ({ focusOrchestratorDock: focus }));
    expect(cmd.checkCallback(true)).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it('focuses the dock and returns true when run against an active Kanban view', () => {
    const focus = vi.fn();
    const cmd = orchestratorDockCommand(() => ({ focusOrchestratorDock: focus }));
    expect(cmd.checkCallback(false)).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('never opens the Board itself: the view lookup is the only dependency', () => {
    const lookup = vi.fn(() => null);
    orchestratorDockCommand(lookup).checkCallback(false);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
