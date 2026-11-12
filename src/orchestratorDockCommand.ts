/**
 * orchestratorDockCommand.ts
 *
 * The "Ask the portfolio orchestrator" command (default Mod+J), kept out of
 * main.ts so its declaration shape and fall-through contract are unit-testable.
 *
 * One declaration serves both hosts (spike S2): Geode reads `{modifiers, code}`
 * (physical key) and ignores `key`; Obsidian reads `{modifiers, key}` and has no
 * `code`. It is a normal plugin command, so it shows up in Settings > Hotkeys and
 * the user can rebind or clear it there.
 */
import type { Hotkey, Modifier } from 'obsidian';

export const ORCHESTRATOR_DOCK_COMMAND_ID = 'focus-orchestrator-dock';
export const ORCHESTRATOR_DOCK_COMMAND_NAME = 'Ask the portfolio orchestrator';

// Deliberately a non-fresh const: Obsidian's `Hotkey` type has no `code`, and an
// object literal assigned straight into `hotkeys` would be an excess-property error.
const dualHostHotkey = { modifiers: ['Mod'] as Modifier[], key: 'J', code: 'KeyJ' };
export const ORCHESTRATOR_DOCK_HOTKEYS: Hotkey[] = [dualHostHotkey];

export interface DockFocusTarget {
  focusOrchestratorDock(): void;
}

export function orchestratorDockCommand(getActiveBoard: () => DockFocusTarget | null) {
  return {
    id: ORCHESTRATOR_DOCK_COMMAND_ID,
    name: ORCHESTRATOR_DOCK_COMMAND_NAME,
    hotkeys: ORCHESTRATOR_DOCK_HOTKEYS,
    /**
     * Geode only treats an EXPLICIT `false` from checkCallback(true) as
     * "unavailable" (anything else swallows the keypress), so the no-board case
     * returns `false`, never `undefined`. The Board is not opened automatically.
     */
    checkCallback(checking: boolean): boolean {
      const board = getActiveBoard();
      if (!board) return false;
      if (!checking) board.focusOrchestratorDock();
      return true;
    },
  };
}
