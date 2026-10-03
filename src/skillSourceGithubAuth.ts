/**
 * Credentials for private skill-source repos, from Geode's GitHub connection
 * (the Geode GitHub App). Plugged into gitClient via `setGitAuthProvider`.
 *
 * Safety:
 * - Only ever answers for `https://github.com/...`. A skill-source URL is user
 *   supplied, so the token must never go to another host.
 * - Only called after the server has already answered 401, so public repos
 *   stay anonymous and never fetch a token.
 * - The token is handed straight to isomorphic-git and never logged or stored.
 */
import type { GitAuthProvider } from './gitClient';
import type { GithubCredentialBroker } from './githubCredentials';

export interface GithubGitAuthDeps {
  broker: Pick<GithubCredentialBroker, 'available' | 'getToken' | 'requireRepo'>;
  /** The `githubConnectionEnabled` setting. */
  isEnabled(): boolean;
}

/** `owner/repo` for an https://github.com URL, or null for anything else (other hosts, plain http, no repo path). */
export function githubRepoFromUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com' || u.username || u.password) return null;
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function createGithubGitAuth(deps: GithubGitAuthDeps): GitAuthProvider {
  const usable = (url: string): string | null =>
    deps.isEnabled() && deps.broker.available ? githubRepoFromUrl(url) : null;
  return {
    async onAuth(url) {
      if (!usable(url)) return undefined;
      // A GithubConnectionError (not connected, reauth needed, ...) propagates: its
      // message already says what to do, which beats a bare "HTTP Error: 401".
      const token = await deps.broker.getToken();
      return { username: 'x-access-token', password: token };
    },
    async onAuthFailure(url) {
      const repo = usable(url);
      // Throws repo_not_granted (with the install URL) when the App is not installed on it.
      if (repo) await deps.broker.requireRepo(repo);
    },
  };
}
