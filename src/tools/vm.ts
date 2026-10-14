/**
 * Sandbox VM tools (`enter_vm`, `vm_exec`, `exit_vm`). ABSENT on a daemon: the daemon machine is the sandbox.
 * Moved verbatim out of ObsidianTools.ts (one factory over a narrow port); see toolRouting.ts for where each runs.
 */

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk/browser';
import fs from 'fs';
import path from 'path';
import { createGithubVmHooks } from '../githubVmDelivery';
import { redactGithubSecrets } from '../githubCredentials';
import { SandboxVmManager, VM_NETWORK_MODES, VM_WORKDIR, containerNameForThread, isVmNetworkMode, resolveExecTimeoutSeconds, resolveVmImage, resolveVmNetwork, resolveVmMemory, resolveVmCpus, resolveExternalMounts, resolveVaultMount, mergeExtraMounts, VM_EXTERNAL_ROOT, VM_VAULT_MOUNT, type ExternalMountRootInput } from '../sandboxVm';
import type { ObsidianMcpServerOptions } from '../ObsidianTools';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CwdTracker } from './cwdTracker';

type ToolDef = SdkMcpToolDefinition<any>;

export interface VmToolsPort {
  cwd: CwdTracker;
  options: Pick<ObsidianMcpServerOptions, 'getExternalMounts' | 'getGithubCommitEmail' | 'getVaultPath' | 'getVmCpus' | 'getVmDefaultNetwork' | 'getVmImage' | 'getVmMemory' | 'githubBroker' | 'harnessInVm' | 'isGithubConnectionEnabled' | 'sandboxVmManager' | 'threadId' | 'vmCommandRunner'>;
}


