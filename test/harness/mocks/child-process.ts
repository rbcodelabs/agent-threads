/** Stub for Node's child_process module in the Playwright browser harness. */

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

interface StubChildProcess {
  stdin: { writable: boolean; write: (_data: string) => void; end: () => void };
  stdout: { on: (_event: string, _listener: (...args: unknown[]) => void) => void };
  stderr: { on: (_event: string, _listener: (...args: unknown[]) => void) => void };
  on: (_event: string, _listener: (...args: unknown[]) => void) => void;
  kill: () => void;
}

/**
 * Minimal browser-safe stand-in for the Codex app-server process. The harness
 * does not create a Codex session, but esbuild still needs the named export
 * that CodexSession imports from Node's child_process module.
 */
interface StubSpawnedProcess extends StubChildProcess {
  stdout: { on: (_event: string, _listener: (_chunk: Buffer) => void) => void };
  stderr: { on: (_event: string, _listener: (_chunk: Buffer) => void) => void };
  on: (_event: string, _listener: (...args: unknown[]) => void) => void;
  kill: () => boolean;
}

export const spawn = (_command: string, _args?: string[], _options?: unknown): StubSpawnedProcess => {
  // Lets a spec assert which CLI the host sign-in flow launched (`claude auth login`).
  (globalThis as { __spawnCalls?: string[][] }).__spawnCalls?.push([_command, ...(_args ?? [])]);
  return stubSpawned();
};
const stubSpawned = (): StubSpawnedProcess => ({
  stdin: { write: () => {}, end: () => {} },
  stdout: { on: () => {} },
  stderr: { on: () => {} },
  on: () => {},
  kill: () => true,
});

export const exec = (
  _cmd: string,
  _optsOrCb?: Record<string, unknown> | ExecCallback,
  _cb?: ExecCallback,
): StubChildProcess => {
  // Normalise overloaded signatures: exec(cmd, cb) or exec(cmd, opts, cb)
  const callback = typeof _optsOrCb === 'function' ? _optsOrCb : _cb;
  // Invoke asynchronously so callers can chain .stdin before the callback fires
  if (callback) setTimeout(() => callback(null, '', ''), 0);
  return stubProcess();
};

function stubProcess(): StubChildProcess {
  const stream = { on: () => {} };
  return {
    stdin: { writable: true, write: () => {}, end: () => {} },
    stdout: stream,
    stderr: stream,
    on: () => {},
    kill: () => {},
  };
}

/**
 * Stub for the synchronous git-shelling calls in skillManager.ts (staleness
 * checks, pull-updates, marketplace installs). None of the screenshot tests
 * click buttons that reach these code paths, so an empty buffer is enough to
 * satisfy the static `import { execSync } from 'child_process'` binding
 * without crashing the harness bundle.
 */
export const execSync = (_cmd: string, _opts?: unknown): Buffer => Buffer.from('');

export const execFileSync = (_cmd: string, _args?: string[], _opts?: unknown): Buffer => Buffer.from('');

/**
 * Stub for the async `git clone` in `cloneGithubSource`. Same reasoning as
 * `execSync` above: no screenshot test clicks through to a clone, so reporting
 * immediate success with empty output is enough to satisfy the static
 * `import { execFile } from 'child_process'` binding.
 */
export const execFile = (
  _cmd: string,
  _args?: string[] | Record<string, unknown> | ExecCallback,
  _optsOrCb?: Record<string, unknown> | ExecCallback,
  _cb?: ExecCallback,
): StubChildProcess => {
  const callback = [_args, _optsOrCb, _cb].find((arg): arg is ExecCallback => typeof arg === 'function');
  if (callback) setTimeout(() => callback(null, '', ''), 0);
  return stubProcess();
};
