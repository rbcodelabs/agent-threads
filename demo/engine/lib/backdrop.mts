/**
 * The macOS desktop around the window: wallpaper, menu bar, dock and the
 * window's drop shadow. Laid out as plain HTML/CSS and rasterised with the
 * Electron the demo already depends on, so it uses the host's real system font
 * and CSS blur instead of hand-drawn ffmpeg approximations. Everything here is
 * original artwork; the only image is your own app icon (look.appIcon). On a Mac the
 * dock shows the real system app icons, extracted with sips; elsewhere it uses neutral tiles.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { dockAppsFor, DOCK, isPlain, MENU_BAR_HEIGHT, type Layout } from "./layout.mts";
import { projectRoot } from "./paths.mts";
import type { DemoScript } from "./script.mts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Inter", "Liberation Sans", sans-serif`;

interface DockIcon {
  name: string;
  /** CSS gradient behind the glyph. */
  bg: string;
  /** Inline SVG (24x24 viewBox, white strokes). */
  glyph: string;
  running?: boolean;
  image?: string;
}

/** Real macOS app icons (extracted with sips on a Mac): [dock label, .app bundle]. */
export const SYSTEM_APPS: Record<string, string> = {
  Finder: "/System/Library/CoreServices/Finder.app",
  Safari: "/Applications/Safari.app",
  Messages: "/System/Applications/Messages.app",
  Mail: "/System/Applications/Mail.app",
  Calendar: "/System/Applications/Calendar.app",
  Notes: "/System/Applications/Notes.app",
  Photos: "/System/Applications/Photos.app",
  Music: "/System/Applications/Music.app",
  Settings: "/System/Applications/System Settings.app",
};

const DOCK_ICONS = (names: string[], appName: string, appIcon: string | null, real: Record<string, string>): DockIcon[] => [
  // Off a Mac there are no system icons to extract, so fall back to plain neutral tiles.
  ...names.map((name): DockIcon =>
    real[name] ? { name, bg: "transparent", glyph: "", image: real[name], running: name === "Finder" } : { name, bg: "linear-gradient(160deg,#c9ced8,#8b93a3)", glyph: "", running: name === "Finder" },
  ),
  appIcon
    ? { name: appName, bg: "transparent", glyph: "", running: true, image: appIcon }
    : { name: appName, bg: "linear-gradient(160deg,#7c6cf0,#4b3bd1)", glyph: `<svg viewBox="0 0 24 24"><text x="12" y="17" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="${FONT}">${esc(appName.slice(0, 1).toUpperCase())}</text></svg>`, running: true },
];

function menuBarGlyphs(): { apple: string; wifi: string; search: string; control: string } {
  const white = `fill="#fff"`;
  return {
    apple: `<svg width="16" height="19" viewBox="0 0 16 19" ${white}><path d="M13.2 10.1c0-2.1 1.7-3.1 1.8-3.2-1-1.4-2.5-1.6-3-1.6-1.3-.1-2.5.8-3.2.8-.7 0-1.7-.7-2.7-.7-1.4 0-2.7.8-3.4 2.1-1.5 2.5-.4 6.300 1 8.300.7 1 1.500 2.100 2.600 2.100 1 0 1.400-.7 2.700-.7 1.200 0 1.600.7 2.700.7 1.100 0 1.800-1 2.500-2 .8-1.100 1.100-2.200 1.100-2.300 0 0-2.100-.8-2.100-3.500zM11.200 3.800c.6-.7 1-1.700.9-2.700-.9 0-1.900.6-2.500 1.300-.5.600-1 1.600-.9 2.600 1 .1 1.900-.5 2.500-1.200z"/></svg>`,
    wifi: `<svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"><path d="M1.5 5a11 11 0 0115 0M4 7.8a7.300 7.300 0 0110 0M6.600 10.500a3.600 3.600 0 014.800 0"/><circle cx="9" cy="12.600" r="1" fill="#fff" stroke="none"/></svg>`,
    search: `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"><circle cx="6.300" cy="6.300" r="4.600"/><path d="M10 10l3.600 3.600"/></svg>`,
    control: `<svg width="17" height="14" viewBox="0 0 17 14" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"><path d="M1 4h15M1 10h15"/><circle cx="11" cy="4" r="2" fill="#fff" stroke="none"/><circle cx="6" cy="10" r="2" fill="#fff" stroke="none"/></svg>`,
  };
}

