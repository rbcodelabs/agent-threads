/**
 * One entry point for the whole pipeline, honouring environment.record in the config.
 *
 *   node demo/engine/run.mts doctor|voiceover|record|compose|sync-report|all [--keep-remote]
 *
 *   voiceover   this machine (ElevenLabs, or a silent timed track)
 *   record      environment.record.runner: "local" (this machine, Linux) or "ssh" (a Linux host)
 *   compose     this machine (ffmpeg + Electron; a Mac gives the real system font and icons)
 *   all         voiceover -> record -> compose
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { configPath, demoDir, engineDir, outDir, projectRoot, rawDir } from "./lib/paths.mts";
import { loadScript, type DemoScript } from "./lib/script.mts";

const KEEP_REMOTE = process.argv.includes("--keep-remote");
const command = process.argv[2] ?? "all";

const self = (file: string) => path.join(engineDir, file);
const configArg = ["--config", configPath];

function runLocal(file: string, extra: string[] = []): void {
  const result = spawnSync(process.execPath, [self(file), ...configArg, ...extra], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${file} exited with ${result.status}`);
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run a script on the remote host through a login-less bash, fed over stdin so nothing needs quoting. */
function ssh(host: string, script: string): void {
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", host, "bash", "-s"], { input: script, stdio: ["pipe", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`remote command failed on ${host} (exit ${result.status})`);
}

function recordRemote(script: DemoScript): void {
  const rec = script.environment!.record!;
  const host = rec.host!;
  const reach = spawnSync("ssh", ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", host, "true"], { stdio: "pipe", encoding: "utf8" });
  if (reach.status !== 0) {
    throw new Error(
      `cannot reach "${host}" over ssh (${(reach.stderr || "").trim().split("\n").pop()}). Fix access (for example unlock your SSH agent), ` +
        `or set environment.record.runner to "local" on a Linux machine. Nothing was recorded.`,
    );
  }
  const remoteBase = rec.remoteDir!.replace(/\/+$/, "");
  const remoteProject = `${remoteBase}/project`;
  const relDemo = path.relative(projectRoot, demoDir) || ".";
  const relEngine = path.relative(projectRoot, engineDir);
  const relConfig = path.relative(projectRoot, configPath);
  const init = rec.shellInit ? `${rec.shellInit}\n` : "";

  console.log(`record: syncing ${projectRoot} -> ${host}:${remoteProject}`);
  ssh(host, `mkdir -p ${remoteProject}`);
  const excludes = ["node_modules", ".git", `${relDemo}/out/raw`, `${relDemo}/out/build`, `${relDemo}/out/sync`, ...(rec.syncExclude ?? [])];
  const rsync = spawnSync("rsync", ["-a", ...excludes.flatMap((e) => ["--exclude", e]), `${projectRoot}/`, `${host}:${remoteProject}/`], { stdio: "inherit" });
  if (rsync.status !== 0) throw new Error("rsync to the remote host failed");

  const setup = (rec.setup ?? []).join("\n");
  console.log(`record: running on ${host}`);
  ssh(
    host,
    `set -e\n${init}cd ${remoteProject}\n` +
      // The engine's own dependencies (Playwright). Skip install scripts: the Electron download is only needed to compose.
      `npm install --prefix ${shq(relEngine)} --ignore-scripts --no-audit --no-fund >/dev/null\n${setup}\n` +
      `rm -rf ${shq(relDemo + "/out/raw")}\nnode ${shq(relEngine + "/record.mts")} --config ${shq(relConfig)}\n`,
  );

  console.log("record: fetching the recording");
  fs.mkdirSync(rawDir, { recursive: true });
  const fetch = spawnSync("rsync", ["-a", `${host}:${remoteProject}/${relDemo}/out/raw/`, `${rawDir}/`], { stdio: "inherit" });
  if (fetch.status !== 0) throw new Error("could not fetch the recording from the remote host");
  if (!KEEP_REMOTE) ssh(host, `rm -rf ${remoteBase}`);
}

function record(script: DemoScript): void {
  const rec = script.environment?.record;
  if (!rec || rec.runner === "local") return runLocal("record.mts");
  recordRemote(script);
}

function main(): void {
  const script = loadScript(configPath);
  fs.mkdirSync(outDir, { recursive: true });
  switch (command) {
    case "doctor":
      return runLocal("doctor.mts");
    case "voiceover":
      return runLocal("voiceover.mts");
    case "record":
      return record(script);
    case "compose":
      return runLocal("compose.mts");
    case "sync-report":
      return runLocal("sync-report.mts");
    case "all":
      runLocal("voiceover.mts");
      record(script);
      runLocal("compose.mts");
      return runLocal("sync-report.mts");
    default:
      throw new Error(`unknown command "${command}". Use doctor, voiceover, record, compose, sync-report or all.`);
  }
}

try {
  main();
} catch (err) {
  console.error(`run failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
