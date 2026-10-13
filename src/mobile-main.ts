/**
 * mobile-main.ts
 *
 * Entry point for dist/main.mobile.js: the slim bundle loaded on Geode mobile
 * (iOS WKWebView, no Node/Electron) in place of the ~20 MB desktop main.js.
 * Obsidian ignores `main.mobile.js`, so shipping it alongside main.js is harmless.
 *
 * Contract with the host loader: CommonJS, `exports.default` is a Plugin class,
 * only `obsidian` + the CodeMirror/Lezer packages may be `require`d. The bundle
 * scan (scripts/check-mobile-bundle.mts) enforces that at build time.
 *
 * This file must never import (even transitively) anything that touches Node
 * built-ins, the Claude Agent SDK, the MCP server or sandbox code. It keeps the
 * plugin id / command ids / data.json shape of the desktop plugin so settings
 * stay compatible; unrelated desktop keys in data.json are preserved on save.
 *
 * Security (ADR-0008): the room id is a bearer secret. When the host offers
 * loadSecret/saveSecret it is kept there instead of data.json, and it is never
 * logged.
 */

import { Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import { MobileView, MOBILE_VIEW_TYPE } from './MobileView';
import { MobileThreadStore } from './MobileThreadStore';
import { RelayClient } from './RelayClient';
import { MobileSettingsTab } from './MobileSettingsTab';
import { DEFAULT_RELAY_URL, isValidRelayUrl, normalizeRoomId } from './mobilePairing';

/** Secret-store key for the room id. */
export const ROOM_ID_SECRET_KEY = 'remote-room-id';

interface RemoteAccess {
  enabled: boolean;
  roomId: string;
  relayUrl: string;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
}

type MaybePromise<T> = T | Promise<T>;

/** Geode-only secret API; absent on Obsidian and on hosts without secure storage. */
interface SecretApi {
  loadSecret?: (key: string) => MaybePromise<string | null | undefined>;
  saveSecret?: (key: string, value: string) => MaybePromise<void>;
  removeSecret?: (key: string) => MaybePromise<void>;
}

export default class ClaudeThreadsMobilePlugin extends Plugin {
  /** Whole data.json, so desktop-only keys survive a mobile save. */
  private rawData: Record<string, unknown> = {};
  remoteAccess: RemoteAccess = defaultRemoteAccess();
  relayClient: RelayClient | null = null;
  /** Stable for the plugin lifetime so views opened before pairing still update. */
  mobileStore: MobileThreadStore = new MobileThreadStore();
  /** True when the room id lives in the secret store rather than data.json. */
  private roomIdInSecretStore = false;
  private unsubscribeFrames: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      MOBILE_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new MobileView(leaf, this.relayClient, this.mobileStore),
    );

    this.addRibbonIcon('smartphone', 'Agent Threads (Mobile)', () => {
      void this.activateMobileView();
    });

    // geode://pair?roomId=…&relay=… (or obsidian://pair?… on Obsidian).
    this.registerObsidianProtocolHandler('pair', (params) => {
      void this.handlePairLink(params);
    });

    // Same id as the desktop command; desktop-only content is explained, not run.
    this.addCommand({
      id: 'generate-diagnostics-report',
      name: 'Generate diagnostics report',
      callback: () => {
        new Notice(this.diagnosticsSummary());
      },
    });

    this.addSettingTab(new MobileSettingsTab(this.app, this));

    if (this.remoteAccess.roomId) this.initMobileRelayClient();
  }

  onunload(): void {
    this.relayClient?.disconnect();
    this.relayClient = null;
  }

  // ── Settings ────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Record<string, unknown> | null;
    this.rawData = data && typeof data === 'object' ? { ...data } : {};
    const stored = (this.rawData.remoteAccess ?? {}) as Partial<RemoteAccess>;
    this.remoteAccess = { ...defaultRemoteAccess(), ...stored };

    const secret = await this.readSecret();
    if (secret) {
      this.remoteAccess.roomId = secret;
      this.roomIdInSecretStore = true;
    } else if (this.remoteAccess.roomId) {
      // Migrate a room id left in plain data.json by an earlier version.
      await this.moveRoomIdToSecretStore();
    }
  }

  async saveSettings(): Promise<void> {
    const ra: RemoteAccess = { ...this.remoteAccess };
    if (this.roomIdInSecretStore) ra.roomId = '';
    this.rawData = { ...this.rawData, remoteAccess: ra };
    await this.saveData(this.rawData);
  }

  /** Store a new room id (secret store when available, else data.json). */
  async setRoomId(roomId: string): Promise<void> {
    this.remoteAccess.roomId = roomId;
    this.remoteAccess.enabled = true;
    this.roomIdInSecretStore = false;
    await this.moveRoomIdToSecretStore();
    await this.saveSettings();
  }

  async clearRoomId(): Promise<void> {
    this.remoteAccess.roomId = '';
    this.remoteAccess.enabled = false;
    this.roomIdInSecretStore = false;
    const api = this.secretApi();
    if (api.removeSecret) {
      try {
        await api.removeSecret(ROOM_ID_SECRET_KEY);
      } catch {
        // Nothing sensitive to report; the in-memory id is already cleared.
      }
    }
    await this.saveSettings();
  }

  /** True when the host's secure store (not data.json) holds the room id. */
  isRoomIdInSecretStore(): boolean {
    return this.roomIdInSecretStore;
  }

  private secretApi(): SecretApi {
    return this as unknown as SecretApi;
  }

  private async readSecret(): Promise<string | null> {
    const api = this.secretApi();
    if (typeof api.loadSecret !== 'function') return null;
    try {
      const value = await api.loadSecret(ROOM_ID_SECRET_KEY);
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  /** Best effort: on failure the room id simply stays in data.json. */
  private async moveRoomIdToSecretStore(): Promise<void> {
    const api = this.secretApi();
    if (typeof api.saveSecret !== 'function' || !this.remoteAccess.roomId) return;
    try {
      await api.saveSecret(ROOM_ID_SECRET_KEY, this.remoteAccess.roomId);
      this.roomIdInSecretStore = true;
      await this.saveSettings();
    } catch {
      this.roomIdInSecretStore = false;
    }
  }

  // ── Pairing / relay ─────────────────────────────────────────────────────

  private async handlePairLink(params: Record<string, string>): Promise<void> {
    const roomId = normalizeRoomId(params['roomId'] ?? '');
    if (!roomId) {
      new Notice('Invalid pairing link: missing or malformed room code');
      return;
    }
    const relay = params['relay'];
    if (relay && !isValidRelayUrl(relay)) {
      new Notice('Invalid pairing link: relay must be a ws:// or wss:// URL');
      return;
    }
    if (relay) this.remoteAccess.relayUrl = relay;
    await this.setRoomId(roomId);
    this.initMobileRelayClient();
    new Notice('Paired with desktop successfully');
    await this.activateMobileView();
  }

  initMobileRelayClient(): void {
    const ra = this.remoteAccess;
    if (!ra.roomId) return;

    this.relayClient?.disconnect();
    this.unsubscribeFrames?.();
    const client = new RelayClient('mobile', ra.relayUrl || DEFAULT_RELAY_URL, ra.roomId);
    this.relayClient = client;
    this.unsubscribeFrames = client.onFrame((frame) => this.mobileStore.applyFrame(frame));
    client.connect();
  }

  disconnectRelay(): void {
    this.relayClient?.disconnect();
    this.relayClient = null;
    this.unsubscribeFrames?.();
    this.unsubscribeFrames = null;
  }

  async activateMobileView(): Promise<void> {
    const { workspace } = this.app;
    // Views capture the relay client at creation; drop stale ones so the
    // reopened view is bound to the current client.
    workspace.detachLeavesOfType?.(MOBILE_VIEW_TYPE);
    const leaf = workspace.getRightLeaf(false) as WorkspaceLeaf | null;
    if (!leaf) return;
    await leaf.setViewState({ type: MOBILE_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  private diagnosticsSummary(): string {
    const connected = this.relayClient?.isConnected() ?? false;
    const storage = this.roomIdInSecretStore ? 'secure store' : 'data.json';
    return `Agent Threads (mobile): ${connected ? 'connected' : 'not connected'}; ` +
      `paired: ${this.remoteAccess.roomId ? 'yes' : 'no'}; room id in ${storage}. ` +
      'Full diagnostics reports are desktop only.';
  }
}

function defaultRemoteAccess(): RemoteAccess {
  return {
    enabled: false,
    roomId: '',
    relayUrl: DEFAULT_RELAY_URL,
    pairingCode: null,
    pairingExpiresAt: null,
  };
}
