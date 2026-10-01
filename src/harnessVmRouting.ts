/**
 * harnessVmRouting.ts — ADR-0015: routes the Claude harness's own CLI process
 * inside the thread's sandbox container instead of spawning it on the host.
 *
 * Kept separate from `sandboxVm.ts` (which owns the container runtime
 * primitives shared with the agent-facing `enter_vm`/`vm_exec`/`exit_vm`
 * tools) and from `ThreadSession.ts` (which only needs the resolved routing
 * decision, not how it was reached) so each piece stays independently
 * testable without a live `container` runtime or a mocked Agent SDK.
 */
import type { SandboxVmManager } from './sandboxVm';
import { buildHarnessExecArgs, VM_WORKDIR } from './sandboxVm';
import type { HarnessVmMode } from './types';
import type { SkillMountPlan, VmExtraMount } from './skillMounts';

/**
 * Image built from `sandbox/Dockerfile.harness`. Distinct from
 * `DEFAULT_VM_IMAGE` so shipping this ADR's code changes nothing for any
 * existing user until they explicitly opt in by building it (ADR-0015 §7).
 */
export const DEFAULT_HARNESS_VM_IMAGE = 'claude-threads-harness:1';

/** Where the native installer puts `claude` for the non-root `node` user inside the harness image. */
export const CLAUDE_CONTAINER_BINARY_PATH = '/home/node/.local/bin/claude';

/**
 * Machine-readable twin of {@link HarnessVmCapability.reason}, so callers can
 * decide what to DO about a failure (offer to set the sandbox up) instead of
 * pattern-matching free text.
 *
 * - `unsupported`     — not macOS on Apple silicon; nothing the user can set up.
 * - `runtime-missing` — the `container` CLI cannot be run at all.
 * - `runtime-stopped` — the CLI runs but its system service is not running.
 * - `image-missing`   — runtime is up but the harness image does not exist.
 */
export type HarnessVmCapabilityCode = 'unsupported' | 'runtime-missing' | 'runtime-stopped' | 'image-missing';

/**
 * Why `resolveClaudeVmRouting` returned `{ routed: false }`: every capability
 * code, plus `never` (mode is `'never'`) and `start-failed` (capable, but the
 * container itself would not start — setting the sandbox up again won't help).
 */
export type HarnessVmFallbackReason = HarnessVmCapabilityCode | 'never' | 'start-failed';

/** Fallbacks the user can fix by running the sandbox setup (drives the in-thread offer). */
export const SANDBOX_SETUP_FIXABLE_REASONS: readonly HarnessVmFallbackReason[] = [
  'runtime-missing', 'runtime-stopped', 'image-missing',
];

export interface HarnessVmCapability {
  capable: boolean;
  /** Populated when `capable` is false — surfaced in Settings so "why isn't this using the VM" is self-diagnosing (ADR-0015 §7). */
  reason?: string;
  /** Structured form of `reason`; populated exactly when `capable` is false. */
  code?: HarnessVmCapabilityCode;
}

/**
 * The three checks ADR-0015 §7 requires for `'auto'` mode, run in the cheapest
 * order first: an OS/arch check that costs nothing, then a CLI probe, then an
 * image-existence check that shells out again. Exposed standalone (not only
 * folded into `resolveClaudeVmRouting`) so Settings can show which one fails.
 */
export async function checkHarnessVmCapability(params: {
  vmManager: SandboxVmManager;
  image: string;
  platform?: string;
  arch?: string;
}): Promise<HarnessVmCapability> {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  if (platform !== 'darwin' || arch !== 'arm64') {
    return { capable: false, code: 'unsupported', reason: `Requires macOS on Apple silicon (found ${platform}/${arch}).` };
  }

  const probe = await params.vmManager.probe();
  if (!probe.available) {
    return { capable: false, code: 'runtime-missing', reason: probe.error ?? 'The container CLI is unavailable.' };
  }

  const hasImage = await params.vmManager.imageExists(params.image);
  if (!hasImage) {
    // `image inspect` also fails while the system service is down, so tell the
    // two apart — they need different fixes (start vs. pull/build).
    if (!(await params.vmManager.systemRunning())) {
      return {
        capable: false,
        code: 'runtime-stopped',
        reason: 'The container runtime is installed but not running. Start it from Settings → Claude → '
          + 'Set up sandbox, or run `container system start`.',
      };
    }
    return {
      capable: false,
      code: 'image-missing',
      reason: `Harness image "${params.image}" was not found. Set it up from Settings → Claude → Set up sandbox, `
        + `or build it manually with \`container build --tag ${params.image} -f sandbox/Dockerfile.harness sandbox/\`.`,
    };
  }

  return { capable: true };
}

