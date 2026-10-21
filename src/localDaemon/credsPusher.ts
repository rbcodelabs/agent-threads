/**
 * Local daemon: pushes credential kinds into the daemon container with `agent-threads creds push`, run inside the
 * container (`container exec -i`) as the daemon user.
 *
 *   - Values travel on the exec's stdin as one JSON object, never in argv, an environment variable or a log line, and
 *     are redacted from any error text.
 *   - `creds push` needs an admin-scope token. It is minted INSIDE the container and saved as `<data dir>/cli-token`,
 *     which the CLI picks up by itself, so the admin token never reaches Geode or its keychain. Whoever can read it
 *     can already read the daemon's journals and credentials (same user), so it adds no capability.
 *   - Every push carries a TTL, so a quit Geode leaves nothing long-lived behind.
 *
 * Used by the GitHub delivery (`githubDelivery.ts`) and the session environment delivery (`envDelivery.ts`).
 */

import type { VmCommandRunner } from '../containerCli';
import type { CredsSink } from '../credsDelivery';
import { redactSecrets, parseTokenList, tail } from './parse';
import {
  CREDS_TOKEN_NAME,
  cliTokenCreateArgs,
  cliTokenPresentArgs,
  containerNameFor,
  credsPushArgs,
  credsRemoveArgs,
  mcpSyncArgs,
  tokenListArgs,
  tokenRevokeArgs,
} from './spec';

export const CREDS_EXEC_TIMEOUT_MS = 30_000;

export interface CredsPusherDeps {
  /** Absolute vault path (it names the container), or null where there is none. */
  vaultPath(): string | null;
  /** Built lazily so it finds the managed `container` binary once the runtime is installed. */
  runner(): VmCommandRunner;
  /** Called when the data volume looks fresh (no saved admin token), so dependants can drop their caches. */
  onFreshVolume?(): void;
}

export class CredsPusher implements CredsSink {
  /** Containers whose admin token for `creds push` is known to exist. */
  private readonly cliTokenReady = new Set<string>();

  constructor(private readonly deps: CredsPusherDeps) {}

  containerName(): string {
    const vault = this.deps.vaultPath();
    if (!vault) throw new Error('No vault folder, so there is no local daemon.');
    return containerNameFor(vault);
  }

  /** Pushes `fields` under `kind`. Throws with a redacted message on failure. */
  async push(kind: string, fields: Record<string, string>, ttlSec: number): Promise<void> {
    const name = this.containerName();
    const run = this.deps.runner();
    const secrets = Object.values(fields);
    for (let attempt = 0; ; attempt++) {
      await this.ensureCliToken(name);
      const r = await run(credsPushArgs(name, kind, ttlSec), { timeoutMs: CREDS_EXEC_TIMEOUT_MS, input: JSON.stringify(fields) });
      if (r.exitCode === 0) return;
      // The data volume may have been reset, taking cli-token with it: mint a new one and retry once.
      this.cliTokenReady.delete(name);
      if (attempt >= 1) {
        const detail = redactSecrets(tail(`${r.stderr}\n${r.stdout}`.trim()), secrets);
        throw new Error(`pushing "${kind}" to the local daemon failed (exit ${r.exitCode}): ${detail}`);
      }
    }
  }

  /**
   * Replaces the daemon's synced MCP servers (`agent-threads mcp sync`, full replace). Definitions only (placeholders,
   * never values), on stdin. Returns the daemon's reply.
   */
  async syncMcp(servers: Record<string, unknown>): Promise<{ accepted: string[]; rejected: Array<{ name: string; reason: string }>; requiredCreds: string[]; shadowed: string[]; kept?: boolean }> {
    const name = this.containerName();
    const run = this.deps.runner();
    for (let attempt = 0; ; attempt++) {
      await this.ensureCliToken(name);
      const r = await run(mcpSyncArgs(name), { timeoutMs: CREDS_EXEC_TIMEOUT_MS, input: JSON.stringify(servers) });
      // Exit 1 with a `kept` reply is the daemon refusing every server, not a failed exec: the reply is the answer.
      const parseReply = () => JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Partial<{ accepted: string[]; rejected: Array<{ name: string; reason: string }>; requiredCreds: string[]; shadowed: string[]; kept: boolean }>;
      const kept = r.exitCode !== 0 ? (() => { try { const p = parseReply(); return p.kept === true ? p : undefined; } catch { return undefined; } })() : undefined;
      if (r.exitCode === 0 || kept) {
        try {
          const parsed = kept ?? parseReply();
          return { accepted: parsed.accepted ?? [], rejected: parsed.rejected ?? [], requiredCreds: parsed.requiredCreds ?? [], shadowed: parsed.shadowed ?? [], ...(parsed.kept === true ? { kept: true } : {}) };
        } catch {
          throw new Error('the local daemon answered the MCP sync with something unreadable');
        }
      }
      this.cliTokenReady.delete(name);
      if (attempt >= 1) throw new Error(`syncing MCP servers to the local daemon failed (exit ${r.exitCode}): ${tail(`${r.stderr}\n${r.stdout}`.trim())}`);
    }
  }

  /** Deletes a pushed kind. Best effort: the daemon may be stopped, and the TTL covers that. */
  async remove(kind: string): Promise<void> {
    try {
      const name = this.containerName();
      await this.deps.runner()(credsRemoveArgs(name, kind), { timeoutMs: CREDS_EXEC_TIMEOUT_MS });
    } catch { /* see above */ }
  }

  /**
   * Is the data volume still the one we delivered to? Called before each session's delivery: a volume that was reset
   * while the app stayed open has lost the saved admin token along with everything we pushed or copied, so the
   * dependants' caches must go (otherwise they would skip re-delivering what is no longer there).
   */
  async verifyVolume(): Promise<void> {
    const name = this.containerName();
    const r = await this.deps.runner()(cliTokenPresentArgs(name), { timeoutMs: CREDS_EXEC_TIMEOUT_MS });
    if (r.exitCode === 0) return;
    this.cliTokenReady.delete(name);
    this.deps.onFreshVolume?.();
  }

  /** Mints and saves the admin token `creds push` authenticates with. Idempotent. */
  private async ensureCliToken(name: string): Promise<void> {
    if (this.cliTokenReady.has(name)) return;
    const run = this.deps.runner();
    if ((await run(cliTokenPresentArgs(name), { timeoutMs: CREDS_EXEC_TIMEOUT_MS })).exitCode === 0) {
      this.cliTokenReady.add(name);
      return;
    }
    // No saved token means a fresh or reset data volume: anything else kept there is gone too.
    this.deps.onFreshVolume?.();
    // Revoke any earlier token of ours (its plaintext copy is gone) before minting the replacement.
    const list = await run(tokenListArgs(name), { timeoutMs: CREDS_EXEC_TIMEOUT_MS });
    if (list.exitCode !== 0) throw new Error('The local daemon container is not running.');
    for (const t of parseTokenList(list.stdout)) {
      if (t.name === CREDS_TOKEN_NAME && !t.revoked) await run(tokenRevokeArgs(name, t.id), { timeoutMs: CREDS_EXEC_TIMEOUT_MS });
    }
    const create = await run(cliTokenCreateArgs(name), { timeoutMs: CREDS_EXEC_TIMEOUT_MS });
    if (create.exitCode !== 0) {
      // `--save` prints no token, but stay safe: show only the tail of stderr.
      throw new Error(`creating the daemon's credential-push token failed (exit ${create.exitCode}): ${tail(create.stderr)}`);
    }
    this.cliTokenReady.add(name);
  }
}
