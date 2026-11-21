/**
 * Desktop-only on-demand model catalog prober for Settings → Agent ("Refresh models").
 *
 * Loaded lazily via `require('./harnessModelProbe')` from `ClaudeThreadsPlugin.refreshHarnessModels`
 * so Node.js built-ins and desktop harness adapters never enter the mobile bundle init scope.
 * Each probe queries the local CLI's model catalog without sending a user prompt and
 * guarantees subprocess cleanup in `finally`.
 */
import type { ChildProcess } from 'child_process';
import { AcpClient, type AcpLauncher } from './AcpClient';
import { ANTIGRAVITY_INSTALL_HINT, antigravityModels } from './AntigravitySession';
import { normalizeCatalogEntries, type CachedHarnessModel } from './harnessSettings';
import { launchOpenCodeServer, type OpenCodeLauncher } from './OpenCodeSession';
import { effectiveExtraEnv, parseExtraEnv, type AgentHarness, type PluginSettings } from './types';

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

export interface HarnessModelProbeDeps {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  claudeQuery?: typeof import('@anthropic-ai/claude-agent-sdk').query;
  codexSpawn?: (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;
  openCodeLauncher?: OpenCodeLauncher;
  antigravityLauncher?: AcpLauncher;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function buildProbeEnv(
  settings: Pick<PluginSettings, 'extraEnv' | 'provider'>,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    ...parseExtraEnv(effectiveExtraEnv(settings)),
  };
}

export async function probeClaudeModels(
  settings: Pick<PluginSettings, 'claudeBinaryPath' | 'extraEnv' | 'provider'>,
  cwd: string,
  deps: HarnessModelProbeDeps = {},
): Promise<CachedHarnessModel[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const queryFn = deps.claudeQuery ?? (
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk')).query
  );
  let releasePrompt: (() => void) | undefined;
  const promptStream: AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>>((resolve) => {
          releasePrompt = () => resolve({ value: undefined as never, done: true });
        }),
      };
    },
  };

  const q = queryFn({
    prompt: promptStream,
    options: {
      cwd,
      persistSession: false,
      ...(settings.claudeBinaryPath ? { pathToClaudeCodeExecutable: settings.claudeBinaryPath } : {}),
      env: buildProbeEnv(settings, deps.env),
    },
  });

  try {
    const models = await withTimeout(q.supportedModels(), timeoutMs, 'Claude model discovery', () => {
      releasePrompt?.();
      q.close();
    });
    return normalizeCatalogEntries(models as unknown as ReadonlyArray<Record<string, unknown>>);
  } finally {
    releasePrompt?.();
    try { q.close(); } catch { /* ignore */ }
  }
}

