/**
 * Exit codes shared by every client-side `agent-threads` command, and the one error
 * type that carries them. Documented in docs/remote-daemon.md ("CLI").
 */
import { DaemonCommandError } from '../../src/remote/DaemonClient';

export const EXIT = {
  OK: 0,
  /** The command ran and failed: the turn errored, the daemon refused it, a check failed. */
  FAILED: 1,
  /** Bad flags or arguments. */
  USAGE: 2,
  /** The daemon could not be reached (or did not answer in time). */
  UNREACHABLE: 3,
  /** The daemon rejected the token, or the token's scope is too low for the command. */
  UNAUTHORIZED: 4,
  /** Plugin/CLI and daemon do not speak the same protocol version. */
  INCOMPATIBLE: 5,
  /** `run`: the turn was interrupted before it finished. */
  INTERRUPTED: 6,
  /** `run`: a permission/question was raised and nobody could answer it (unattended, or no terminal). */
  NEEDS_INPUT: 7,
  /**
   * `serve` stopped on purpose to be restarted into a newer bundle (auto-update). Non-zero (EX_TEMPFAIL) so a
   * `Restart=on-failure` supervisor brings it back; a clean 0 would leave it down. See docs/remote-daemon.md.
   */
  RESTART: 75,
  /** Ctrl-C, by shell convention. */
  SIGINT: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure with a message for the user and the exit code it maps to. */
export class CliError extends Error {
  constructor(message: string, readonly code: ExitCode = EXIT.FAILED) {
    super(message);
    this.name = 'CliError';
  }
}

/** Map a daemon/command failure onto the CLI's exit codes. */
export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof CliError) return err.code;
  if (err instanceof DaemonCommandError) {
    switch (err.code) {
      case 'unauthorized':
        return EXIT.UNAUTHORIZED;
      // 'forbidden' is both "your token's scope is too low" (a credentials problem) and "the daemon's policy
      // refuses this folder or mode" (the command failed); only the first is an authorization exit code.
      case 'forbidden':
        return /needs scope/.test(err.message) ? EXIT.UNAUTHORIZED : EXIT.FAILED;
      case 'unreachable':
      case 'timeout':
      case 'closed':
        return EXIT.UNREACHABLE;
      case 'incompatible':
      case 'unsupported_version':
        return EXIT.INCOMPATIBLE;
      default:
        return EXIT.FAILED;
    }
  }
  return EXIT.FAILED;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
