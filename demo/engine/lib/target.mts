/**
 * Launches whatever the demo drives (target.type in the config) on the given X
 * display and hands back a Playwright Page. Both kinds end up as a Page, so the
 * recorder's actions work identically for an Electron app and a web app.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import type { TargetConfig } from "./script.mts";

export interface LaunchContext {
  display: string;
  width: number;
  height: number;
  projectRoot: string;
  userDataDir: string;
  /** Throwaway copy of target.fixture, or "" when the target has none. */
  fixtureDir: string;
}

export interface LaunchedTarget {
  page: Page;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** {{fixture}} and {{userData}} placeholders, in strings and nested JSON values. */
export function fill<T>(value: T, ctx: Pick<LaunchContext, "fixtureDir" | "userDataDir">): T {
  if (typeof value === "string") return value.replaceAll("{{fixture}}", ctx.fixtureDir).replaceAll("{{userData}}", ctx.userDataDir) as T;
  if (Array.isArray(value)) return value.map((v) => fill(v, ctx)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, ctx)])) as T;
  return value;
}

/** Copy the fixture into a fresh folder and write the user-data files. Returns nothing; paths come from ctx. */
export function prepareFixtures(target: TargetConfig, ctx: LaunchContext): void {
  if (target.fixture && ctx.fixtureDir) {
    const source = path.resolve(ctx.projectRoot, target.fixture.source);
    if (!fs.existsSync(source)) throw new Error(`target.fixture.source not found: ${source}`);
    const skip = new Set(target.fixture.exclude ?? []);
    fs.cpSync(source, ctx.fixtureDir, { recursive: true, filter: (file) => !path.relative(source, file).split(path.sep).some((part) => skip.has(part)) });
  }
  for (const [name, contents] of Object.entries(target.userDataFiles ?? {})) {
    fs.writeFileSync(path.join(ctx.userDataDir, name), typeof contents === "string" ? fill(contents, ctx) : JSON.stringify(fill(contents, ctx)));
  }
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${url} did not respond within ${Math.round(timeoutMs / 1000)}s`);
}

export async function launchTarget(target: TargetConfig, ctx: LaunchContext): Promise<LaunchedTarget> {
  // Loaded here so the pure helpers above stay importable (and testable) without Playwright installed.
  const { _electron: electron, chromium } = await import("@playwright/test");
  const readyTimeout = target.readyTimeoutMs ?? 30_000;
  if (target.type === "electron") {
    const appDir = path.resolve(ctx.projectRoot, target.app ?? ".");
    if (!fs.existsSync(path.join(ctx.projectRoot, "node_modules", "electron", "dist"))) {
      throw new Error("The Electron binary is missing. Run `npm install` (or `node node_modules/electron/install.js`).");
    }
    // Launch the product's own Electron, not whichever one the engine's dependencies installed.
    const executablePath = createRequire(path.join(ctx.projectRoot, "package.json"))("electron") as string;
    const app = await electron.launch({
      executablePath,
      args: [appDir, `--user-data-dir=${ctx.userDataDir}`, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", ...fill(target.args ?? [], ctx)],
      cwd: ctx.projectRoot,
      env: { ...process.env, ...fill(target.env ?? {}, ctx), DISPLAY: ctx.display },
    });
    const page = await app.firstWindow();
    // Fixed frame: exactly the capture size at the display origin, so framing is deterministic.
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
      win.show();
      win.focus();
    }, { width: ctx.width, height: ctx.height });
    await page.waitForSelector(target.readySelector, { timeout: readyTimeout });
    return { page, close: () => app.close().catch(() => {}) };
  }

  // web
  let server: ChildProcess | null = null;
  if (target.startCommand) {
    server = spawn(target.startCommand, { cwd: ctx.projectRoot, shell: true, detached: true, stdio: "ignore", env: { ...process.env, ...fill(target.env ?? {}, ctx) } });
    await waitForUrl(target.url!, Math.max(readyTimeout, 60_000));
  }
  const context = await chromium.launchPersistentContext(ctx.userDataDir, {
    headless: false,
    viewport: null,
    env: { ...process.env, DISPLAY: ctx.display },
    args: [`--app=${target.url}`, "--window-position=0,0", `--window-size=${ctx.width},${ctx.height}`, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  await page.waitForSelector(target.readySelector, { timeout: readyTimeout });
  return {
    page,
    close: async () => {
      await context.close().catch(() => {});
      if (server?.pid) {
        try {
          process.kill(-server.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    },
  };
}
