/**
 * Worktree tools (`set_working_directory`, `enter_worktree`, `exit_worktree`), moved verbatim out of
 * ObsidianTools.ts. Route: LOCAL on a daemon, because they must run next to the repo (execFileSync git).
 * No `obsidian` import: the daemon bundles this file.
 */
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk/browser';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CwdTracker } from './cwdTracker';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { resolveWorktreeRoot, worktreePathFor } from '../worktreePaths';

type ToolDef = SdkMcpToolDefinition<any>;

export interface WorktreeToolsPort {
  cwd: CwdTracker;
  /** Told when the session moves into or out of a worktree (the plugin fans it out to peers); must not throw into the tool. */
  onWorktreeChanged?: (payload: Record<string, unknown>) => void;
  /** The subset of `ObsidianMcpServerOptions` these tools read (declared here so the daemon bundle never reaches ObsidianTools.ts). */
  options: {
    /** Configured worktree root; blank falls back to `~/.geode/worktrees`. */
    getWorktreeRoot?: () => string | undefined;
    /** The agent moved the session; `originRepoPath` is passed by the worktree tools only (see ObsidianMcpServerOptions.onSetCwd). */
    onSetCwd?: (path: string, originRepoPath?: string | null) => void;
    /** Refuses a working directory before it is adopted (throws with the reason). */
    validateCwd?: (path: string) => void;
    /**
     * Daemon only. The folder holding the repositories the daemon keeps cloned: a relative `repoPath` (`my-repo`)
     * resolves against it, and worktrees of repositories inside it are created under `<root>/.worktrees`.
     */
    workspaceRoot?: string;
    /** Daemon only. Ignore the `worktreeRoot` argument: where worktrees go is the operator's decision, not the agent's. */
    lockWorktreeRoot?: boolean;
  };
}


