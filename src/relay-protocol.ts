/**
 * Re-export shim. The relay v1 payload types moved to `src/protocol/relayTypes.ts`
 * so the daemon protocol can share them; this path stays so RelayClient,
 * MobileThreadStore and the mobile bundle are untouched. Relay v1 is frozen.
 */
export type {
  SerializedMessage,
  SerializedThread,
  RelayFrame,
  RemoteCommand,
  ConnectionState,
  PendingPermission,
  PendingQuestion,
} from './protocol/relayTypes';
