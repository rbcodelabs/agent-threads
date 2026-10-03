/**
 * Pure-JS git for skill sources (isomorphic-git), so nothing depends on a `git`
 * binary being installed. Only the handful of operations skill sources need:
 * shallow clone, pin to a ref, check for upstream changes, and fast-forward.
 *
 * isomorphic-git is `require`d lazily so it stays out of the startup path and
 * out of the mobile/harness bundles until a skill-source operation runs.
 *
 * Auth: none by default (public repos). `setGitAuthProvider` lets a caller
 * supply a token for private repos.
 */
import * as fs from 'fs';

type IsoGit = typeof import('isomorphic-git');
type HttpClient = import('isomorphic-git').HttpClient;

/** Marker ref recording the commit this tool last synced a clone to. HEAD moving off it means local commits. */
const SYNCED_REF = 'refs/skill-sources/synced';

const LOCAL_COMMITS = 'Clone has local commits; not updating it (fast-forward only)';

let httpOverride: HttpClient | undefined;
let authProvider: ((url: string) => { username: string; password: string } | undefined) | undefined;

/** Test seam: replace the HTTP transport (e.g. to serve a local repo without a network). */
export function setGitHttpClient(client: HttpClient | undefined): void {
  httpOverride = client;
}

/** Supplies credentials for private repos, called with the remote URL. Return undefined for anonymous. */
export function setGitAuthProvider(provider: typeof authProvider): void {
  authProvider = provider;
}

function iso(): IsoGit {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('isomorphic-git') as IsoGit;
}

function http(): HttpClient {
  if (httpOverride) return httpOverride;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('isomorphic-git/http/node') as HttpClient;
}

function authCallback(): { onAuth?: (url: string) => { username: string; password: string } | undefined } {
  return authProvider ? { onAuth: authProvider } : {};
}

/** True when `ancestor` is reachable from `oid`. Shallow history it cannot walk counts as "no". */
function isAncestor(git: IsoGit, dir: string, ancestor: string, oid: string): Promise<boolean> {
  return git.isDescendent({ fs, dir, oid, ancestor, depth: -1 }).catch(() => false);
}

/** Shallow-clones `url` into `dir` (default branch, or pinned to a tag/branch `ref`, detached). */
export async function gitClone(url: string, dir: string, options: { ref?: string } = {}): Promise<void> {
  const git = iso();
  const base = { fs, http: http(), dir, ...authCallback() };
  if (!options.ref) {
    await git.clone({ ...base, url, depth: 1, singleBranch: true, noTags: true });
  } else {
    await git.init({ fs, dir, defaultBranch: 'main' });
    await git.addRemote({ fs, dir, remote: 'origin', url });
    const { fetchHead } = await git.fetch({ ...base, url, remote: 'origin', ref: options.ref, depth: 1, singleBranch: true, tags: false });
    if (!fetchHead) throw new Error(`Ref "${options.ref}" was not found in ${url}`);
    await git.checkout({ fs, dir, ref: fetchHead, force: true });
  }
  await git.writeRef({ fs, dir, ref: SYNCED_REF, value: await git.resolveRef({ fs, dir, ref: 'HEAD' }), force: true });
}

/** Moves an existing clone to a pinned tag/branch (detached). Throws on failure; deletes nothing. */
export async function gitCheckoutRef(dir: string, ref: string): Promise<void> {
  const git = iso();
  const url = await git.getConfig({ fs, dir, path: 'remote.origin.url' }) as string | undefined;
  if (!url) throw new Error('Clone has no origin remote');
  const { fetchHead } = await git.fetch({ fs, http: http(), dir, url, remote: 'origin', ref, depth: 1, singleBranch: true, tags: false, ...authCallback() });
  if (!fetchHead) throw new Error(`Ref "${ref}" was not found in ${url}`);
  await git.checkout({ fs, dir, ref: fetchHead });
  await git.writeRef({ fs, dir, ref: SYNCED_REF, value: fetchHead, force: true });
}

export interface GitSyncResult {
  /** True when upstream's tip differs from the clone's HEAD. */
  behind: boolean;
  /** True when the working copy was actually moved to upstream's tip. */
  updated: boolean;
}

/**
 * Fetches the clone's current branch from origin. With `apply`, fast-forwards the
 * working copy to the fetched tip. Refuses (throws) when:
 * - HEAD is detached (nothing to follow),
 * - the clone has commits this tool did not put there (it would discard them),
 * - checkout would overwrite a locally modified file (isomorphic-git's conflict check).
 * On a checkout failure the branch is put back, so a failed update changes nothing.
 */
export async function gitSync(dir: string, options: { apply: boolean }): Promise<GitSyncResult> {
  const git = iso();
  const branch = await git.currentBranch({ fs, dir });
  if (!branch) throw new Error('Clone is on a detached HEAD, so there is no branch to update');
  const url = await git.getConfig({ fs, dir, path: 'remote.origin.url' }) as string | undefined;
  if (!url) throw new Error('Clone has no origin remote');

  const localOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  let syncedOid: string | undefined;
  try { syncedOid = await git.resolveRef({ fs, dir, ref: SYNCED_REF }); } catch { /* clone predates the marker */ }
  if (syncedOid) {
    // HEAD behind the marker (e.g. rolled back by hand) is just "behind"; anything else is local work.
    if (syncedOid !== localOid && !(await isAncestor(git, dir, localOid, syncedOid))) throw new Error(LOCAL_COMMITS);
  } else {
    // Legacy clone (made by the git CLI): HEAD must match the last-fetched
    // origin tip, or be an ancestor of it (an old check fetched without pulling).
    let tracked: string | undefined;
    try { tracked = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }); } catch { /* none recorded */ }
    if (tracked && tracked !== localOid) {
      if (!(await isAncestor(git, dir, localOid, tracked))) throw new Error(LOCAL_COMMITS);
    }
  }
  // HEAD is verified clean of local commits: record it, so later runs need no ancestry walk.
  await git.writeRef({ fs, dir, ref: SYNCED_REF, value: localOid, force: true });

  const { fetchHead } = await git.fetch({ fs, http: http(), dir, url, remote: 'origin', ref: branch, depth: 1, singleBranch: true, tags: false, ...authCallback() });
  if (!fetchHead) throw new Error(`Branch "${branch}" was not found upstream`);
  const behind = fetchHead !== localOid;
  if (!behind || !options.apply) return { behind, updated: false };

  const branchRef = `refs/heads/${branch}`;
  await git.writeRef({ fs, dir, ref: branchRef, value: fetchHead, force: true });
  try {
    await git.checkout({ fs, dir, ref: branch });
  } catch (err) {
    await git.writeRef({ fs, dir, ref: branchRef, value: localOid, force: true });
    throw err;
  }
  await git.writeRef({ fs, dir, ref: SYNCED_REF, value: fetchHead, force: true });
  return { behind, updated: true };
}