export function backdropHtml(script: DemoScript, layout: Layout, appIconUrl: string | null, realIcons: Record<string, string> = {}): string {
  const { output, look } = script;
  const g = menuBarGlyphs();
  const bar = look.menuBar;
  const menus = bar.items.map((item) => `<span>${esc(item)}</span>`).join("");
  const icons = DOCK_ICONS(dockAppsFor(script), bar.appName, appIconUrl, realIcons);
  const dock = layout.dock;
  const dockHtml = dock
    ? `<div class="dock" style="left:${dock.x}px;top:${dock.y}px;width:${dock.w}px;height:${dock.h}px">${icons
        .map(
          (icon) =>
            `<div class="tile">${
              icon.image
                ? `<img src="${icon.image}" width="${DOCK.tile}" height="${DOCK.tile}">`
                : `<div class="art" style="background:${icon.bg}">${icon.glyph}</div>`
            }${icon.running ? `<i class="dot"></i>` : ""}</div>`,
        )
        .join("")}</div>`
    : "";
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${output.width}px;height:${output.height}px;overflow:hidden;font-family:${FONT};-webkit-font-smoothing:antialiased}
.wall{position:absolute;inset:0;background:
  radial-gradient(1100px 760px at 82% 12%,rgba(255,176,102,.95),rgba(255,176,102,0) 62%),
  radial-gradient(900px 700px at 8% 92%,rgba(66,153,255,.9),rgba(66,153,255,0) 60%),
  radial-gradient(1000px 640px at 55% 105%,rgba(255,92,150,.85),rgba(255,92,150,0) 62%),
  radial-gradient(900px 600px at 18% 8%,rgba(120,72,255,.85),rgba(120,72,255,0) 65%),
  linear-gradient(135deg,#1a1650 0%,#4a2a98 38%,#c4488c 72%,#f28b5c 100%)}
.ribbon{position:absolute;left:-10%;width:130%;height:420px;border-radius:50%;filter:blur(46px);opacity:.55;transform:rotate(-14deg)}
.r1{top:520px;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,214,170,.7),rgba(255,255,255,0))}
.r2{top:130px;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(140,120,255,.65),rgba(255,255,255,0));transform:rotate(-9deg)}
.grain{position:absolute;inset:0;opacity:.07;mix-blend-mode:overlay}
.shadow{position:absolute;left:${layout.windowX}px;top:${layout.windowY}px;width:${layout.windowW}px;height:${layout.windowH}px;border-radius:${layout.radius}px;background:#000;
  box-shadow:0 0 0 1px rgba(0,0,0,.45),0 30px 80px rgba(8,4,30,.55),0 12px 28px rgba(8,4,30,.4)}
.menubar{position:absolute;left:0;top:0;width:100%;height:${MENU_BAR_HEIGHT}px;display:flex;align-items:center;padding:0 16px;color:#fff;font-size:14px;
  background:rgba(30,20,60,.28);backdrop-filter:blur(30px) saturate(1.6);border-bottom:.5px solid rgba(255,255,255,.12);text-shadow:0 .5px 1px rgba(0,0,0,.25)}
