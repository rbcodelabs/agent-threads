/**
 * Tests for the enter_vm / vm_exec / exit_vm MCP tools.
 *
 * Drives the real tool handlers registered on the canonical server, with the
 * container CLI mocked through `vmCommandRunner`. Covers the wiring the manager
 * tests cannot see: schema shape, host-side mountPath validation, settings
 * fallbacks, the tool result envelope, and the mobile-safety contract that a
 * missing CLI produces a clean error result instead of a thrown exception.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name, description, inputSchema, handler,
  }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers, type ObsidianMcpServerOptions } from '../../src/ObsidianTools';
import {
  DEFAULT_VM_IMAGE,
  VM_INTERNAL_NETWORK_NAME,
  VM_WORKDIR,
  VmUnavailableError,
  containerNameForThread,
  type VmCommandResult,
  type VmCommandRunner,
} from '../../src/sandboxVm';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

const THREAD_ID = 'thread-vm-1';
const NAME = containerNameForThread(THREAD_ID);

/** A real directory, since enter_vm validates the mount source on the host. */
const MOUNT = fs.realpathSync(os.tmpdir());

type Scripted = Partial<VmCommandResult> | Error;

function makeRunner(script: Record<string, Scripted> = {}) {
  const calls: string[][] = [];
  const run: VmCommandRunner = async (args) => {
    calls.push([...args]);
    const entry = script[args.join(' ')];
    if (entry instanceof Error) throw entry;
    return { exitCode: 0, stdout: '', stderr: '', ...(entry ?? {}) };
  };
  return { run, calls, argvs: () => calls.map((c) => c.join(' ')) };
}

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

function vmTools(options: ObsidianMcpServerOptions) {
  const server = createClaudeThreadsMcpServers(app, {
    threadId: THREAD_ID,
    initialCwd: MOUNT,
    ...options,
  }).claude_threads as unknown as { tools: ToolDef[] };
  const get = (name: string) => server.tools.find((t) => t.name === name)!;
  return { all: server.tools, enter: get('enter_vm'), exec: get('vm_exec'), exit: get('exit_vm') };
}

/** Script fragment for "CLI works, no container yet". */
const CLI_OK_NO_CONTAINER: Record<string, Scripted> = {
  '--version': { stdout: 'container CLI version 1.3.1\n' },
  [`inspect ${NAME}`]: { exitCode: 1, stderr: 'not found' },
};

async function call(definition: ToolDef, args: Record<string, unknown>) {
  const result = await definition.handler(args, {});
  return { isError: result.isError === true, payload: JSON.parse(result.content[0]!.text) };
}

// ── Registration ─────────────────────────────────────────────────────────────

