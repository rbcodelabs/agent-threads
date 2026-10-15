/** What the client commands need from the process, injectable so tests can drive them without one. */
import type { WebSocketFactory } from '../../src/remote/DaemonClient';
import type { Prompter } from './follow';

/** Text writers: no newline is added, so a streamed token can be written as it arrives. */
export interface RawIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CliRuntime {
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdinIsTTY: boolean;
  /** Where `run` starts a session when the daemon is on this machine and no --cwd is given. */
  cwd: string;
  /** Test seam: the WebSocket constructor (default: the `ws` package). */
  createSocket?: WebSocketFactory;
  /** Test seam: a scripted terminal. */
  prompter?: Prompter;
  /** Register a Ctrl-C handler; returns the remover. */
  onInterrupt(handler: () => void): () => void;
}

export function processRuntime(): CliRuntime {
  return {
    env: process.env,
    stdin: process.stdin,
    stdinIsTTY: process.stdin.isTTY === true,
    cwd: process.cwd(),
    onInterrupt(handler) {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
      return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); };
    },
  };
}
