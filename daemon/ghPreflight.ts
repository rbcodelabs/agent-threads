/**
 * Advisory GitHub-auth check run when a session starts. If neither a token (pushed or in the daemon's environment)
 * nor a `gh` login is available, the agent's push/PR commands will fail mid-task, so say so up front.
 *
 * The `gh auth status` probe is the doctor's (`checkGh`) and its outcome is cached briefly so a burst of sessions
 * costs one subprocess. The notice is a string for the caller to show; this module never throws.
 */
import { checkGh, realProbes, type Probes } from './cmd/doctor';

export const GH_AUTH_NOTICE = 'GitHub auth unavailable in the daemon: push/PR commands will fail. Reconnect GitHub on the host, or set GH_TOKEN in the daemon environment.';
export const GH_PREFLIGHT_CACHE_MS = 60_000;

export interface GhAuthPreflightOptions {
  /** A token is already available (pushed credential or the daemon's own environment). */
  hasToken(): boolean;
  probes?: Probes;
  now?: () => number;
  cacheMs?: number;
}

export function createGhAuthPreflight(opts: GhAuthPreflightOptions): () => Promise<string | null> {
  const now = opts.now ?? (() => Date.now());
  const cacheMs = opts.cacheMs ?? GH_PREFLIGHT_CACHE_MS;
  let cached: { at: number; loggedOut: Promise<boolean> } | undefined;

  const probeLoggedOut = async (): Promise<boolean> => {
    try {
      const results = await checkGh(opts.probes ?? realProbes());
      // A missing gh binary has no `gh-auth` result; the doctor already reports that, and git over https may still work.
      return results.some((r) => r.id === 'gh-auth' && r.status !== 'pass');
    } catch { return false; }
  };

  return async () => {
    if (opts.hasToken()) return null;
    if (!cached || now() - cached.at >= cacheMs) cached = { at: now(), loggedOut: probeLoggedOut() };
    return (await cached.loggedOut) ? GH_AUTH_NOTICE : null;
  };
}
