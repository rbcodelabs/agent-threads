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

/**
 * Image built from `sandbox/Dockerfile.harness`. Distinct from
 * `DEFAULT_VM_IMAGE` so shipping this ADR's code changes nothing for any
 * existing user until they explicitly opt in by building it (ADR-0015 §7).
 */
export const DEFAULT_HARNESS_VM_IMAGE = 'claude-threads-harness:1';

/** Where the native installer puts `claude` for the non-root `node` user inside the harness image. */
export const CLAUDE_CONTAINER_BINARY_PATH = '/home/node/.local/bin/claude';

export interface HarnessVmCapability {
  capable: boolean;
  /** Populated when `capable` is false — surfaced in Settings so "why isn't this using the VM" is self-diagnosing (ADR-0015 §7). */
  reason?: string;
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
    return { capable: false, reason: `Requires macOS on Apple silicon (found ${platform}/${arch}).` };
  }

  const probe = await params.vmManager.probe();
  if (!probe.available) {
    return { capable: false, reason: probe.error ?? 'The container CLI is unavailable.' };
  }

  const hasImage = await params.vmManager.imageExists(params.image);
  if (!hasImage) {
    return {
      capable: false,
      reason: `Harness image "${params.image}" was not found. Build it with `
        + `\`container build --tag ${params.image} -f sandbox/Dockerfile.harness sandbox/\`.`,
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
}

export interface ResolvedClaudeVmRouting {
  containerName: string;
  containerBinaryPath: string;
}

/**
 * Decided once per session `start()` — never re-evaluated mid-session
 * (ADR-0015 §7's backward-compatibility rule: a running host process is left
 * alone; new routing takes effect on the thread's *next* fresh session start).
 *
 * Returns `{ routed: false }` for a silent host fallback (`'never'`, or
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
): Promise<{ routed: true; routing: ResolvedClaudeVmRouting } | { routed: false }> {
  if (inputs.mode === 'never') return { routed: false };

  const capability = await checkHarnessVmCapability({ vmManager: inputs.vmManager, image: inputs.image });
  if (!capability.capable) {
    if (inputs.mode === 'always') {
      throw new Error(`harnessVmMode is "always" but the sandbox VM is not ready: ${capability.reason}`);
    }
    return { routed: false };
  }

  const entered = await inputs.vmManager.ensureHarnessContainer({
    image: inputs.image,
    mountPath: inputs.mountPath,
    network: 'default',
  });
  if (!entered.success) {
    if (inputs.mode === 'always') {
      throw new Error(`harnessVmMode is "always" but the sandbox container could not be started: ${entered.error}`);
    }
    console.warn(`[ClaudeThreads] harnessVmMode "auto": falling back to host-local Claude spawn — ${entered.error}`);
    return { routed: false };
  }

  return {
    routed: true,
    routing: {
      containerName: entered.containerName,
      containerBinaryPath: inputs.containerBinaryPath ?? CLAUDE_CONTAINER_BINARY_PATH,
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
