/**
 * Sandbox image pipeline: get the two local images the sandbox VM needs
 * without the user building anything by hand.
 *
 *   ghcr.io/rbcodelabs/claude-threads-sandbox:<v>  (published by CI, base toolchain only)
 *        │  container image pull + tag
 *        ▼
 *   claude-threads-coding:1                        (local)
 *        │  container build (embedded harness Dockerfile)
 *        ▼
 *   claude-threads-harness:1                       (local, adds the Claude CLI)
 *
 * The published image deliberately does NOT contain the Claude CLI: Claude
 * Code has no redistribution grant, so the CLI is installed by Anthropic's own
 * installer on the user's machine during the local build step.
 *
 * Node built-ins only, lazily required, and every `container` call goes through
 * the injectable {@link VmCommandRunner} so tests need no runtime.
 */

import {
  DEFAULT_VM_IMAGE,
  VM_LIFECYCLE_TIMEOUT_MS,
  buildImageInspectArgs,
  type VmCommandResult,
  type VmCommandRunner,
} from './sandboxVm';
import { DEFAULT_HARNESS_VM_IMAGE } from './harnessVmRouting';

/**
 * Version of the published base image. MUST equal `sandbox/IMAGE_VERSION`
 * (a unit test enforces it). Bumped only when `sandbox/Dockerfile` changes;
 * decoupled from plugin releases so an image always exists before any plugin
 * that references it.
 */
export const SANDBOX_IMAGE_VERSION = '1';

export const SANDBOX_IMAGE_REPOSITORY = 'ghcr.io/rbcodelabs/claude-threads-sandbox';
export const SANDBOX_BASE_IMAGE_REF = `${SANDBOX_IMAGE_REPOSITORY}:${SANDBOX_IMAGE_VERSION}`;

/** Local tag the base image is stored under (what `sandbox/Dockerfile.harness` says `FROM`). */
export const SANDBOX_CODING_IMAGE = DEFAULT_VM_IMAGE;

/** Local tag of the harness image unless Settings overrides it. */
export const SANDBOX_HARNESS_IMAGE = DEFAULT_HARNESS_VM_IMAGE;

/** OCI label stamped on the locally built harness image so a stale one can be detected. */
export const SANDBOX_IMAGE_VERSION_LABEL = 'com.rbcodelabs.claude-threads.image-version';

/** Pulls move a few hundred MB; builds run Anthropic's installer. Both far exceed the 120 s lifecycle cap. */
export const SANDBOX_PULL_TIMEOUT_MS = 30 * 60_000;
export const SANDBOX_BUILD_TIMEOUT_MS = 20 * 60_000;
/** Build/pull output is chatty; the default 400 KB capture cap would kill the child. */
const SANDBOX_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const INSPECT_TIMEOUT_MS = 15_000;
const STDERR_TAIL_LINES = 15;

/**
 * Exact text of `sandbox/Dockerfile.harness`. Embedded because the plugin
 * ships as a single `main.js` and cannot read repo files at runtime; a unit
 * test asserts it is byte-identical to the file.
 */
export const HARNESS_DOCKERFILE = `# Harness-hosting image (ADR-0015): adds the Claude Code CLI on top of the
# existing sandboxed coding environment, so a thread's harness process can run
# INSIDE the same container that already hosts its enter_vm/vm_exec commands,
# instead of requiring \`claude\` installed on the host.
#
# Deliberately a SEPARATE, opt-in image tag from claude-threads-coding:1 rather
# than an edit to sandbox/Dockerfile in place — see ADR-0015 §7 ("Why 'auto' is
# safe to ship as the default"): harnessVmMode's capability check includes
# "does an image with the harness CLI exist", which is false for every
# existing user until they explicitly build this image. That means shipping
# this ADR's code changes nothing for anyone until they opt in.
#
# Normally built for you by Settings → Claude → Set up sandbox. To build by hand:
#   container build --tag claude-threads-harness:1 -f sandbox/Dockerfile.harness sandbox/
#
# Claude-only for now. Codex/OpenCode CLI installs are intentionally NOT added
# here — ADR-0015 sequences those after Claude (OpenCode in particular has an
# unresolved MCP-loopback-bridge gap, §5), so adding their installers before
# the adapters that route into this image would just grow build time and image
# size for capability nothing yet uses.

FROM claude-threads-coding:1

# Claude Code — native installer, matches Anthropic's own recommended install
# path (code.claude.com quickstart/setup docs, verified via Context7
# 2026-09-26) and auto-selects the linux-arm64 build for this container's
# platform. Installs to ~/.local/bin/claude for the non-root \`node\` user the
# base image already switches to.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.local/bin:\${PATH}"
`;

