/**
 * Stale `claude` CLI detection.
 *
 * Sessions run through the user's installed `claude` binary, and the model
 * catalog plus alias -> model mapping come from that binary. A stale install
 * (for example an old Homebrew cask) therefore silently shows an old model
 * list. These helpers probe the CLI version and cross-check the catalog so the
 * UI can say so. Nothing here upgrades anything or touches the network.
 *
 * Every OS interaction goes through `CliProbeDeps` so the logic is testable.
 */
import { parseClaudeModelId, formatModelId, type ModelCatalogEntry } from './modelOptions';

/**
 * Oldest `claude` CLI known to report every model in the plugin's fallback
 * list (FALLBACK_RESOLVED in modelOptions.ts). Bump this whenever that list
 * gains a model. The SDK this plugin bundles is `@anthropic-ai/claude-agent-sdk`
 * in package.json; the floor should track the CLI release that SDK pairs with.
 */
export const MIN_CLAUDE_CLI_VERSION = '2.1.284';

const PROBE_TIMEOUT_MS = 8_000;

export interface CliExecResult { exitCode: number; stdout: string; stderr: string }

export interface CliProbeDeps {
  exec(file: string, args: string[], opts: { timeoutMs: number }): Promise<CliExecResult>;
  /** Resolve symlinks (Homebrew bin shims point into Caskroom). Falls back to the input on failure. */
  realpath(p: string): string;
}

export type CliInstallMethod = 'homebrew' | 'npm' | 'other';

export interface CliInfo {
  binaryPath: string;
  /** Undefined when the probe failed or output was unparseable. */
  version?: string;
  installMethod: CliInstallMethod;
  /** Exact command the user can run to upgrade. Never executed by the plugin. */
  upgradeCommand: string;
  belowMinimum: boolean;
}

export interface CliProblem {
  /** `warning`: CLI is below the pinned floor. `notice`: informational, account may legitimately lack a model. */
  severity: 'warning' | 'notice';
  message: string;
  upgradeCommand?: string;
}

/** `2.1.284 (Claude Code)` -> `2.1.284`. */
export function parseCliVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** Numeric dotted-version compare: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Install method inferred from the (symlink-resolved) binary path. */
export function detectInstallMethod(resolvedPath: string): { method: CliInstallMethod; upgradeCommand: string } {
  const p = resolvedPath.replace(/\\/g, '/');
  if (/node_modules\/@anthropic-ai\/claude-code/.test(p)) {
    return { method: 'npm', upgradeCommand: 'npm install -g @anthropic-ai/claude-code@latest' };
  }
  if (/^\/opt\/homebrew\//.test(p) || /^\/usr\/local\/(Cellar|Caskroom)\//.test(p) || /\/(Cellar|Caskroom)\/claude-code\//.test(p)) {
    return { method: 'homebrew', upgradeCommand: 'brew upgrade claude-code' };
  }
  return { method: 'other', upgradeCommand: 'claude update' };
}

/** Runs `<binary> --version`. Never throws. */
export async function probeCliVersion(binary: string, deps: CliProbeDeps): Promise<string | undefined> {
  try {
    const r = await deps.exec(binary, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.exitCode !== 0) return undefined;
    return parseCliVersion(r.stdout + r.stderr);
  } catch {
    return undefined;
  }
}

/** Probe the binary and classify it. Never throws. */
export async function checkClaudeCli(binaryPath: string, deps: CliProbeDeps): Promise<CliInfo> {
  let resolved = binaryPath;
  try { resolved = deps.realpath(binaryPath) || binaryPath; } catch { /* keep the configured path */ }
  // A Homebrew shim resolves into Caskroom, but check the configured path too
  // in case the resolved target is something generic.
  let { method, upgradeCommand } = detectInstallMethod(resolved);
  if (method === 'other') ({ method, upgradeCommand } = detectInstallMethod(binaryPath));
  const version = await probeCliVersion(binaryPath, deps);
  return {
    binaryPath,
    ...(version ? { version } : {}),
    installMethod: method,
    upgradeCommand,
    belowMinimum: version !== undefined && compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0,
  };
}

function familyVersionKey(modelId: string | undefined): string | undefined {
  const parsed = parseClaudeModelId(modelId);
  return parsed ? `${parsed.family}|${parsed.version}` : undefined;
}

/**
 * Known model ids the catalog does not report. Compared by family+version so
 * Bedrock/Vertex ids, date suffixes and `[1m]` tags still match. Empty when the
 * catalog is empty (nothing discovered yet, so nothing to cross-check).
 */
export function findMissingKnownModels(catalog: readonly ModelCatalogEntry[], knownModelIds: readonly string[]): string[] {
  if (catalog.length === 0) return [];
  const present = new Set<string>();
  for (const m of catalog) {
    for (const id of [m.value, m.resolvedModel]) {
      const key = familyVersionKey(id);
      if (key) present.add(key);
    }
  }
  return knownModelIds.filter((id) => {
    const key = familyVersionKey(id);
    return key !== undefined && !present.has(key);
  });
}

/** User-facing problems, strongest first. Empty when everything looks fine. */
export function describeCliProblems(info: CliInfo | undefined, missingModels: readonly string[]): CliProblem[] {
  const problems: CliProblem[] = [];
  const upgradeCommand = info?.upgradeCommand ?? 'claude update';
  if (info?.belowMinimum && info.version) {
    problems.push({
      severity: 'warning',
      message: `Your claude CLI is ${info.version}; this plugin expects ${MIN_CLAUDE_CLI_VERSION} or newer, so the model list may be out of date. Upgrade with: ${upgradeCommand}`,
      upgradeCommand,
    });
  }
  if (missingModels.length > 0) {
    const names = missingModels.map(formatModelId).join(', ');
    problems.push({
      severity: 'notice',
      message: `${names} not reported by your CLI. If you expect ${missingModels.length > 1 ? 'them' : 'it'}, update it: ${upgradeCommand}`,
      upgradeCommand,
    });
  }
  return problems;
}

// ── Real dependencies (lazy requires; desktop only) ──────────────────────────

export function createDefaultCliProbeDeps(): CliProbeDeps {
  return {
    exec: (file, args, opts) =>
      new Promise<CliExecResult>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cp = require('child_process') as typeof import('child_process');
        cp.execFile(file, args, { timeout: opts.timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (!error) { resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }); return; }
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'EACCES') { reject(error); return; }
          resolve({ exitCode: typeof code === 'number' ? code : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
      }),
    realpath: (p) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      return fs.realpathSync(p);
    },
  };
}