export interface ClaudeVmRoutingInputs {
  mode: HarnessVmMode;
  image: string;
  /** Per-thread manager, shared with this thread's enter_vm/vm_exec/exit_vm tools (ADR-0015 §3: one container per thread). */
  vmManager: SandboxVmManager;
  /** Host directory to bind-mount at /work — normally the thread's own cwd. */
  mountPath: string;
  containerBinaryPath?: string;
  /**
   * Skill mounts to give the container at creation (read-only; see
   * `planSkillMounts`). Both this and the sign-in path build the same inputs,
   * so whichever starts the container first creates it with the right mounts.
   */
  skillMountPlan?: SkillMountPlan;
  /** Test-only overrides forwarded to checkHarnessVmCapability; production callers omit these and get the real process.platform/arch. */
  platform?: string;
  arch?: string;
}

export interface ResolvedClaudeVmRouting {
  containerName: string;
  containerBinaryPath: string;
  /** Extra read-only mounts the container really has (may differ from the request when an older container was kept). */
  mountedExtra: VmExtraMount[];
}

/**
 * Decided once per session `start()` — never re-evaluated mid-session
 * (ADR-0015 §7's backward-compatibility rule: a running host process is left
 * alone; new routing takes effect on the thread's *next* fresh session start).
 *
 * Returns `{ routed: false, reason }` for a silent host fallback (`'never'`, or
 * `'auto'` with a failed capability check or container-start failure) and
 * THROWS only for `'always'` mode's explicit no-silent-fallback contract.
 *
 * Hardcodes full-egress (`'default'`) networking for the container this
 * starts, regardless of `vmDefaultNetwork` — the containerized `claude`
 * process needs to reach Anthropic's API to do anything at all, so an
 * `'internal'`/`'none'` sandbox default would silently break every VM-routed
 * thread. If the agent later calls `enter_vm` for the same thread, it attaches
 * to this same shared container (ADR-0015 §3) rather than renegotiating the
 * network mode.
 */
export async function resolveClaudeVmRouting(
  inputs: ClaudeVmRoutingInputs,
): Promise<{ routed: true; routing: ResolvedClaudeVmRouting } | { routed: false; reason: HarnessVmFallbackReason }> {
  if (inputs.mode === 'never') return { routed: false, reason: 'never' };

  const capability = await checkHarnessVmCapability({
    vmManager: inputs.vmManager,
    image: inputs.image,
    platform: inputs.platform,
    arch: inputs.arch,
  });
  if (!capability.capable) {
    if (inputs.mode === 'always') {
      throw new Error(`harnessVmMode is "always" but the sandbox VM is not ready: ${capability.reason}`);
    }
    return { routed: false, reason: capability.code ?? 'runtime-missing' };
  }

  const entered = await inputs.vmManager.ensureHarnessContainer({
    image: inputs.image,
    mountPath: inputs.mountPath,
    network: 'default',
    extraMounts: inputs.skillMountPlan?.mounts,
  });
  if (!entered.success) {
    if (inputs.mode === 'always') {
      throw new Error(`harnessVmMode is "always" but the sandbox container could not be started: ${entered.error}`);
    }
    console.warn(`[ClaudeThreads] harnessVmMode "auto": falling back to host-local Claude spawn — ${entered.error}`);
    return { routed: false, reason: 'start-failed' };
  }

  return {
    routed: true,
    routing: {
      containerName: entered.containerName,
      containerBinaryPath: inputs.containerBinaryPath ?? CLAUDE_CONTAINER_BINARY_PATH,
      mountedExtra: entered.extraMounts ?? [],
    },
  };
}

/**
 * Builds the host-side `container exec` argv for the containerized Claude CLI
 * process, given the SDK's own `SpawnOptions`. Secrets ride `--env` flags
 * scoped to this ONE exec invocation only — never the host spawn's own `env:`
 * object, and never `container run` (ADR-0015 §4's hard requirement: a
 * `vm_exec` call in the same shared container must never see these values).
 */
export function buildHarnessSpawnArgs(params: {
  containerName: string;
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}): string[] {
  return buildHarnessExecArgs({
    containerName: params.containerName,
    command: params.command,
    args: params.args,
    env: params.env,
    workdir: VM_WORKDIR,
  });
}

/**
 * Redacts secret VALUES from a logged argv by content match, never by index.
 * A positional slice (`args.slice(0, 4)`) is exactly the bug the ADR-0015
 * spike hit: it silently stopped redacting the moment the real argv shape
 * diverged from what the slice assumed, leaking a live OAuth token into a
 * session transcript. Matching on the actual secret value degrades gracefully
 * instead — an argv shape change can only ever under-redact a value that
 * wasn't a secret in the first place, never mis-redact by position.
 */
export function redactSecretsInArgv(argv: string[], secrets: Iterable<string | undefined>): string[] {
  const values = [...secrets].filter((v): v is string => !!v && v.length > 0);
  if (values.length === 0) return argv;
  return argv.map((arg) => {
    let redacted = arg;
    for (const secret of values) {
      if (redacted.includes(secret)) redacted = redacted.split(secret).join('<redacted>');
    }
    return redacted;
  });
}
