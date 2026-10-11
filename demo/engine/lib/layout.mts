/** Where everything sits on the 1920x1080 canvas. Pure geometry, shared by assets and compose. */
import type { DemoScript } from "./script.mts";

export const MENU_BAR_HEIGHT = 30;
export const DOCK = { tile: 56, pitch: 63, padX: 12, height: 72, bottomMargin: 10, radius: 24 } as const;

/** System apps shown in the dock by default, in order. Your own app is always added at the end. */
export const DEFAULT_DOCK_APPS = ["Finder", "Safari", "Messages", "Mail", "Calendar", "Notes", "Photos", "Music", "Settings"];

export const dockAppsFor = (script: DemoScript): string[] => script.look.dockApps ?? DEFAULT_DOCK_APPS;
export const isPlain = (script: DemoScript): boolean => script.look.style === "plain";

export interface Layout {
  windowW: number;
  windowH: number;
  windowX: number;
  windowY: number;
  radius: number;
  dock: { x: number; y: number; w: number; h: number } | null;
}

export function computeLayout(script: DemoScript): Layout {
  const { capture, output, look } = script;
  const scale = look.windowWidth / capture.width;
  // Even dimensions keep yuv420p happy.
  const windowW = Math.round(capture.width * scale) & ~1;
  const windowH = Math.round(capture.height * scale) & ~1;
  const tiles = dockAppsFor(script).length + 1;
  const dockW = DOCK.padX * 2 + tiles * DOCK.tile + (tiles - 1) * (DOCK.pitch - DOCK.tile);
  const dock = look.dock && !isPlain(script)
    ? { x: Math.round((output.width - dockW) / 2), y: output.height - DOCK.bottomMargin - DOCK.height, w: dockW, h: DOCK.height }
    : null;
  const bottomLimit = dock ? dock.y - 12 : output.height - 24;
  const barHeight = isPlain(script) ? 0 : MENU_BAR_HEIGHT;
  const freeHeight = bottomLimit - barHeight;
  return {
    windowW,
    windowH,
    windowX: Math.round((output.width - windowW) / 2),
    windowY: barHeight + Math.max(0, Math.round((freeHeight - windowH) / 2)),
    radius: look.cornerRadius,
    dock,
  };
}
