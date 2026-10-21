/**
 * The repositories a daemon keeps cloned: parsing the settings text, wording the status, and the commands over the
 * daemon's live connection. Pure apart from `createRemoteReposSource`; no Node or Obsidian imports (mobile-safe).
 * Failures are values so the settings dialog can say why instead of throwing.
 */
import { REPO_NAME, type RepoSpec, type RepoStatus, type ReposReply } from '../protocol';
import { DaemonCommandError } from './DaemonClient';
import type { RemoteDaemonResolver } from './DaemonRegistry';

/** `https://github.com/owner/repo.git` -> `repo`; undefined when nothing usable can be derived. */
export function defaultRepoName(url: string): string | undefined {
  const tail = url.trim().replace(/[/\\]+$/, '').split(/[/:\\]/).pop() ?? '';
  const name = tail.replace(/\.git$/i, '');
  return REPO_NAME.test(name) ? name : undefined;
}

export interface ParsedRepoLines {
  repos: RepoSpec[];
  /** One message per bad line (1-based line numbers), for the dialog. */
  errors: string[];
}

/**
 * One repository per line: `<url> [branch] [as name]`. Blank lines and `#` comments are skipped. The name defaults to
 * the last part of the URL.
 */
export function parseRepoLines(text: string): ParsedRepoLines {
  const repos: RepoSpec[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = (msg: string): void => { errors.push(`Line ${i + 1}: ${msg}`); };
    const parts = line.split(/\s+/);
    const url = parts[0];
    let branch: string | undefined;
    let name: string | undefined;
    for (let p = 1; p < parts.length; p++) {
      if (parts[p] === 'as' && parts[p + 1]) { name = parts[++p]; continue; }
      if (branch === undefined) { branch = parts[p]; continue; }
      at(`unexpected "${parts[p]}"`);
      return;
    }
    if (/^https?:\/\/[^/\s]*@/i.test(url)) { at('remove the credentials from the URL; the token is stored on the daemon'); return; }
    const finalName = name ?? defaultRepoName(url);
    if (!finalName || !REPO_NAME.test(finalName)) { at(name ? `"${name}" is not a valid name` : 'could not derive a name from the URL; add "as <name>"'); return; }
    if (seen.has(finalName.toLowerCase())) { at(`the name "${finalName}" is used twice`); return; }
    seen.add(finalName.toLowerCase());
    repos.push({ name: finalName, url, ...(branch ? { branch } : {}) });
  });
  return { repos, errors };
}

/** The inverse of `parseRepoLines`, for showing what the daemon has. */
export function formatRepoLines(repos: readonly RepoSpec[]): string {
  return repos.map((r) => {
    const derived = defaultRepoName(r.url) === r.name;
    return [r.url, ...(r.branch ? [r.branch] : []), ...(derived ? [] : ['as', r.name])].join(' ');
  }).join('\n');
}

const STATE_LABEL: Record<RepoStatus['state'], string> = {
  not_cloned: 'not cloned yet',
  syncing: 'syncing…',
  cloned: 'cloned',
  stale: 'stale',
  auth_failed: 'auth failed',
  error: 'failed',
};

/** One line for the settings dialog; anything other than cloned/syncing is a problem. */
export function describeRepo(r: RepoStatus, now: number = Date.now()): { text: string; ok: boolean } {
  const ok = r.state === 'cloned' || r.state === 'syncing';
  const age = r.syncedAt !== undefined ? ` · fetched ${formatAge(now - r.syncedAt)}` : '';
  const why = r.error && (r.state === 'auth_failed' || r.state === 'error' || r.state === 'stale') ? ` (${r.error})` : '';
  return { text: `${r.name}: ${STATE_LABEL[r.state]}${r.state === 'cloned' || r.state === 'stale' ? age : ''}${why}`, ok };
}

function formatAge(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

export type ReposLoad =
  | { ok: true; value: ReposReply }
  | { ok: false; reason: 'unsupported' | 'forbidden' | 'error'; detail: string };

export interface RemoteReposSource {
  status(daemonId: string): Promise<ReposLoad>;
  /** Replace the list (when given) and sync. Needs an admin token on the daemon. */
  sync(daemonId: string, repos?: RepoSpec[]): Promise<ReposLoad>;
}

const NEEDS_ADMIN = 'Changing repositories needs an admin token. Create one on the daemon (`agent-threads token create --scope admin`) and use it for this daemon.';

export function createRemoteReposSource(resolver: RemoteDaemonResolver): RemoteReposSource {
  const run = async (daemonId: string, type: 'repos.status' | 'repos.sync', args: Record<string, unknown>): Promise<ReposLoad> => {
    const client = resolver.clientFor(daemonId);
    if (!client) return { ok: false, reason: 'error', detail: 'This daemon is no longer configured.' };
    try {
      const r = (await client.command(type, args, { timeoutMs: 15_000 })) as unknown as ReposReply;
      return { ok: true, value: { root: String(r.root ?? ''), repos: Array.isArray(r.repos) ? r.repos : [] } };
    } catch (e) {
      if (e instanceof DaemonCommandError) {
        if (e.code === 'unknown_command') return { ok: false, reason: 'unsupported', detail: 'This daemon is too old to manage repositories. Update it.' };
        if (e.code === 'forbidden') return { ok: false, reason: 'forbidden', detail: type === 'repos.sync' ? NEEDS_ADMIN : e.message };
        return { ok: false, reason: 'error', detail: e.message };
      }
      return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    status: (daemonId) => run(daemonId, 'repos.status', {}),
    sync: (daemonId, repos) => run(daemonId, 'repos.sync', repos ? { repos } : {}),
  };
}
