/**
 * Where things live. The engine is vendored into a product repo as `demo/engine/`,
 * next to `demo/demo.config.json`. Everything is resolved from the config file's
 * folder, so the same engine serves any product.
 *
 *   --config <file>   or DEMO_CONFIG=<file>   (default: demo/demo.config.json)
 *   DEMO_PROJECT_ROOT=<dir>                   (default: the folder above the config)
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function configFromArgs(): string | undefined {
  const i = process.argv.indexOf("--config");
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const configPath = path.resolve(configFromArgs() ?? process.env.DEMO_CONFIG ?? path.join(engineDir, "..", "demo.config.json"));
export const demoDir = path.dirname(configPath);
export const projectRoot = path.resolve(process.env.DEMO_PROJECT_ROOT ?? path.join(demoDir, ".."));
export const outDir = path.join(demoDir, "out");
export const cacheDir = path.join(demoDir, "cache");
export const buildDir = path.join(outDir, "build");
export const rawDir = path.join(outDir, "raw");
export const recordingPath = path.join(rawDir, "recording.mp4");
export const timelinePath = path.join(rawDir, "timeline.json");
export const voiceoverManifestPath = path.join(outDir, "voiceover.json");

/** Final video file name comes from the title: "Getting started" -> getting-started.mp4. */
export function finalVideoPathFor(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "demo";
  return path.join(outDir, `${slug}.mp4`);
}