describe('sandbox VM tools — registration', () => {
  it('registers all three tools on both the canonical and compatibility servers', () => {
    const servers = createClaudeThreadsMcpServers(app);
    const names = (key: 'claude_threads' | 'obsidian') =>
      (servers[key] as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name);

    for (const name of ['enter_vm', 'vm_exec', 'exit_vm']) {
      // Deliberately NOT in LEGACY_TO_CANONICAL_TOOL_NAMES: the same name on
      // both servers, so there is nothing to rename or deprecate.
      expect(names('claude_threads'), name).toContain(name);
      expect(names('obsidian'), name).toContain(name);
    }
  });

  it('shares one handler and schema across both servers', () => {
    const servers = createClaudeThreadsMcpServers(app);
    const find = (key: 'claude_threads' | 'obsidian', name: string) =>
      (servers[key] as unknown as { tools: ToolDef[] }).tools.find((t) => t.name === name)!;

    for (const name of ['enter_vm', 'vm_exec', 'exit_vm']) {
      expect(find('claude_threads', name).handler, name).toBe(find('obsidian', name).handler);
      expect(find('claude_threads', name).inputSchema, name).toBe(find('obsidian', name).inputSchema);
    }
  });

  it('requires approval on the native-harness path (these are not read-only)', () => {
    const canonical = createClaudeThreadsMcpServers(app).claude_threads as unknown as {
      harnessTools: Array<{ name: string; requiresApproval: boolean }>;
    };
    for (const name of ['enter_vm', 'vm_exec', 'exit_vm']) {
      expect(canonical.harnessTools.find((t) => t.name === name)?.requiresApproval, name).toBe(true);
    }
  });

  it('validates arguments as the schemas advertise', () => {
    const { enter, exec, exit } = vmTools({});
    const parse = (definition: ToolDef, args: unknown) => z.object(definition.inputSchema).safeParse(args).success;

    // enter_vm: every parameter optional; network constrained to the three modes.
    expect(parse(enter, {})).toBe(true);
    expect(parse(enter, { image: 'i:1', network: 'internal', mountPath: '/a' })).toBe(true);
    for (const network of ['default', 'internal', 'none']) expect(parse(enter, { network })).toBe(true);
    expect(parse(enter, { network: 'bridge' })).toBe(false);

    // vm_exec: command required and non-empty.
    expect(parse(exec, {})).toBe(false);
    expect(parse(exec, { command: '' })).toBe(false);
    expect(parse(exec, { command: 'ls' })).toBe(true);
    expect(parse(exec, { command: 'ls', timeoutSeconds: 30 })).toBe(true);

    expect(parse(exit, {})).toBe(true);
    expect(parse(exit, { force: true })).toBe(true);
  });

  it('keeps legacy tool names out of the canonical descriptions and schemas', () => {
    const { all } = vmTools({});
    for (const name of ['enter_vm', 'vm_exec', 'exit_vm']) {
      const definition = all.find((t) => t.name === name)!;
      const serialized = JSON.stringify({
        description: definition.description,
        schema: z.toJSONSchema(z.object(definition.inputSchema)),
      });
      expect(serialized, name).not.toMatch(/obsidian_[a-z_]+/);
    }
  });
});

// ── enter_vm ─────────────────────────────────────────────────────────────────