export type SandboxImageStep = 'inspect' | 'pull' | 'tag' | 'write' | 'build';

/** A failed pipeline step; the message names the step and carries the stderr tail. */
export class SandboxImageError extends Error {
  constructor(readonly step: SandboxImageStep, message: string) {
    super(message);
    this.name = 'SandboxImageError';
  }
}

export class SandboxImageAbortedError extends Error {
  constructor() {
    super('Sandbox image setup was cancelled.');
    this.name = 'SandboxImageAbortedError';
  }
}

export interface SandboxImageStatus {
  base: 'ok' | 'missing';
  harness: 'ok' | 'missing' | 'stale';
}

// ── Argument builders ────────────────────────────────────────────────────────

export function buildImagePullArgs(ref: string): string[] {
  // Pinned: a bare pull of a multi-platform tag unpacks every platform (observed on 1.3.1).
  return ['image', 'pull', '--platform', 'linux/arm64', ref];
}

export function buildImageTagArgs(source: string, target: string): string[] {
  return ['image', 'tag', source, target];
}

export function buildHarnessBuildArgs(opts: { harnessImage: string; dockerfilePath: string; contextDir: string }): string[] {
  return [
    'build',
    '--tag', opts.harnessImage,
    '--label', `${SANDBOX_IMAGE_VERSION_LABEL}=${SANDBOX_IMAGE_VERSION}`,
    '--progress', 'plain',
    '-f', opts.dockerfilePath,
    opts.contextDir,
  ];
}

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * Reads the image-version label out of `container image inspect` JSON. The
 * runtime returns an array whose entries hold per-platform `variants`, each
 * with an OCI config; the label lives at `variants[].config.config.Labels`.
 * Returns null for anything unparseable rather than throwing.
 */
export function parseImageVersionLabel(inspectStdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectStdout);
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    const variants = (entry as { variants?: unknown })?.variants;
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const labels = (variant as { config?: { config?: { Labels?: Record<string, unknown> | null } } })
        ?.config?.config?.Labels;
      const value = labels?.[SANDBOX_IMAGE_VERSION_LABEL];
      if (typeof value === 'string') return value;
    }
  }
  return null;
}

export async function getSandboxImageStatus(
  runner: VmCommandRunner,
  harnessImage: string = SANDBOX_HARNESS_IMAGE,
): Promise<SandboxImageStatus> {
  const base = await runner(buildImageInspectArgs(SANDBOX_CODING_IMAGE), { timeoutMs: INSPECT_TIMEOUT_MS });
  const harnessResult = await runner(buildImageInspectArgs(harnessImage), { timeoutMs: INSPECT_TIMEOUT_MS });
  let harness: SandboxImageStatus['harness'];
  if (harnessResult.exitCode !== 0) harness = 'missing';
  else harness = parseImageVersionLabel(harnessResult.stdout) === SANDBOX_IMAGE_VERSION ? 'ok' : 'stale';
  return { base: base.exitCode === 0 ? 'ok' : 'missing', harness };
}

// ── Ensure ───────────────────────────────────────────────────────────────────

