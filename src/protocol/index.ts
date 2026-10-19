/**
 * Daemon wire protocol (design section 3). Pure TypeScript: no Obsidian, DOM
 * or Node-only runtime dependency, so it stays inside the core boundary.
 * This barrel is a core entry (scripts/core-closure.mts) so every protocol
 * file is in the checked closure.
 */
export * from './relayTypes';
export * from './sessionEvents';
export * from './spec';
export * from './hostTools';
export * from './commands';
export * from './mcpSync';
export * from './envelope';
export * from './journal';
export * from './journalPolicy';
export * from './codec';
