/**
 * Builds the window's rounded-corner mask with ffmpeg and the desktop backdrop
 * (see backdrop.mts) around it. Output lands in demo/out/build.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runFfmpeg } from "./ffmpeg.mts";
import { renderBackdrop } from "./backdrop.mts";
import { computeLayout } from "./layout.mts";
import type { DemoScript } from "./script.mts";

export interface BuiltAssets {
  backdrop: string;
  mask: string;
}

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
];
const BOLD_FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
];

export function findFont(kind: "regular" | "bold"): string | null {
  const fromEnv = kind === "regular" ? process.env.DEMO_FONT : process.env.DEMO_FONT_BOLD;
  const candidates = [fromEnv, ...(kind === "regular" ? FONT_CANDIDATES : BOLD_FONT_CANDIDATES)];
  return candidates.find((file): file is string => !!file && fs.existsSync(file)) ?? null;
}

/** Escape text for use inside a drawtext `text='...'` option. */
export function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
}

/** Anti-aliased rounded-rectangle coverage (0..1) centred in a w x h image, as a geq expression. */
export function roundedRectCoverage(w: number, h: number, radius: number, cx = w / 2, cy = h / 2): string {
  const hx = w / 2 - radius;
  const hy = h / 2 - radius;
  return `clip(${radius}-hypot(max(abs(X-${cx})-${hx},0),max(abs(Y-${cy})-${hy},0))+0.5,0,1)`;
}

async function singleFrame(args: string[], out: string, label: string): Promise<void> {
  await runFfmpeg([...args, "-frames:v", "1", out], label);
}

export async function buildAssets(script: DemoScript, buildDir: string): Promise<BuiltAssets> {
  fs.mkdirSync(buildDir, { recursive: true });
  const layout = computeLayout(script);
  const p = (name: string) => path.join(buildDir, name);

  await singleFrame(
    [
      "-f", "lavfi", "-i", `color=c=black:s=${layout.windowW}x${layout.windowH}:d=1`,
      "-vf", `format=gray,geq=lum='255*${roundedRectCoverage(layout.windowW, layout.windowH, layout.radius)}'`,
    ],
    p("mask.png"),
    "window mask",
  );

  await renderBackdrop(script, layout, buildDir, p("backdrop.png"));
  return { backdrop: p("backdrop.png"), mask: p("mask.png") };
}