export function createWorktreeTools(port: WorktreeToolsPort): Record<string, ToolDef> {
  const { cwd, options, onWorktreeChanged } = port;
  const boundSetWorkingDirectory = tool(
    'set_working_directory',
    [
      'Changes the working directory for this Claude session. Use this when you need to switch context to a different repository or project folder. Accepts an absolute path; ~ is expanded to the home directory.',
      'The change takes effect on the next turn — the current query continues in the original directory. Returns the resolved absolute path on success.',
    ].join(' '),
    {
      path: z.string().describe('Absolute filesystem path to set as the new working directory (~ is expanded)'),
    },
    async (args, _extra) => {
      try {
        const resolved = args.path.replace(/^~(?=\/|$)/, os.homedir());

        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Path does not exist: ${resolved}` }) }],
            isError: true,
          };
        }

        if (!fs.statSync(resolved).isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Not a directory: ${resolved}` }) }],
            isError: true,
          };
        }

        // Update both the persisted cwd (for next session) and the in-session
        // effective cwd (used immediately by obsidian_enter_worktree).
        options.validateCwd?.(resolved);
        cwd.set(resolved);
        options.onSetCwd?.(resolved);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, cwd: resolved }) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  // ── Worktree tools ──────────────────────────────────────────────────────────
  // The SDK's built-in EnterWorktree / ExitWorktree tools use the frozen
  // OS-level subprocess cwd (set at session start), so they always operate on
  // whatever repo was active when the thread was created — usually the vault
  // root.  These MCP versions read effectiveCwd instead, which is updated
  // immediately whenever set_working_directory is called.
  //
  // ClaudeSession wires Options.toolAliases so that any EnterWorktree /
  // ExitWorktree call the model emits is automatically routed here — callers
  // can use either name.

  const boundEnterWorktree = tool(
    'enter_worktree',
    [
      'Creates a new git worktree for the repo at the current effective working directory and switches this session to use it.',
      'The worktree is an isolated copy of the repo on a new branch — changes there do not affect the main checkout.',
      'After this call the session cwd is updated to the worktree path (takes effect next turn).',
      'Use exit_worktree to remove the worktree and restore the original repo path.',
    ].join(' '),
    {
      branch: z.string().optional().describe(
        'Branch name to create in the worktree. Auto-generated as claude/<timestamp> if omitted.',
      ),
      baseBranch: z.string().optional().describe(
        'Base branch or commit to start from. Defaults to HEAD.',
      ),
      repoPath: z.string().optional().describe(
        'Override which git repo to use. Defaults to the current effective working directory.',
      ),
      worktreeRoot: z.string().optional().describe(
        'Override the directory worktrees are created under. Defaults to the configured worktree location (~/.geode/worktrees). Must be durable storage — a temp dir is cleared on reboot, taking any uncommitted work with it.',
      ),
    },
    async (args, _extra) => {
      try {
        const path = require('path') as typeof import('path');

        // A relative repoPath names a clone under the daemon's repository root; anything else is taken as given and then
        // checked against the host's allowed folders.
        const repoPath = args.repoPath && options.workspaceRoot && !path.isAbsolute(args.repoPath)
          ? path.resolve(options.workspaceRoot, args.repoPath)
          : (args.repoPath ?? cwd.get());
        if (!repoPath) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No working directory set. Call set_working_directory first.' }) }],
            isError: true,
          };
        }

        // Judge the path the agent named BEFORE running git in it: git reads configuration from the directory it is run in.
        options.validateCwd?.(repoPath);

        // Resolve the git root (handles cases where repoPath is a subdirectory)
        let gitRoot: string;
        try {
          gitRoot = execFileSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
        } catch {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Not a git repository: ${repoPath}` }) }],
            isError: true,
          };
        }

        // The git root can differ from the path (a subfolder, or a symlink that leads elsewhere): it must be allowed too,
        // before anything is created beside it.
        options.validateCwd?.(gitRoot);

        const branchName = args.branch ?? `claude/${Date.now()}`;

        // Worktrees go under a durable, app-owned root — NOT os.tmpdir(). macOS
        // clears $TMPDIR on reboot, which silently destroyed worktrees and any
        // uncommitted work in them. See src/worktreePaths.ts for the full rationale.
        const realWorkspaceRoot = options.workspaceRoot ? (() => { try { return fs.realpathSync(options.workspaceRoot!); } catch { return path.resolve(options.workspaceRoot!); } })() : undefined;
        const insideWorkspaceRoot = !!realWorkspaceRoot && gitRoot.startsWith(realWorkspaceRoot + path.sep);
        const worktreeRoot = resolveWorktreeRoot(
          options.lockWorktreeRoot
            ? (insideWorkspaceRoot ? path.join(options.workspaceRoot!, '.worktrees') : options.getWorktreeRoot?.())
            : (args.worktreeRoot ?? options.getWorktreeRoot?.()),
        );
        let rawWorktreePath = worktreePathFor(worktreeRoot, gitRoot, branchName);
        // Two worktrees off the same branch name would collide; git refuses to
        // create into a non-empty directory, so disambiguate rather than fail.
        if (fs.existsSync(rawWorktreePath)) {
          rawWorktreePath = `${rawWorktreePath}-${crypto.randomUUID().slice(0, 8)}`;
        }
        options.validateCwd?.(rawWorktreePath);
        fs.mkdirSync(path.dirname(rawWorktreePath), { recursive: true });

        // git worktree add <path> -b <branch> [<base>]
        const gitArgs = ['worktree', 'add', rawWorktreePath, '-b', branchName];
        if (args.baseBranch) gitArgs.push(args.baseBranch);

        try {
          execFileSync('git', gitArgs, { cwd: gitRoot, encoding: 'utf8' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `git worktree add failed: ${msg}` }) }],
            isError: true,
          };
        }

        // The worktree root may resolve through a symlink (notably the legacy
        // os.tmpdir() layout on macOS, /var/folders/... -> /private/var/folders/...,
        // but also any user-configured root behind one). The Read/Write/Edit tool
        // sandbox checks the canonical resolved path, while Bash tolerates the symlink form
        // — so leaving this uncanonicalized causes Edit/Write (but not Bash) to fail with
        // spurious "Stream closed" / permission errors for the rest of the worktree session.
        // Resolve to the real path now that `git worktree add` has actually created the
        // directory (realpathSync requires the path to exist).
        const worktreePath = fs.realpathSync(rawWorktreePath);

        cwd.activeWorktrees.set(worktreePath, gitRoot);
        cwd.set(worktreePath);
        // Persist gitRoot alongside the new cwd so the thread's project name
        // (Kanban grouping) and repair routing survive this worktree
        // directory being deleted later — see Thread.originRepoPath.
        options.onSetCwd?.(worktreePath, gitRoot);

        // Notify other plugins (e.g. Vault Bridges auto-flip) that this
        // session moved into a worktree. Fire-and-forget: listeners must
        // never break the tool result.
        onWorktreeChanged?.({ repoPath: gitRoot, worktreePath, branch: branchName });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              worktreePath,
              branch: branchName,
              gitRoot,
              message: 'Worktree created. Send any follow-up message to continue in the worktree.',
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  const boundExitWorktree = tool(
    'exit_worktree',
    [
      'Removes a git worktree created by enter_worktree and restores the session working directory to the original repo root.',
      'If no path is provided, removes the current effective working directory if it is a tracked worktree.',
    ].join(' '),
    {
      worktreePath: z.string().optional().describe(
        'Absolute path of the worktree to remove. Defaults to the current effective working directory.',
      ),
      force: z.boolean().optional().describe(
        'Force removal even if the worktree has uncommitted changes (default: false).',
      ),
    },
    async (args, _extra) => {
      try {
        const targetPath = args.worktreePath ?? cwd.get();
        const originalRepo = cwd.activeWorktrees.get(targetPath);

        if (!originalRepo) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `No tracked worktree at: ${targetPath}. Use \`git worktree remove\` manually if needed.`,
              }),
            }],
            isError: true,
          };
        }

        const removeArgs = ['worktree', 'remove', targetPath];
        if (args.force) removeArgs.push('--force');

        try {
          execFileSync('git', removeArgs, { cwd: originalRepo, encoding: 'utf8' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `git worktree remove failed: ${msg}` }) }],
            isError: true,
          };
        }

        cwd.activeWorktrees.delete(targetPath);
        cwd.set(originalRepo);
        // Back in the origin repo itself — clear originRepoPath explicitly
        // (cwd now resolves its own project name via the normal git walk).
        options.onSetCwd?.(originalRepo, null);

        // Notify other plugins (e.g. Vault Bridges auto-flip) that this
        // session left its worktree and the directory was removed.
        onWorktreeChanged?.({ repoPath: originalRepo, worktreePath: null, removedWorktreePath: targetPath });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              removedWorktree: targetPath,
              restoredCwd: originalRepo,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );


  const toolDefs: Array<ToolDef | undefined> = [
    boundSetWorkingDirectory as ToolDef | undefined,
    boundEnterWorktree as ToolDef | undefined,
    boundExitWorktree as ToolDef | undefined,
  ];
  const toolNames = [
    'set_working_directory',
    'enter_worktree',
    'exit_worktree',
  ];
  return Object.fromEntries(toolNames.flatMap((name, i): Array<[string, ToolDef]> => (toolDefs[i] ? [[name, toolDefs[i]!]] : [])));
}
