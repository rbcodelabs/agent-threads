/**
 * Maps a daemon connection state to the pill shown in the thread header and
 * the Settings list. One mapping, so the wording is identical everywhere and
 * the screenshot harness renders what production renders.
 */
import type { ConnectionState } from './DaemonClient';

export type PillKind = 'connected' | 'connecting' | 'reconnecting' | 'unreachable' | 'protocol' | 'auth';
export type PillTone = 'ok' | 'pending' | 'warn' | 'error';

export interface ConnectionPill {
  kind: PillKind;
  tone: PillTone;
  label: string;
  /** Tooltip / aria detail. */
  title: string;
}

export function connectionPill(state: ConnectionState | undefined, daemonName: string): ConnectionPill {
  if (!state || state.status === 'idle') {
    return { kind: 'connecting', tone: 'pending', label: 'Connecting', title: `Not connected to ${daemonName} yet` };
  }
  switch (state.status) {
    case 'connected':
      return { kind: 'connected', tone: 'ok', label: 'Connected', title: `Connected to ${daemonName}${state.info ? ` (daemon ${state.info.daemonVersion})` : ''}` };
    case 'connecting':
      return { kind: 'connecting', tone: 'pending', label: 'Connecting', title: `Connecting to ${daemonName}` };
    case 'reconnecting':
      return { kind: 'reconnecting', tone: 'warn', label: 'Reconnecting', title: `Lost the connection to ${daemonName}; retrying (attempt ${state.attempt}). A running turn continues on the daemon.` };
    case 'unreachable':
      return { kind: 'unreachable', tone: 'error', label: 'Daemon unreachable', title: `${daemonName} is not answering${state.detail ? `: ${state.detail}` : ''}. A running turn continues there; this keeps retrying.` };
    case 'incompatible':
      return { kind: 'protocol', tone: 'error', label: 'Protocol too old', title: state.detail ?? `${daemonName} and this plugin do not speak the same protocol version. Update the older side.` };
    case 'unauthorized':
      return { kind: 'auth', tone: 'error', label: 'Token rejected', title: state.detail ?? `${daemonName} did not accept the access token. Check it under Settings, Remote daemons.` };
    case 'closed':
      return { kind: 'unreachable', tone: 'error', label: 'Disconnected', title: `The connection to ${daemonName} was closed` };
  }
}