export interface EnsureSandboxImagesOptions {
  runner: VmCommandRunner;
  /** Harness image tag to build; Settings can override the default. */
  harnessImage?: string;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

export interface EnsureSandboxImagesResult {
  pulledBase: boolean;
  builtHarness: boolean;
}

function stderrTail(result: VmCommandResult): string {
  const text = (result.stderr.trim() || result.stdout.trim());
  if (!text) return '(no output)';
  return text.split('\n').slice(-STDERR_TAIL_LINES).join('\n');
}

function failure(step: SandboxImageStep, what: string, result: VmCommandResult): SandboxImageError {
  return new SandboxImageError(step, `${what} failed (exit ${result.exitCode}):\n${stderrTail(result)}`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SandboxImageAbortedError();
}

async function runEnsure(opts: EnsureSandboxImagesOptions, harnessImage: string): Promise<EnsureSandboxImagesResult> {
  const { runner, onProgress, signal } = opts;
  const result: EnsureSandboxImagesResult = { pulledBase: false, builtHarness: false };
  const longRun = { onOutput: onProgress, maxBufferBytes: SANDBOX_MAX_BUFFER_BYTES, signal };

  throwIfAborted(signal);
  const status = await getSandboxImageStatus(runner, harnessImage);

  // (a) Base image. A locally present claude-threads-coding:1 is always kept —
  // it may be the user's own build.
  if (status.base === 'missing') {
    onProgress?.(`Pulling ${SANDBOX_BASE_IMAGE_REF}…`);
    const pull = await runner(buildImagePullArgs(SANDBOX_BASE_IMAGE_REF), { timeoutMs: SANDBOX_PULL_TIMEOUT_MS, ...longRun });
    throwIfAborted(signal);
    if (pull.exitCode !== 0) {
      throw failure('pull', `Pulling ${SANDBOX_BASE_IMAGE_REF}`, pull);
    }
    const tag = await runner(buildImageTagArgs(SANDBOX_BASE_IMAGE_REF, SANDBOX_CODING_IMAGE), { timeoutMs: VM_LIFECYCLE_TIMEOUT_MS, signal });
    throwIfAborted(signal);
    if (tag.exitCode !== 0) {
      throw failure('tag', `Tagging ${SANDBOX_BASE_IMAGE_REF} as ${SANDBOX_CODING_IMAGE}`, tag);
    }
    result.pulledBase = true;
  }

  // (b) Harness layer, only when missing or built for another image version.
  if (status.harness === 'ok') return result;

  onProgress?.(`Building ${harnessImage} (installs the Claude CLI)…`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs/promises') as typeof import('fs/promises');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');

  let dir: string | null = null;
  try {
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-threads-harness-'));
      await fs.writeFile(path.join(dir, 'Dockerfile'), HARNESS_DOCKERFILE, 'utf8');
    } catch (err) {
      throw new SandboxImageError('write', `Writing the harness Dockerfile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    throwIfAborted(signal);
    const build = await runner(
      buildHarnessBuildArgs({ harnessImage, dockerfilePath: path.join(dir, 'Dockerfile'), contextDir: dir }),
      { timeoutMs: SANDBOX_BUILD_TIMEOUT_MS, ...longRun },
    );
    throwIfAborted(signal);
    if (build.exitCode !== 0) {
      throw failure('build', `Building ${harnessImage}`, build);
    }
    result.builtHarness = true;
    return result;
  } finally {
    // (c) Best-effort: a leftover temp dir is harmless, a thrown cleanup error would mask the real one.
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

let inFlight: { key: string; promise: Promise<EnsureSandboxImagesResult> } | null = null;

/**
 * Makes sure `claude-threads-coding:1` and the harness image exist and are
 * current. Idempotent (a no-op when both are present and current), abortable,
 * and safe under concurrent calls: an identical call joins the running one; a
 * call for a different harness image waits for it first.
 */
export async function ensureSandboxImages(opts: EnsureSandboxImagesOptions): Promise<EnsureSandboxImagesResult> {
  const harnessImage = opts.harnessImage ?? SANDBOX_HARNESS_IMAGE;
  while (inFlight) {
    if (inFlight.key === harnessImage) return inFlight.promise;
    await inFlight.promise.catch(() => undefined);
  }
  const promise = runEnsure(opts, harnessImage);
  const entry = { key: harnessImage, promise };
  inFlight = entry;
  try {
    return await promise;
  } finally {
    if (inFlight === entry) inFlight = null;
  }
}