describe('enter_vm', () => {
  it('mounts the effective cwd at /work and reports what it started', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const { enter } = vmTools({ vmCommandRunner: runner.run });

    const { isError, payload } = await call(enter, {});

    expect(isError).toBe(false);
    expect(payload).toMatchObject({
      success: true,
      containerName: NAME,
      image: DEFAULT_VM_IMAGE,
      mountedFrom: MOUNT,
      network: 'default',
      containerWorkdir: VM_WORKDIR,
    });
    expect(runner.argvs().at(-1)).toContain(`--volume ${MOUNT}:${VM_WORKDIR}`);
  });

  it('defaults to full egress — no --network flag is passed', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const { enter } = vmTools({ vmCommandRunner: runner.run });

    await call(enter, {});

    expect(runner.argvs().at(-1)).not.toContain('--network');
  });

  it('reads the image and network from settings on every call, not at construction', async () => {
    const runner = makeRunner({
      ...CLI_OK_NO_CONTAINER,
      'network list --quiet': { stdout: `${VM_INTERNAL_NETWORK_NAME}\n` },
    });
    let image = 'first:1';
    let network = 'default';
    const { enter, exit } = vmTools({
      vmCommandRunner: runner.run,
      getVmImage: () => image,
      getVmDefaultNetwork: () => network,
    });

    expect((await call(enter, {})).payload).toMatchObject({ image: 'first:1', network: 'default' });
    await call(exit, {});

    // Settings changed mid-session: the next call must pick them up.
    image = 'second:2';
    network = 'internal';
    expect((await call(enter, {})).payload).toMatchObject({ image: 'second:2', network: 'internal' });
  });

  it('lets explicit arguments override the configured settings', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const { enter } = vmTools({
      vmCommandRunner: runner.run,
      getVmImage: () => 'configured:1',
      getVmDefaultNetwork: () => 'internal',
    });

    const { payload } = await call(enter, { image: 'explicit:9', network: 'none' });

    expect(payload).toMatchObject({ image: 'explicit:9', network: 'none' });
    expect(runner.argvs().at(-1)).toContain('--network none');
  });

  it('honours an explicit mountPath override', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const other = fs.realpathSync(fs.mkdtempSync(path.join(MOUNT, 'vm-mount-')));
    try {
      const { enter } = vmTools({ vmCommandRunner: runner.run });
      const { payload } = await call(enter, { mountPath: other });
      expect(payload.mountedFrom).toBe(other);
      expect(runner.argvs().at(-1)).toContain(`--volume ${other}:${VM_WORKDIR}`);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects a relative mountPath before starting anything', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const { enter } = vmTools({ vmCommandRunner: runner.run });

    const { isError, payload } = await call(enter, { mountPath: 'relative/dir' });

    expect(isError).toBe(true);
    expect(payload).toEqual({ success: false, error: expect.stringContaining('absolute path') });
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects a mountPath that does not exist, naming the path', async () => {
    // `container run` with a missing --volume source fails deep in the runtime
    // with a message that does not say which path was wrong.
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const missing = path.join(MOUNT, 'definitely-not-here-vm-test');
    const { enter } = vmTools({ vmCommandRunner: runner.run });

    const { isError, payload } = await call(enter, { mountPath: missing });

    expect(isError).toBe(true);
    expect(payload.error).toContain(missing);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects a mountPath that is a file rather than a directory', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const file = path.join(MOUNT, `vm-mount-file-${Date.now()}`);
    fs.writeFileSync(file, 'x');
    try {
      const { enter } = vmTools({ vmCommandRunner: runner.run });
      const { isError, payload } = await call(enter, { mountPath: file });
      expect(isError).toBe(true);
      expect(payload.error).toContain('not an existing directory');
      expect(runner.calls).toHaveLength(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('asks for a working directory when there is neither a cwd nor a mountPath', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const { enter } = vmTools({ vmCommandRunner: runner.run, initialCwd: '' });

    const { isError, payload } = await call(enter, {});

    expect(isError).toBe(true);
    expect(payload.error).toContain('set_working_directory');
    expect(runner.calls).toHaveLength(0);
  });

  it('returns a clean error result — never throws — when the CLI is unavailable', async () => {
    const runner = makeRunner({ '--version': new VmUnavailableError('ENOENT') });
    const { enter } = vmTools({ vmCommandRunner: runner.run });

    const { isError, payload } = await call(enter, {});

    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('brew install container');
    expect(payload.error).toContain('container system start');
  });
});

// ── vm_exec ──────────────────────────────────────────────────────────────────

describe('vm_exec', () => {
  async function started(script: Record<string, Scripted> = {}) {
    const runner = makeRunner({ ...CLI_OK_NO_CONTAINER, ...script });
    const tools = vmTools({ vmCommandRunner: runner.run });
    await call(tools.enter, {});
    runner.calls.length = 0;
    return { ...tools, runner };
  }

  it('runs the command in the thread\'s container and returns exit code plus streams', async () => {
    const { exec, runner } = await started({
      [`exec --workdir ${VM_WORKDIR} ${NAME} bash -lc npm test`]: { stdout: 'all good\n', stderr: 'warn\n' },
    });

    const { isError, payload } = await call(exec, { command: 'npm test' });

    expect(isError).toBe(false);
    expect(payload).toEqual({ success: true, exitCode: 0, stdout: 'all good\n', stderr: 'warn\n' });
    expect(runner.argvs()).toEqual([`exec --workdir ${VM_WORKDIR} ${NAME} bash -lc npm test`]);
  });

  it('reports a failing command as a successful tool call with a non-zero exit code', async () => {
    const { exec } = await started({
      [`exec --workdir ${VM_WORKDIR} ${NAME} bash -lc exit 7`]: { exitCode: 7, stderr: 'boom' },
    });

    const { isError, payload } = await call(exec, { command: 'exit 7' });

    expect(isError).toBe(false);
    expect(payload).toEqual({ success: true, exitCode: 7, stdout: '', stderr: 'boom' });
  });

  it('tells the caller to run enter_vm first when no VM is running', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const { exec } = vmTools({ vmCommandRunner: runner.run });

    const { isError, payload } = await call(exec, { command: 'ls' });

    expect(isError).toBe(true);
    expect(payload.error).toContain('enter_vm');
  });

  it('returns a clean error result when the CLI is unavailable', async () => {
    const runner = makeRunner({ '--version': new VmUnavailableError() });
    const { exec } = vmTools({ vmCommandRunner: runner.run });

    const { isError, payload } = await call(exec, { command: 'ls' });

    expect(isError).toBe(true);
    expect(payload.error).toContain('brew install container');
  });
});