export async function probeCodexModels(
  settings: Pick<PluginSettings, 'codexBinaryPath' | 'extraEnv' | 'provider'>,
  cwd: string,
  deps: HarnessModelProbeDeps = {},
): Promise<CachedHarnessModel[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const binary = settings.codexBinaryPath || 'codex';
  const env = buildProbeEnv(settings, deps.env) as NodeJS.ProcessEnv;
  const spawnFn = deps.codexSpawn ?? ((cmd, args, opts) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process') as typeof import('child_process');
    return spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  const child = spawnFn(binary, ['app-server'], { cwd, env });
  let nextId = 1;
  const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let closed = false;

  const failPending = (err: Error) => {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  };

  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg?.id === 'number' && pending.has(msg.id)) {
          const waiter = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
          else waiter.resolve(msg.result);
        }
      } catch {
        /* ignore non-JSON diagnostic lines */
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });
  child.once('error', (err) => {
    closed = true;
    failPending(new Error(`Could not launch Codex at "${binary}": ${err.message}`));
  });
  child.once('exit', (code) => {
    if (!closed) {
      closed = true;
      failPending(new Error(`Codex app-server exited (${code ?? 'unknown'})${stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(-300)}` : ''}`));
    }
  });

  const sendRequest = (method: string, params: Record<string, unknown>): Promise<any> => {
    if (closed || !child.stdin) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const sendNotification = (method: string, params?: Record<string, unknown>): void => {
    if (closed || !child.stdin) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  };

  const run = async (): Promise<CachedHarnessModel[]> => {
    await sendRequest('initialize', {
      clientInfo: { name: 'obsidian-claude-threads', title: 'Agent Threads', version: '0.76.1' },
      capabilities: { experimentalApi: true },
    });
    sendNotification('initialized');
    const result: { data?: Array<{ id?: string; displayName?: string; model?: string; description?: string }> } =
      await sendRequest('model/list', { limit: 100 });
    return normalizeCatalogEntries(
      (result?.data ?? []).map((m) => ({
        value: m.id ?? m.model ?? '',
        displayName: m.displayName ?? m.id ?? m.model ?? '',
        description: m.description,
      })),
    );
  };

  try {
    return await withTimeout(run(), timeoutMs, 'Codex model discovery', () => {
      closed = true;
      try { child.kill(); } catch { /* ignore */ }
    });
  } finally {
    closed = true;
    try { child.kill(); } catch { /* ignore */ }
  }
}

export async function probeOpenCodeModels(
  settings: Pick<PluginSettings, 'opencodeBinaryPath' | 'extraEnv' | 'provider'>,
  cwd: string,
  deps: HarnessModelProbeDeps = {},
): Promise<CachedHarnessModel[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const launcher = deps.openCodeLauncher ?? launchOpenCodeServer;
  const env = buildProbeEnv(settings, deps.env);
  let transport: Awaited<ReturnType<OpenCodeLauncher>> | undefined;

  const run = async (): Promise<CachedHarnessModel[]> => {
    transport = await launcher({
      binaryPath: settings.opencodeBinaryPath || 'opencode',
      cwd,
      env,
      config: {},
      configV2: {},
    });
    if (transport.generation === 'v2') {
      const [modelResult, providerResult] = await Promise.all([
        transport.request('GET', '/api/model'),
        transport.request('GET', '/api/provider').catch(() => undefined),
      ]);
      const providerNames = new Map<string, string>();
      for (const provider of providerResult?.body?.data ?? []) {
        if (provider?.id && provider?.name) providerNames.set(String(provider.id), String(provider.name));
      }
      const raw: CachedHarnessModel[] = [];
      for (const model of modelResult?.body?.data ?? []) {
        if (!model?.providerID || !model?.id || model.enabled === false) continue;
        raw.push({
          value: `${model.providerID}/${model.id}`,
          displayName: `${providerNames.get(model.providerID) ?? model.providerID}: ${model.name ?? model.id}`,
        });
      }
      return normalizeCatalogEntries(raw);
    }
    const result = await transport.request('GET', '/config/providers');
    const providers: Array<{ id?: string; name?: string; models?: Record<string, { id?: string; name?: string }> }> =
      result?.body?.providers ?? [];
    const raw: CachedHarnessModel[] = [];
    for (const provider of providers) {
      if (!provider?.id) continue;
      for (const [key, model] of Object.entries(provider.models ?? {})) {
        raw.push({
          value: `${provider.id}/${model.id ?? key}`,
          displayName: `${provider.name ?? provider.id}: ${model.name ?? model.id ?? key}`,
        });
      }
    }
    return normalizeCatalogEntries(raw);
  };

  try {
    return await withTimeout(run(), timeoutMs, 'OpenCode model discovery', () => {
      try { transport?.close(); } catch { /* ignore */ }
    });
  } finally {
    try { transport?.close(); } catch { /* ignore */ }
  }
}

export async function probeAntigravityModels(
  settings: Pick<PluginSettings, 'antigravityBinaryPath' | 'extraEnv' | 'provider'>,
  cwd: string,
  deps: HarnessModelProbeDeps = {},
): Promise<CachedHarnessModel[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const client = new AcpClient({
    binaryPath: settings.antigravityBinaryPath || 'agy',
    args: ['acp'],
    cwd,
    env: buildProbeEnv(settings, deps.env),
    label: 'Antigravity',
    installHint: ANTIGRAVITY_INSTALL_HINT,
    ...(deps.antigravityLauncher ? { launcher: deps.antigravityLauncher } : {}),
  });

  const run = async (): Promise<CachedHarnessModel[]> => {
    client.spawn();
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, timeoutMs);
    const setup = await client.request('session/new', { cwd, mcpServers: [] }, timeoutMs);
    return normalizeCatalogEntries(antigravityModels(setup));
  };

  try {
    return await withTimeout(run(), timeoutMs, 'Antigravity model discovery', () => {
      try { client.close(); } catch { /* ignore */ }
    });
  } finally {
    try { client.close(); } catch { /* ignore */ }
  }
}

/** Probes the live model catalog for `harness` without persisting a conversation session. */
export async function probeHarnessModels(
  harness: AgentHarness,
  settings: PluginSettings,
  cwd: string,
  deps: HarnessModelProbeDeps = {},
): Promise<CachedHarnessModel[]> {
  switch (harness) {
    case 'claude':
      return probeClaudeModels(settings, cwd, deps);
    case 'codex':
      return probeCodexModels(settings, cwd, deps);
    case 'opencode':
      return probeOpenCodeModels(settings, cwd, deps);
    case 'antigravity':
      return probeAntigravityModels(settings, cwd, deps);
  }
}
