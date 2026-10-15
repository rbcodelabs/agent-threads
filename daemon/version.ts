/** Injected by esbuild.daemon.mjs from package.json; `dev` under vitest / ts. */
declare const __DAEMON_VERSION__: string | undefined;

export const DAEMON_VERSION: string =
  typeof __DAEMON_VERSION__ === 'string' ? __DAEMON_VERSION__ : 'dev';

/** Oldest client the daemon will talk to. Bumped when `v1` stops being additive. */
export const MIN_CLIENT_VERSION = '0.0.0';