// ── exit_vm ──────────────────────────────────────────────────────────────────

describe('exit_vm', () => {
  it('stops and removes the VM, then reports the container it removed', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const { enter, exit } = vmTools({ vmCommandRunner: runner.run });
    await call(enter, {});
    runner.calls.length = 0;

    const { isError, payload } = await call(exit, {});

    expect(isError).toBe(false);
    expect(payload).toEqual({ success: true, removedContainer: NAME });
    expect(runner.argvs()).toEqual([`stop ${NAME}`, `rm --force ${NAME}`]);
  });

  it('skips the graceful stop when force is set', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const { enter, exit } = vmTools({ vmCommandRunner: runner.run });
    await call(enter, {});
    runner.calls.length = 0;

    expect((await call(exit, { force: true })).payload.success).toBe(true);
    expect(runner.argvs()).toEqual([`rm --force ${NAME}`]);
  });

  it('reports plainly when there is no VM to remove', async () => {
    const runner = makeRunner(CLI_OK_NO_CONTAINER);
    const { exit } = vmTools({ vmCommandRunner: runner.run });

    const { isError, payload } = await call(exit, {});

    expect(isError).toBe(true);
    expect(payload).toEqual({ success: false, error: 'No sandbox VM is running for this thread.' });
  });

  it('returns a clean error result when the CLI is unavailable', async () => {
    const runner = makeRunner({ '--version': new VmUnavailableError() });
    const { exit } = vmTools({ vmCommandRunner: runner.run });

    const { isError, payload } = await call(exit, {});

    expect(isError).toBe(true);
    expect(payload.error).toContain('brew install container');
  });
});

// ── Session isolation ────────────────────────────────────────────────────────

describe('sandbox VM tools — per-thread isolation', () => {
  it('gives each thread its own container, derived from its thread ID', async () => {
    const runner = makeRunner({
      '--version': { stdout: 'v' },
      [`inspect ${containerNameForThread('thread-a')}`]: { exitCode: 1 },
      [`inspect ${containerNameForThread('thread-b')}`]: { exitCode: 1 },
    });
    const forThread = (threadId: string) =>
      (createClaudeThreadsMcpServers(app, {
        threadId, initialCwd: MOUNT, vmCommandRunner: runner.run,
      }).claude_threads as unknown as { tools: ToolDef[] }).tools.find((t) => t.name === 'enter_vm')!;

    const a = await call(forThread('thread-a'), {});
    const b = await call(forThread('thread-b'), {});

    expect(a.payload.containerName).toBe(containerNameForThread('thread-a'));
    expect(b.payload.containerName).toBe(containerNameForThread('thread-b'));
    expect(a.payload.containerName).not.toBe(b.payload.containerName);
  });

  it('gives two thread-less sessions distinct containers rather than colliding', async () => {
    const runner = makeRunner({ '--version': { stdout: 'v' } });
    const anonymousEnter = () =>
      (createClaudeThreadsMcpServers(app, {
        initialCwd: MOUNT, vmCommandRunner: runner.run,
      }).claude_threads as unknown as { tools: ToolDef[] }).tools.find((t) => t.name === 'enter_vm')!;

    // Both hit the "container already exists" branch, which echoes the name.
    const first = await call(anonymousEnter(), {});
    const second = await call(anonymousEnter(), {});

    expect(first.payload.error).not.toBe(second.payload.error);
  });
});
