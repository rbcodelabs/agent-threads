/**
 * MobileSettingsTab.ts
 *
 * Minimal settings tab for the slim mobile bundle: pair with a desktop by
 * pasting a code or link (the deep link is the primary path), see status,
 * disconnect, and change the relay. Deliberately independent of SettingsTab.ts,
 * which drags in the whole desktop plugin.
 */

import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_RELAY_URL, formatRoomIdAsCode, isValidRelayUrl, parsePairingInput } from './mobilePairing';
import type ClaudeThreadsMobilePlugin from './mobile-main';

export class MobileSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly mobile: ClaudeThreadsMobilePlugin) {
    super(app, mobile);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const plugin = this.mobile;
    const ra = plugin.remoteAccess;
    const connected = plugin.relayClient?.isConnected() ?? false;

    containerEl.createEl('p', {
      text: connected ? 'Connected to desktop.' : 'Not connected to desktop.',
      cls: connected ? 'ct-mobile-status-ok' : 'ct-mobile-status-disconnected',
    });

    new Setting(containerEl).setName('Pair with desktop').setHeading();
    containerEl.createEl('p', {
      text: 'On your desktop, open Settings > Agent Threads > Remote, enable remote access and show the pairing QR code. Scan it with your phone camera to pair automatically, or paste the code or link below.',
      cls: 'ct-settings-desc',
    });
    containerEl.createEl('p', {
      text: 'Pairing uses a shared-link relay: anyone holding the room code can connect, so keep it private.',
      cls: 'ct-settings-desc ct-pairing-warning',
    });

    let input = '';
    new Setting(containerEl)
      .setName('Pairing code or link')
      .setDesc('Paste the code (XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX) or the full geode:// link shown on desktop.')
      .addText((text) => {
        text.setPlaceholder('XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX').onChange((v) => {
          input = v;
        });
      })
      .addButton((btn) =>
        btn.setButtonText('Connect').setCta().onClick(async () => {
          const parsed = parsePairingInput(input);
          if (!parsed) {
            new Notice('Invalid pairing code. Copy the code exactly from desktop Settings.');
            return;
          }
          if (parsed.relayUrl) {
            if (!isValidRelayUrl(parsed.relayUrl)) {
              new Notice('Invalid pairing link: relay must be a ws:// or wss:// URL');
              return;
            }
            plugin.remoteAccess.relayUrl = parsed.relayUrl;
          }
          await plugin.setRoomId(parsed.roomId);
          plugin.initMobileRelayClient();
          new Notice('Connecting to desktop…');
          this.display();
        }),
      );

    if (ra.roomId) {
      // Never render the full room id: it is a bearer secret.
      const masked = formatRoomIdAsCode(ra.roomId).replace(/^.{27}/, '••••••••-••••••••-••••••••-');
      new Setting(containerEl)
        .setName('Paired room')
        .setDesc(`${masked}${plugin.isRoomIdInSecretStore() ? ' (stored in secure storage)' : ''}`)
        .addButton((btn) =>
          btn.setButtonText('Disconnect').setWarning().onClick(async () => {
            plugin.disconnectRelay();
            await plugin.clearRoomId();
            this.display();
          }),
        );
    }

    new Setting(containerEl).setName('Advanced').setHeading();
    new Setting(containerEl)
      .setName('Relay URL')
      .setDesc('WebSocket relay server. Change only if self-hosting.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_RELAY_URL)
          .setValue(ra.relayUrl)
          .onChange(async (value) => {
            const next = value.trim() || DEFAULT_RELAY_URL;
            if (!isValidRelayUrl(next)) return;
            ra.relayUrl = next;
            await plugin.saveSettings();
          }),
      );
  }
}