export function createVmTools(port: VmToolsPort): Record<string, ToolDef> {
  const { cwd, options } = port;
  // Sandbox VM container names are derived from the thread ID so a container survives a plugin reload and can
  // still be found. With no thread ID (ad-hoc/test surfaces) fall back to a per-session random ID: two such
  // sessions must not collide on one container.
  const fallbackVmSessionId = crypto.randomUUID();
  // ── Sandbox VM tools ────────────────────────────────────────────────────────
  // A sandboxed VM for running COMMANDS only. Read/Write/Edit/Bash keep running
  // on the host, so the thread's working directory is bind-mounted into the
  // guest at /work rather than copied — file edits stay on the host and are
  // visible inside the VM immediately, with no sync step and no divergence.
  //
  // Backed by Apple's `container` CLI (macOS 26+, Apple silicon), where each
  // container is its own lightweight VM with a separate kernel and no view of
  // the host filesystem beyond that mount. See src/sandboxVm.ts for the full
  // rationale, and sandbox/Dockerfile for the image.
  //
  // The container name is derived deterministically from the thread ID, so a
  // container started before a plugin reload can still be found and cleaned up
  // afterwards without persisting anything on the Thread.

  const vmManager = options.sandboxVmManager ?? new SandboxVmManager({
    containerName: () => containerNameForThread(options.threadId ?? fallbackVmSessionId),
    run: options.vmCommandRunner,
    hooks: options.githubBroker
      ? createGithubVmHooks({
          broker: options.githubBroker,
          isEnabled: () => options.isGithubConnectionEnabled?.() ?? true,
          getEmailOverride: options.getGithubCommitEmail,
        })
      : undefined,
  });

  const vmErrorResult = (error: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error }) }],
    isError: true,
  });

  const boundEnterVm = tool(
    'enter_vm',
    [
      'Starts a sandboxed Linux VM for this thread and bind-mounts the current effective working directory into it at /work.',
      'When the host (Geode) has connected external roots, each is also mounted READ-ONLY at /ext/<label>; the result lists them under mountedExternal (label, hostPath, guestPath, readOnly).',
      'File editing stays on the host — use vm_exec to run commands inside the VM, where the container has its own kernel and cannot see the rest of the host filesystem.',
      'Requires Apple\'s container runtime (macOS 26+ on Apple silicon); desktop only.',
      'Use exit_vm to stop and remove the VM.',
      'Servers you start in the VM are reachable from the host-side browser tools via their localhost URL (forwarded automatically); do not use the VM\'s IP address.',
    ].join(' '),
    {
      image: z.string().optional().describe(
        'Container image to start. Defaults to the configured sandbox VM image (claude-threads-coding:1), built from sandbox/Dockerfile.',
      ),
      network: z.enum(VM_NETWORK_MODES as unknown as [string, ...string[]]).optional().describe(
        'Network isolation: "default" = full egress (npm install, git remotes and web all work), "internal" = no internet but host and shared-network peers remain reachable, "none" = no network at all. Defaults to the configured setting, which ships as "default".',
      ),
      mountPath: z.string().optional().describe(
        'Absolute host directory to mount at /work. Defaults to the current effective working directory.',
      ),
    },
    async (args, _extra) => {
      try {
        const mountPath = args.mountPath ?? cwd.get();
        // Native harnesses invoke handlers directly, without SDK Zod parsing.
        // An invalid requested isolation mode must never silently enable egress.
        if (args.network !== undefined && !isVmNetworkMode(args.network)) {
          return vmErrorResult('network must be default, internal, or none.');
        }
        if (!mountPath) {
          return vmErrorResult('No working directory set. Call set_working_directory first, or pass mountPath.');
        }
        if (!path.isAbsolute(mountPath)) {
          return vmErrorResult(`mountPath must be an absolute path: ${mountPath}`);
        }
        // Checked on the host before starting anything: `container run` with a
        // nonexistent --volume source fails deep in the runtime with a message
        // that does not name the path.
        if (!fs.existsSync(mountPath) || !fs.statSync(mountPath).isDirectory()) {
          return vmErrorResult(`mountPath is not an existing directory: ${mountPath}`);
        }

        // Connected Geode external roots, read-only at /ext/<label>. The host
        // method is optional and untrusted-ish: any failure means "no extras".
        let externalEntries: ExternalMountRootInput[] | null | undefined;
        try {
          externalEntries = await options.getExternalMounts?.();
        } catch (e) {
          console.error('claude-threads: listing external roots for enter_vm failed:', e);
        }
        const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
        const extraMounts = mergeExtraMounts(
          resolveExternalMounts(externalEntries, { workPath: mountPath, isDirectory: isDir }),
          resolveVaultMount(options.getVaultPath?.(), isDir),
        );

        const result = await vmManager.enter({
          image: resolveVmImage(args.image, options.getVmImage?.()),
          mountPath,
          network: resolveVmNetwork(args.network, options.getVmDefaultNetwork?.()),
          extraMounts,
          memory: resolveVmMemory(options.getVmMemory?.()),
          cpus: resolveVmCpus(options.getVmCpus?.()),
        });
        if (!result.success) return vmErrorResult(result.error);

        // Only /ext mounts are external roots; skill mounts (harness) are not.
        const vaultMounted = (result.extraMounts ?? []).some((m) => m.guestPath === VM_VAULT_MOUNT && m.readWrite);
        const mountedExternal = (result.extraMounts ?? [])
          .filter((m) => m.guestPath.startsWith(`${VM_EXTERNAL_ROOT}/`))
          .map((m) => ({
            label: m.guestPath.slice(VM_EXTERNAL_ROOT.length + 1),
            hostPath: m.hostPath,
            guestPath: m.guestPath,
            readOnly: true,
          }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              containerName: result.containerName,
              image: result.image,
              mountedFrom: result.mountedFrom,
              network: result.network,
              containerWorkdir: VM_WORKDIR,
              mountedExternal,
              ...(vaultMounted ? { vaultMount: { guestPath: VM_VAULT_MOUNT, readOnly: false } } : {}),
              ...(result.notes?.length ? { notes: result.notes } : {}),
              message: `Sandbox VM running. ${result.mountedFrom} is mounted at ${VM_WORKDIR}. Run commands with vm_exec; keep editing files with the normal file tools on the host.${
                mountedExternal.length
                  ? ` Connected external roots are mounted read-only: ${mountedExternal.map((m) => `${m.guestPath} (${m.hostPath})`).join(', ')}.`
                  : ''}${vaultMounted ? ` The vault is mounted READ-WRITE at ${VM_VAULT_MOUNT}.` : ''}`,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return vmErrorResult(msg);
      }
    },
  );

  const boundVmExec = tool(
    'vm_exec',
    [
      'Runs a shell command inside this thread\'s sandboxed VM, with the working directory set to /work (the bind-mounted host directory).',
      options.harnessInVm
        ? 'Your harness is already running inside this container; native shell and file tools use the same guest filesystem. No VM lifecycle action is needed.'
        : 'Call enter_vm first.',
      'Returns the exit code plus stdout and stderr; a non-zero exit code is reported as a normal result, not an error.',
      'Very long output is truncated with an explicit marker.',
      'To serve something for the browser tools (browser_navigate, host_open_url), start the server in the background so the command returns — e.g. `nohup python3 -m http.server 8000 >/tmp/server.log 2>&1 &` — then open http://localhost:8000/ with the browser tools: the host browser cannot see the VM\'s localhost directly, so the plugin forwards that loopback port to the host automatically (loopback only), whether the server binds 127.0.0.1 or 0.0.0.0.',
    ].join(' '),
    {
      command: z.string().min(1).describe(
        'Shell command to run inside the VM. Executed with `bash -lc` from /work.',
      ),
      timeoutSeconds: z.number().optional().describe(
        'Guest command deadline in seconds, followed by a five-second kill grace. Defaults to 300, capped at 3600. Requires GNU timeout in the image; timeout normally returns exit code 124.',
      ),
    },
    async (args, _extra) => {
      try {
        const result = await vmManager.execCommand({
          command: args.command,
          timeoutSeconds: resolveExecTimeoutSeconds(args.timeoutSeconds),
        });
        if (!result.success) return vmErrorResult(result.error);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              exitCode: result.exitCode,
              // Defense in depth: mask anything token-shaped a command echoed.
              stdout: redactGithubSecrets(result.stdout),
              stderr: redactGithubSecrets(result.stderr),
              ...(result.notes?.length ? { notes: result.notes } : {}),
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return vmErrorResult(msg);
      }
    },
  );

  const boundExitVm = tool(
    'exit_vm',
    [
      'Stops and removes this thread\'s sandboxed VM.',
      'The bind-mounted host directory and everything written into it is untouched — only the VM\'s own ephemeral root filesystem goes away.',
    ].join(' '),
    {
      force: z.boolean().optional().describe(
        'Kill the VM immediately instead of stopping it gracefully first (default: false).',
      ),
    },
    async (args, _extra) => {
      try {
        const result = await vmManager.exit({ force: args.force });
        if (!result.success) return vmErrorResult(result.error);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              removedContainer: result.removedContainer,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return vmErrorResult(msg);
      }
    },
  );


  const toolDefs: Array<ToolDef | undefined> = [
    boundEnterVm as ToolDef | undefined,
    boundVmExec as ToolDef | undefined,
    boundExitVm as ToolDef | undefined,
  ];
  const toolNames = [
    'enter_vm',
    'vm_exec',
    'exit_vm',
  ];
  return Object.fromEntries(toolNames.flatMap((name, i): Array<[string, ToolDef]> => (toolDefs[i] ? [[name, toolDefs[i]!]] : [])));
}
