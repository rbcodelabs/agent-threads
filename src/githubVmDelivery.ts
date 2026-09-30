/**
 * githubVmDelivery.ts — wires the Geode GitHub connection into a thread's
 * sandbox VM through `VmHooks`.
 *
 *   afterEnter  install helper + gh wrapper + git config; publish the token; start refresh timer
 *   beforeExec  make sure the token file is fresh (and re-install on an adopted container)
 *   afterExit   stop the timer and delete the token
 *
 * The token is streamed over the exec's stdin into a mode-0600 file on tmpfs
 * (never argv, never env, never under the /work mount). Failures never fail a
 * VM operation; they surface as `notes` with an actionable message, once per
 * distinct problem so a broken connection does not spam every command.
 */
import {
  GithubTokenPublisher,
  resolveCommitIdentity,
  type CommitIdentity,
  type GithubCredentialBroker,
  type TokenSink,
} from './githubCredentials';
import {
  buildContainerClearTokenCommand,
  buildContainerInstallCommand,
  buildContainerWriteTokenCommand,
  CONTAINER_DIR_CANDIDATES,
} from './githubCredentialHelper';
import { buildShellExecArgs, type VmHookContext, type VmHooks } from './sandboxVm';

export interface GithubVmDeliveryDeps {
  broker: GithubCredentialBroker;
  /** Read lazily so toggling the setting applies on the next command. */
  isEnabled: () => boolean;
  /** Optional commit-email override from settings; noreply otherwise. */
  getEmailOverride?: () => string | undefined;
  dirCandidates?: readonly string[];
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  intervalMs?: number;
}

const GH_MISSING_NOTE =
  'The gh CLI is not installed in this VM image, so `gh` will not work (git over HTTPS still does). '
  + 'Rebuild the image: `container build --tag claude-threads-coding:1 sandbox/`, and set Settings → Sandbox VM image to it.';

export function createGithubVmHooks(deps: GithubVmDeliveryDeps): VmHooks {
  const candidates = [...(deps.dirCandidates ?? CONTAINER_DIR_CANDIDATES)];
  // One publisher per container; keyed by name so an adopted container after reload gets its own.
  const publishers = new Map<string, { publisher: GithubTokenPublisher; installed: boolean; lastNote: string | null }>();

  const run = (ctx: VmHookContext, command: string, input?: string) =>
    ctx.exec(buildShellExecArgs({ containerName: ctx.containerName, command, interactive: input !== undefined }), { input });

  function stateFor(ctx: VmHookContext) {
    let entry = publishers.get(ctx.containerName);
    if (!entry) {
      const sink: TokenSink = {
        write: async (token) => {
          const res = await run(ctx, buildContainerWriteTokenCommand(candidates), token);
          if (res.exitCode !== 0) throw new Error(`could not write the credential file (exit ${res.exitCode})`);
        },
        clear: async () => { await run(ctx, buildContainerClearTokenCommand(candidates)); },
      };
      entry = {
        publisher: new GithubTokenPublisher({
          broker: deps.broker,
          sink,
          intervalMs: deps.intervalMs,
          now: deps.now,
          setInterval: deps.setInterval,
          clearInterval: deps.clearInterval,
        }),
        installed: false,
        lastNote: null,
      };
      publishers.set(ctx.containerName, entry);
    }
    return entry;
  }

  async function identity(): Promise<CommitIdentity | null> {
    try {
      return resolveCommitIdentity(await deps.broker.getProfile(), deps.getEmailOverride?.());
    } catch {
      return null; // identity is best effort; auth errors are reported by the publisher
    }
  }

  async function install(ctx: VmHookContext): Promise<string[]> {
    const notes: string[] = [];
    const res = await run(ctx, buildContainerInstallCommand({ dirCandidates: candidates, identity: await identity() }));
    if (res.exitCode !== 0) {
      return [`GitHub credential helper could not be installed in the VM: ${(res.stderr || res.stdout).trim().split('\n')[0] || `exit ${res.exitCode}`}`];
    }
    const gh = await run(ctx, 'command -v gh >/dev/null 2>&1');
    if (gh.exitCode !== 0) notes.push(GH_MISSING_NOTE);
    return notes;
  }

  /** Emits a note only when it differs from the last one, so a persistent problem is reported once. */
  function dedupe(entry: { lastNote: string | null }, note: string | null): string[] {
    if (note === entry.lastNote) return [];
    entry.lastNote = note;
    return note ? [note] : [];
  }

  return {
    async afterEnter(ctx) {
      if (!deps.isEnabled() || !deps.broker.available) return [];
      const entry = stateFor(ctx);
      const notes = await install(ctx);
      entry.installed = notes.every((n) => n === GH_MISSING_NOTE);
      if (!entry.installed) return notes;
      const state = await entry.publisher.start();
      if (!state.ok) {
        notes.push(`GitHub is not available in this VM: ${state.error.message}`);
        entry.lastNote = state.error.message;
      } else {
        const p = deps.broker.cachedProfile();
        notes.push(`GitHub connected${p ? ` as ${p.login}` : ''}: git (HTTPS) and gh are authenticated inside the VM; the token refreshes automatically.`);
      }
      return notes;
    },

    async beforeExec(ctx) {
      if (!deps.isEnabled() || !deps.broker.available) return [];
      const entry = stateFor(ctx);
      const notes: string[] = [];
      if (!entry.installed) {
        // Adopted after a plugin reload: nothing tracked this container yet.
        const res = await run(ctx, `for c in ${candidates.map((c) => `'${c}'`).join(' ')}; do [ -x "$c/git-credential-claude-threads" ] && exit 0; done; exit 1`);
        if (res.exitCode !== 0) notes.push(...(await install(ctx)));
        entry.installed = true;
        await entry.publisher.start();
      } else {
        await entry.publisher.ensureFresh();
      }
      const err = entry.publisher.error;
      notes.push(...dedupe(entry, err ? `GitHub is not available in this VM: ${err.message}` : null));
      return notes;
    },

    async afterExit(ctx) {
      const entry = publishers.get(ctx.containerName);
      if (!entry) {
        await run(ctx, buildContainerClearTokenCommand(candidates)).catch(() => undefined);
        return;
      }
      publishers.delete(ctx.containerName);
      await entry.publisher.stop();
    },
  };
}