.menubar .left,.menubar .right{display:flex;align-items:center;gap:20px}
.menubar .left{flex:1}
.menubar .left b{font-weight:700}
.menubar .left span{font-weight:500}
.menubar .right{gap:17px;font-weight:500}
.battery{display:flex;align-items:center;gap:1px}
.battery .body{width:26px;height:12px;border:1.2px solid rgba(255,255,255,.85);border-radius:3.5px;padding:1.2px}
.battery .body i{display:block;height:100%;width:78%;background:#fff;border-radius:1.6px}
.battery .nub{width:2px;height:5px;background:rgba(255,255,255,.85);border-radius:0 1px 1px 0}
.dock{position:absolute;display:flex;align-items:center;padding:0 ${DOCK.padX}px;gap:${DOCK.pitch - DOCK.tile}px;border-radius:${DOCK.radius}px;
  background:rgba(255,255,255,.30);backdrop-filter:blur(40px) saturate(1.3);box-shadow:inset 0 0 0 .8px rgba(255,255,255,.5),inset 0 1px 0 rgba(255,255,255,.35),0 12px 34px rgba(10,5,40,.35)}
.tile{position:relative;width:${DOCK.tile}px;height:${DOCK.tile}px}
.tile img{display:block;width:100%;height:100%}
.art{width:100%;height:100%;border-radius:13px;display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 .6px rgba(255,255,255,.25),0 2px 4px rgba(0,0,0,.28)}
.art svg{width:30px;height:30px}
.dot{position:absolute;left:50%;bottom:-5px;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:rgba(255,255,255,.9)}
</style>
<div class="wall"></div><div class="ribbon r1"></div><div class="ribbon r2"></div>
<svg class="grain" width="${output.width}" height="${output.height}"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>
<div class="shadow"></div>
${isPlain(script) ? "" : `<div class="menubar"><div class="left">${g.apple}<b>${esc(bar.appName)}</b>${menus}</div>
<div class="right">${g.control}${g.search}${g.wifi}<div class="battery"><div class="body"><i></i></div><div class="nub"></div></div><span>${esc(bar.clock)}</span></div></div>`}
${dockHtml}`;
}

/** Pull the real app icons out of the macOS system apps. Empty on other platforms. */
function extractSystemIcons(dir: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (process.platform !== "darwin") return out;
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const app = SYSTEM_APPS[name];
    if (!app) throw new Error(`unknown dock app "${name}". Known: ${Object.keys(SYSTEM_APPS).join(", ")}`);
    const plist = spawnSync("defaults", ["read", `${app}/Contents/Info`, "CFBundleIconFile"], { encoding: "utf8" });
    const base = plist.status === 0 ? plist.stdout.trim().replace(/\.icns$/, "") : "";
    const resources = path.join(app, "Contents", "Resources");
    let icns = base ? path.join(resources, `${base}.icns`) : "";
    if (!icns || !fs.existsSync(icns)) icns = fs.existsSync(resources) ? fs.readdirSync(resources).filter((f) => f.endsWith(".icns")).map((f) => path.join(resources, f))[0] ?? "" : "";
    if (!icns) continue;
    const png = path.join(dir, `${name}.png`);
    if (spawnSync("sips", ["-s", "format", "png", "-Z", "256", icns, "--out", png], { stdio: "ignore" }).status === 0) out[name] = pathToFileURL(png).href;
  }
  return out;
}

/** Rasterise the desktop to `outPng` (1920x1080 or whatever the script's output size is). */
export async function renderBackdrop(script: DemoScript, layout: Layout, buildDir: string, outPng: string): Promise<void> {
  fs.mkdirSync(buildDir, { recursive: true });
  const htmlPath = path.join(buildDir, "backdrop.html");
  const iconFile = script.look.appIcon ? path.resolve(projectRoot, script.look.appIcon) : null;
  if (iconFile && !fs.existsSync(iconFile)) throw new Error(`look.appIcon not found: ${iconFile}`);
  const real = extractSystemIcons(path.join(buildDir, "icons"), dockAppsFor(script));
  fs.writeFileSync(htmlPath, backdropHtml(script, layout, iconFile ? pathToFileURL(iconFile).href : null, real));
  const { _electron: electron } = await import("@playwright/test");
  const executablePath = process.env.ELECTRON_PATH || (await import("electron")).default;
  const here = path.dirname(new URL(import.meta.url).pathname);
  const args = [path.join(here, "backdrop-main.cjs"), htmlPath, outPng, String(script.output.width), String(script.output.height)];
  if (process.platform === "linux") args.unshift("--no-sandbox");
  const app = await electron.launch({ executablePath: executablePath as string, args });
  try {
    await new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = () => (fs.existsSync(outPng) && Date.now() - started > 800) || Date.now() - started > 20000 ? resolve() : setTimeout(tick, 200);
      tick();
    });
  } finally {
    await app.close().catch(() => {});
  }
  if (!fs.existsSync(outPng)) throw new Error("backdrop render produced no image");
}
