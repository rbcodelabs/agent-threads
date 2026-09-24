import { App, Modal, Notice, Platform, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import { DEFAULT_VAULT_FOLDER } from './productIdentity';
import type { PluginSettings, Project, LayoutDensity, ProviderMode, ScheduledItem, ScheduledItemSchedule, SkillSource, RunEvent, OAuthMcpState } from './types';
import { serializeKey } from './stt';
import { debugLog, setDebugLogging } from './logger';
import { telemetry } from './telemetry';
import { secretStorageKey } from './secretUtils';
import type { KanbanView } from './KanbanView';
import type { AgentDashboard } from './AgentDashboard';
import type { McpServerEntry } from './mcpServerStore';
// Value import is mobile-safe: mcpServerStore's only value dependency is zod
// (pure JS, no Node built-ins), so this adds nothing to module-init that
// Obsidian Mobile's require() interceptor would return null for.
// See test/unit/bundle-safety.test.ts.
import { mcpRegistrationSchema } from './mcpServerStore';
import { classifyScheduledItems, describeScheduledExecution, formatNextOccurrence } from './scheduledWorkView';

// View-type string constants, mirrored as local literals (see main.ts) so referencing
// them never triggers a static import of the desktop-only KanbanView/AgentDashboard
// modules, which transitively pull in Node built-ins and the Claude Agent SDK. A value
// import here loads those modules at bundle-init on every platform, bypassing the
// Platform.isMobile guard in main.ts and crashing the plugin on Obsidian Mobile.
const KANBAN_VIEW_TYPE = 'claude-threads:kanban';
const AGENT_VIEW_TYPE = 'claude-threads:agents';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the Web Viewer core plugin is enabled.
 * The Web Viewer's internal plugin ID in Obsidian's core plugin registry is "webviewer".
 */
function formatOAuthDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/** Status dot color + human-readable label for one OAuth MCP server row. */
export function describeOAuthMcpStatus(state: OAuthMcpState | undefined): { label: string; tone: 'green' | 'yellow' | 'red' | 'grey' } {
  if (!state) return { label: 'Not configured', tone: 'grey' };
  if (state.status === 'connected') {
    if (state.accessTokenExpiresAt !== undefined) {
      const remaining = state.accessTokenExpiresAt - Date.now();
      if (remaining < 15 * 60_000) return { label: 'Expires soon', tone: 'yellow' };
      return { label: `Connected · expires in ${formatOAuthDuration(remaining)}`, tone: 'green' };
    }
    return { label: 'Connected', tone: 'green' };
  }
  return { label: 'Needs re-authorization', tone: 'red' };
}

export function isWebViewerEnabled(app: App): boolean {
  type InternalPlugins = { plugins: Record<string, { enabled: boolean }> };
  return (app as unknown as { internalPlugins: InternalPlugins })
    .internalPlugins?.plugins?.['webviewer']?.enabled === true;
}

function generateRoomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatRoomIdAsCode(roomId: string): string {
  // Format as XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 8) {
    groups.push(roomId.slice(i, i + 8).toUpperCase());
  }
  return groups.join('-');
}

function maskOpenAiKey(key: string | null | undefined): string {
  if (!key) return 'No key set';
  if (key.length <= 12) return '••••••••';
  return key.slice(0, 8) + '…' + key.slice(-4);
}

/**
 * How much protection the running host's `app.secretStorage` actually gives a
 * stored secret.
 *
 *  - `encrypted`  — the host confirmed encrypted storage (Obsidian: the OS keychain).
 *  - `plaintext`  — the host confirmed it has none. Under Geode today,
 *                   `secretStorage` persists values as plaintext in
 *                   `localStorage` and `isEncryptionAvailable()` returns false.
 *  - `unknown`    — the host does not expose `isEncryptionAvailable` (it is newer
 *                   than the `SecretStorage` typings the plugin builds against),
 *                   or the call threw. Never treated as `encrypted`: the point of
 *                   this is not to promise protection the host has not confirmed.
 */
export type SecretStorageProtection = 'encrypted' | 'plaintext' | 'unknown';

/**
 * The sentence shown under any setting that writes to `app.secretStorage`,
 * describing where the value really lands on this host.
 *
 * The plugin used to say "Stored in your OS keychain." unconditionally, which is
 * simply untrue on a host without encrypted secret storage. Accurate, not
 * alarming: the non-`encrypted` wording says where the value goes and stops
 * short of calling it a vulnerability, because for a local-first vault it is the
 * same trust boundary as the vault's own files.
 */
export function describeSecretStorage(protection: SecretStorageProtection): string {
  switch (protection) {
    case 'encrypted':
      return 'Stored in your OS keychain.';
    case 'plaintext':
      return 'This app has no encrypted secret storage, so the value is kept in its local app data rather than your OS keychain.';
    default:
      return 'Stored by this app’s secret storage; it could not confirm that your OS keychain is used.';
  }
}

/**
 * Write host-accurate secret-storage copy into `el`, then correct it in place
 * once the host answers.
 *
 * Every caller renders synchronously (`PluginSettingTab.display`, `Modal.onOpen`)
 * while the answer is async, so `compose` runs twice: first with the
 * "could not confirm" wording, then with the truth. Starting pessimistic is the
 * point — a slow or missing probe leaves an accurate description on screen, never
 * a keychain promise the host does not keep.
 *
 * `compose` takes the storage sentence and returns the full string, so each site
 * keeps its own surrounding claims (injection, data.json) while the keychain
 * question itself is answered in exactly one place.
 */
export function applySecretStorageCopy(
  app: App,
  el: HTMLElement,
  compose: (storageSentence: string) => string,
): void {
  el.textContent = compose(describeSecretStorage('unknown'));
  void probeSecretStorageProtection(app).then((protection) => {
    el.textContent = compose(describeSecretStorage(protection));
  });
}

/**
 * Open the host's secret picker and hand the chosen secret name to `onPicked`
 * (empty string when the user picked nothing).
 *
 * `SecretComponent` has no "open" method, so the only way in is to render it
 * into a hidden container and click the control it draws. That container is the
 * caller's to clean up, and every failure path has to take it back down — which
 * is why `opened` gates the `finally` rather than the happy path removing it
 * inline (there the picker itself owns the container until `onChange` fires).
 *
 * The construction is wrapped because hosts disagree about the signature.
 * Obsidian's is `(app, containerEl)`; Geode's shim currently takes the
 * container alone, so `app` lands where the container is expected and the
 * constructor dies on `container.appendChild is not a function` — synchronously,
 * inside a click handler. Unguarded that is a dead button: no picker, no
 * message, and a leaked hidden div, because the removal sat past the throw. A
 * host mismatch now degrades to a Notice that points at the manual entry path,
 * with the underlying error kept in the debug log.
 */
export function openSecretPicker(app: App, onPicked: (secretName: string) => void): void {
  const tmp = document.body.createDiv();
  tmp.style.display = 'none';
  let opened = false;
  try {
    const picker = new SecretComponent(app, tmp);
    picker.onChange((secretName: string) => {
      tmp.remove();
      onPicked(secretName);
    });
    // SecretComponent renders a button — click it immediately to open the picker
    const inner = tmp.querySelector('button, input') as HTMLElement | null;
    if (!inner) throw new Error('SecretComponent rendered no control to click');
    inner.click();
    opened = true;
  } catch (err) {
    debugLog('[ClaudeThreads] secret picker unavailable on this host:', String(err));
    new Notice('The secret picker isn’t available on this host — use “Set key” to enter the key directly.');
  } finally {
    if (!opened) tmp.remove();
  }
}

/**
 * Ask the host whether its secret storage is encrypted.
 *
 * `isEncryptionAvailable` is duck-typed rather than called straight off the
 * type: it is absent from the `SecretStorage` typings the plugin builds against
 * and from older hosts at runtime, and "is this a function?" is the only safe
 * test (same posture as AttachmentWriter's host-bridge detection). Both a
 * missing method and a throwing one resolve to `unknown`, never `encrypted`.
 */
export async function probeSecretStorageProtection(app: App): Promise<SecretStorageProtection> {
  type ProbedSecretStorage = { isEncryptionAvailable?: () => boolean | Promise<boolean> };
  let probe: ProbedSecretStorage['isEncryptionAvailable'];
  try {
    probe = (app.secretStorage as unknown as ProbedSecretStorage | undefined)?.isEncryptionAvailable;
  } catch {
    return 'unknown';
  }
  if (typeof probe !== 'function') return 'unknown';
  try {
    return (await probe.call(app.secretStorage)) ? 'encrypted' : 'plaintext';
  } catch (err) {
    debugLog('[ClaudeThreads] secretStorage.isEncryptionAvailable failed:', String(err));
    return 'unknown';
  }
}

function formatScheduleDescription(schedule: ScheduledItemSchedule, gated = false): string {
  const activeHoursSuffix = schedule.activeHours
    ? ` (${schedule.activeHours.start}-${schedule.activeHours.end} only)`
    : '';
  // Flag items with a deterministic pre-check gate so it's visible at a glance
  // which scheduled tasks may skip a cycle without spawning a thread.
  const gatedSuffix = gated ? ' · gated' : '';

  if (schedule.type === 'interval') {
    const secs = schedule.intervalSeconds ?? 0;
    let base: string;
    if (secs >= 86400) base = `Every ${Math.round(secs / 86400)} day(s)`;
    else if (secs >= 3600) base = `Every ${Math.round(secs / 3600)} hour(s)`;
    else if (secs >= 60) base = `Every ${Math.round(secs / 60)} minute(s)`;
    else base = `Every ${secs}s`;
    return base + activeHoursSuffix + gatedSuffix;
  }
  if (schedule.type === 'daily') return `Daily at ${schedule.timeOfDay ?? '?'}` + activeHoursSuffix + gatedSuffix;
  if (schedule.type === 'weekly') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = (schedule.daysOfWeek ?? []).map((d) => dayNames[d] ?? d).join(', ');
    return `Weekly on ${days} at ${schedule.timeOfDay ?? '?'}` + activeHoursSuffix + gatedSuffix;
  }
  if (schedule.type === 'once') {
    const when = schedule.fireAt ? new Date(schedule.fireAt).toLocaleString() : '?';
    return `Once at ${when}` + activeHoursSuffix + gatedSuffix;
  }
  return 'Unknown schedule';
}

/** Short human label for a run-history outcome, used in the Settings history list. */
function runOutcomeLabel(outcome: RunEvent['outcome']): string {
  switch (outcome) {
    case 'fired':
      return 'Fired';
    case 'skipped-gate':
      return 'Skipped (gate)';
    case 'skipped-active-hours':
      return 'Skipped (off-hours)';
    case 'error':
      return 'Error';
    default:
      return outcome;
  }
}

/** Optional trailing detail for a run-history entry (gate exit code, error/annotation note). */
function runOutcomeDetail(event: RunEvent): string {
  if (event.note) return event.note;
  if (event.outcome === 'skipped-gate' && event.gateExitCode !== undefined) {
    return `exit ${event.gateExitCode}`;
  }
  return '';
}

/**
 * Render a collapsible run-history summary for a scheduled item beneath its
 * settings row. Shows fired/skipped/error counts over the retained window and,
 * when expanded, the most recent outcomes newest-first. No-op when the item has
 * never run.
 */
function renderRunHistory(container: HTMLElement, history: RunEvent[]): void {
  if (history.length === 0) return;

  const fired = history.filter((e) => e.outcome === 'fired').length;
  const skipped = history.filter(
    (e) => e.outcome === 'skipped-gate' || e.outcome === 'skipped-active-hours',
  ).length;
  const errored = history.filter((e) => e.outcome === 'error').length;

  const parts: string[] = [`${fired} fired`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (errored > 0) parts.push(`${errored} error${errored === 1 ? '' : 's'}`);

  const details = container.createEl('details', { cls: 'ct-run-history' });
  details.createEl('summary', {
    cls: 'ct-run-history-summary',
    text: `Run history — ${parts.join(' · ')} (last ${history.length})`,
  });

  const list = details.createEl('ul', { cls: 'ct-run-history-list' });
  // Newest first; cap the rendered rows so a long history stays scannable.
  const recent = history.slice(-20).reverse();
  for (const event of recent) {
    const li = list.createEl('li', { cls: 'ct-run-history-entry' });
    li.createEl('span', {
      cls: `ct-run-outcome ct-run-outcome-${event.outcome}`,
      text: runOutcomeLabel(event.outcome),
    });
    li.createEl('span', { cls: 'ct-run-when', text: new Date(event.ts).toLocaleString() });
    const detail = runOutcomeDetail(event);
    if (detail) li.createEl('span', { cls: 'ct-run-detail', text: detail });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Modals
// ───────────────────────────────────────────────────────────────────────────

/** Modal for entering a new OpenAI API key directly. */
class OpenAiKeyModal extends Modal {
  constructor(app: App, private onSaved: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'OpenAI API key' });
    contentEl.createEl('p', {
      text: 'Paste your API key from platform.openai.com/api-keys',
      cls: 'setting-item-description',
    });

    const input = contentEl.createEl('input', {
      type: 'password',
      placeholder: 'sk-…',
      cls: 'ct-modal-input',
    });

    const buttonRow = contentEl.createDiv('ct-modal-button-row');

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => {
      const trimmed = input.value.trim();
      if (!trimmed) return;
      this.app.secretStorage.setSecret('openai-api-key', trimmed);
      this.close();
      this.onSaved();
    });

    // Allow Enter to save
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') saveBtn.click();
    });

    // Focus the input after the modal animates in
    setTimeout(() => input.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Modal opened when an agent calls the `request_secret` MCP tool.
 * Shows the secret name and the agent's reason for requesting it, collects
 * a password-type value, writes it to `app.secretStorage` (the OS keychain on a
 * host that has one), and resolves the promise with true (saved) or false
 * (cancelled).
 */
export class RequestSecretModal extends Modal {
  private valueInput: HTMLInputElement | null = null;
  /** Ensures onSave fires exactly once — guards against double-resolve when
   *  close() is called by a button handler (which already called onSave) and
   *  Obsidian subsequently fires onClose(), or when the user presses Escape. */
  private resolved = false;

  constructor(
    app: App,
    private secretName: string,
    private reason: string,
    private onSave: (saved: boolean) => void,
    private force?: boolean,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: this.force ? 'Agent is replacing a secret' : 'Agent is requesting a secret' });

    const nameRow = contentEl.createDiv({ cls: 'ct-secret-request-name-row' });
    nameRow.createEl('span', { text: 'Variable: ', cls: 'ct-modal-label' });
    nameRow.createEl('code', { text: this.secretName, cls: 'ct-secret-request-name' });

    contentEl.createEl('p', {
      text: `Reason: ${this.reason}`,
      cls: 'setting-item-description',
    });

    applySecretStorageCopy(
      this.app,
      contentEl.createEl('p', { cls: 'setting-item-description' }),
      (storage) => `${storage} It will be injected into future sessions and will never appear in the conversation.`,
    );

    if (this.force) {
      contentEl.createEl('p', {
        text: 'Note: an existing value for this secret will be replaced.',
        cls: 'setting-item-description',
      });
    }

    contentEl.createEl('label', { text: 'Value', cls: 'ct-modal-label' });
    this.valueInput = contentEl.createEl('input', {
      type: 'password',
      placeholder: 'paste your secret here',
      cls: 'ct-modal-input',
    });

    const buttonRow = contentEl.createDiv('ct-modal-button-row');

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.resolved = true;
      this.onSave(false);
      this.close();
    });

    const saveBtn = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => {
      const val = this.valueInput?.value.trim() ?? '';
      if (!val) return;
      this.app.secretStorage.setSecret(secretStorageKey(this.secretName), val);
      this.resolved = true;
      this.onSave(true);
      this.close();
    });

    this.valueInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') saveBtn.click();
    });

    setTimeout(() => this.valueInput?.focus(), 50);
  }

  onClose(): void {
    // Fires on Escape, backdrop click, or after close() — resolve as cancelled
    // if neither button handler has already resolved the promise.
    if (!this.resolved) {
      this.resolved = true;
      this.onSave(false);
    }
    this.contentEl.empty();
  }
}

/** Modal that displays the pairing QR code and alphanumeric code. */
class PairingModal extends Modal {
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(app: App, private plugin: ClaudeThreadsPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ct-pairing-modal');

    const ra = this.plugin.settings.remoteAccess;

    // Set or refresh the 5-minute expiry window when the modal opens.
    ra.pairingExpiresAt = Date.now() + 5 * 60 * 1000;
    this.plugin.saveSettings().catch(console.error);

    // obsidian:// deep link — iOS/Android camera apps will offer "Open in Obsidian"
    // when the user scans this QR code. registerObsidianProtocolHandler('pair', ...)
    // handles obsidian://pair?... on the mobile side.
    const pairingUrl = `obsidian://pair?roomId=${ra.roomId}&relay=${encodeURIComponent(ra.relayUrl)}`;
    const formatted = formatRoomIdAsCode(ra.roomId);

    contentEl.createEl('h2', { text: 'Pair with mobile' });
    contentEl.createEl('p', {
      text: 'Scan this QR code from Obsidian on your mobile device, or enter the code manually in Settings > Remote access.',
      cls: 'ct-pairing-desc',
    });

    const qrContainer = contentEl.createDiv('ct-pairing-qr');

    // Generate QR code asynchronously
    import('qrcode').then((QRCode) => {
      QRCode.toCanvas(pairingUrl, { width: 240, margin: 2 }, (err, canvas) => {
        if (err) {
          qrContainer.createEl('p', { text: 'QR code generation failed. Use the code below.' });
          return;
        }
        qrContainer.appendChild(canvas);
      });
    }).catch(() => {
      qrContainer.createEl('p', { text: 'QR code unavailable. Use the code below.' });
    });

    contentEl.createEl('p', { cls: 'ct-pairing-code-label', text: 'Pairing code:' });
    const codeEl = contentEl.createEl('code', { cls: 'ct-pairing-code', text: formatted });
    codeEl.addEventListener('click', () => {
      navigator.clipboard.writeText(ra.roomId);
      new Notice('Room ID copied to clipboard');
    });

    contentEl.createEl('p', {
      text: 'This code is your room ID. Keep it private — anyone with this code can connect to your desktop.',
      cls: 'ct-pairing-warning',
    });

    // Live countdown label
    const countdownEl = contentEl.createEl('p', { cls: 'ct-pairing-countdown' });

    const updateCountdown = () => {
      const remaining = (ra.pairingExpiresAt ?? 0) - Date.now();
      if (remaining <= 0) {
        this.expire();
        return;
      }
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      countdownEl.textContent = `Code expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
    };

    updateCountdown();
    this.countdownTimer = setInterval(updateCountdown, 1000);

    const closeBtn = contentEl.createEl('button', { text: 'Done', cls: 'mod-cta' });
    closeBtn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.contentEl.empty();
  }

  private expire(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    const ra = this.plugin.settings.remoteAccess;
    ra.pairingCode = null;
    ra.pairingExpiresAt = null;
    this.plugin.saveSettings().catch(console.error);
    this.close();
    new Notice('Pairing code expired. Open Settings to generate a new one.');
  }
}

/** Modal for adding a new skill source (GitHub or local path). */
class AddSkillSourceModal extends Modal {
  private sourceType: 'github' | 'local' = 'github';
  private contentEl2!: HTMLElement; // content area below type toggle

  constructor(
    app: App,
    private plugin: ClaudeThreadsPlugin,
    private onAdded: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Add skill source' });

    // Type toggle
    const typeRow = contentEl.createEl('div', { cls: 'ct-modal-type-row' });
    const githubBtn = typeRow.createEl('button', {
      cls: 'ct-modal-type-btn' + (this.sourceType === 'github' ? ' ct-modal-type-btn--active' : ''),
      text: 'GitHub URL',
    });
    const localBtn = typeRow.createEl('button', {
      cls: 'ct-modal-type-btn' + (this.sourceType === 'local' ? ' ct-modal-type-btn--active' : ''),
      text: 'Local path',
    });

    this.contentEl2 = contentEl.createEl('div');

    githubBtn.addEventListener('click', () => {
      this.sourceType = 'github';
      githubBtn.addClass('ct-modal-type-btn--active');
      localBtn.removeClass('ct-modal-type-btn--active');
      this.renderTypeContent();
    });
    localBtn.addEventListener('click', () => {
      this.sourceType = 'local';
      localBtn.addClass('ct-modal-type-btn--active');
      githubBtn.removeClass('ct-modal-type-btn--active');
      this.renderTypeContent();
    });

    this.renderTypeContent();
  }

  private renderTypeContent(): void {
    this.contentEl2.empty();

    if (this.sourceType === 'github') {
      this.renderGithubForm();
    } else {
      this.renderLocalForm();
    }
  }

  private renderGithubForm(): void {
    const el = this.contentEl2;

    el.createEl('p', {
      cls: 'ct-modal-desc',
      text: 'Paste a GitHub repository URL. The repo will be cloned inside this vault\'s plugin folder and its skills will be injected into each Claude session automatically.',
    });

    el.createEl('label', { text: 'GitHub URL', cls: 'ct-modal-label' });
    const urlInput = el.createEl('input', {
      type: 'text',
      placeholder: 'https://github.com/owner/repo',
      cls: 'ct-modal-input',
    });

    el.createEl('label', { text: 'Display name (optional)', cls: 'ct-modal-label' });
    const nameInput = el.createEl('input', {
      type: 'text',
      placeholder: 'Auto-detected from plugin.json',
      cls: 'ct-modal-input',
    });

    const errorEl = el.createEl('p', { cls: 'ct-modal-error' });
    errorEl.style.display = 'none';

    const progressEl = el.createEl('p', { cls: 'ct-modal-progress' });
    progressEl.style.display = 'none';

    const buttonRow = el.createDiv('ct-modal-button-row');
    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    const addBtn = buttonRow.createEl('button', { text: 'Clone & Add', cls: 'mod-cta' });

    const showError = (msg: string) => {
      errorEl.textContent = msg;
      errorEl.style.display = '';
      progressEl.style.display = 'none';
      addBtn.removeAttribute('disabled');
    };

    const showProgress = (msg: string) => {
      progressEl.textContent = msg;
      progressEl.style.display = '';
      errorEl.style.display = 'none';
    };

    const handleAdd = async () => {
      const rawUrl = urlInput.value.trim();
      if (!rawUrl) { showError('GitHub URL is required.'); return; }

      // Validate it's a github URL
      const ghMatch = rawUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
      if (!ghMatch) { showError('Please enter a valid GitHub repo URL (e.g. https://github.com/owner/repo).'); return; }

      addBtn.setAttribute('disabled', 'true');
      showProgress('Cloning repository…');

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fsNode = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathNode = require('path') as typeof import('path');
      // Required lazily (not imported at the top of this file) because
      // skillManager pulls in Node built-ins, and SettingsTab loads on mobile too.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { cloneGithubSource } = require('./skillManager') as typeof import('./skillManager');

      // A source the user adds by hand gets a random id; only *declared* sources
      // arriving without one need the deterministic, repo-derived id.
      const id = crypto.randomUUID();
      // Store clones inside the vault's plugin folder so they are vault-local
      // and don't bleed across vaults. FileSystemAdapter.getBasePath() gives the
      // absolute vault root; manifest.dir is the plugin folder relative to it.
      //
      // No home-directory fallback: this used to land clones in
      // ~/<manifest.dir>/skill-sources/ whenever the adapter was not a
      // FileSystemAdapter, writing outside the vault entirely.
      const { FileSystemAdapter } = require('obsidian') as typeof import('obsidian');
      const adapter = this.plugin.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter) || !this.plugin.manifest.dir) {
        showError('Cannot resolve the vault folder on this platform, so there is nowhere to clone to. Skill sources need a desktop vault on a real filesystem.');
        return;
      }
      const cloneBase = pathNode.join(adapter.getBasePath(), this.plugin.manifest.dir, 'skill-sources');
      const clonePath = pathNode.join(cloneBase, id);

      try {
        fsNode.mkdirSync(cloneBase, { recursive: true });

        // Clone via the shared helper (normalizes the URL to .git, runs git
        // non-interactively, and cleans up a partial clone on failure).
        await cloneGithubSource(rawUrl, clonePath);

        showProgress('Reading plugin manifest…');

        const { readPluginManifest } = await import('./claudeSettings');
        const manifest = readPluginManifest(clonePath);

        // Derive display name: user input > manifest displayName > manifest name > repo name from URL
        const repoName = rawUrl.replace(/\.git$/, '').split('/').pop() ?? 'Unknown';
        const displayName = nameInput.value.trim() || manifest?.displayName || manifest?.name || repoName;

        const source: SkillSource = {
          id,
          name: displayName,
          type: 'github',
          repoUrl: rawUrl.replace(/\.git$/, ''),
          clonePath,
        };

        this.plugin.settings.skillSources.push(source);
        await this.plugin.saveSettings();
        this.close();
        this.onAdded();
      } catch (err) {
        // Clean up failed clone
        try { fsNode.rmSync(clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
        showError(`Clone failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    addBtn.addEventListener('click', () => void handleAdd());
    urlInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void handleAdd(); });

    setTimeout(() => urlInput.focus(), 50);
  }

  private renderLocalForm(): void {
    const el = this.contentEl2;

    el.createEl('label', { text: 'Name', cls: 'ct-modal-label' });
    const nameInput = el.createEl('input', {
      type: 'text',
      placeholder: 'Agentic PM Playbook',
      cls: 'ct-modal-input',
    });

    el.createEl('label', { text: 'Skills path', cls: 'ct-modal-label' });
    const skillsPathInput = el.createEl('input', {
      type: 'text',
      placeholder: '~/projects/my-playbook/skills/',
      cls: 'ct-modal-input',
    });

    el.createEl('label', { text: 'Git repo path (optional)', cls: 'ct-modal-label' });
    const repoPathInput = el.createEl('input', {
      type: 'text',
      placeholder: '~/projects/my-playbook/',
      cls: 'ct-modal-input',
    });

    const errorEl = el.createEl('p', { cls: 'ct-modal-error' });
    errorEl.style.display = 'none';

    const buttonRow = el.createDiv('ct-modal-button-row');
    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    const addBtn = buttonRow.createEl('button', { text: 'Add', cls: 'mod-cta' });

    const showError = (msg: string) => {
      errorEl.textContent = msg;
      errorEl.style.display = '';
    };

    const handleAdd = async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fsNode = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const osNode = require('os') as typeof import('os');

      const name = nameInput.value.trim();
      const rawSkillsPath = skillsPathInput.value.trim();
      const rawRepoPath = repoPathInput.value.trim();

      if (!name) { showError('Name must not be empty.'); return; }
      if (!rawSkillsPath) { showError('Skills path must not be empty.'); return; }

      const expandedSkillsPath = rawSkillsPath.replace(/^~/, osNode.homedir());
      if (!fsNode.existsSync(expandedSkillsPath)) {
        showError(`Skills path does not exist: ${expandedSkillsPath}`);
        return;
      }

      const source: SkillSource = {
        id: crypto.randomUUID(),
        name,
        type: 'local',
        skillsPath: rawSkillsPath,
      };
      if (rawRepoPath) {
        source.repoPath = rawRepoPath;
      }

      this.plugin.settings.skillSources.push(source);
      await this.plugin.saveSettings();
      this.close();
      this.onAdded();
    };

    addBtn.addEventListener('click', () => void handleAdd());

    const handleEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') void handleAdd(); };
    nameInput.addEventListener('keydown', handleEnter);
    skillsPathInput.addEventListener('keydown', handleEnter);

    setTimeout(() => nameInput.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Add/edit modal for one entry in `PluginSettings.mcpServers` (this plugin's
 * own data.json). Operates on the raw, unresolved config — ${VAR} placeholders
 * are passed through verbatim, never decrypted or expanded here.
 *
 * Pass `existing` (and it carries `previousName` implicitly via its `name`)
 * to pre-fill the form for an edit; pass `null` to add a new entry.
 */
export class McpServerModal extends Modal {
  private serverType: 'stdio' | 'http' | 'oauth';
  private contentEl2!: HTMLElement;

  constructor(
    app: App,
    private plugin: ClaudeThreadsPlugin,
    private existing: McpServerEntry | null,
    private onSaved: () => void,
  ) {
    super(app);
    this.serverType = existing && (existing.type === 'http' || existing.type === 'sse') ? 'http' : 'stdio';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.existing ? 'Edit MCP server' : 'Add MCP server' });

    const typeRow = contentEl.createEl('div', { cls: 'ct-modal-type-row' });
    // OAuth is add-only: a connected server's credentials live in the keychain and
    // its config in `oauthMcpServers`, so changing one means Disconnect + reconnect
    // (a fresh consent round-trip), not editing fields in place. Offering the tab
    // during an edit would imply an in-place edit this modal cannot perform.
    const types: { id: 'stdio' | 'http' | 'oauth'; label: string }[] = [
      { id: 'stdio', label: 'Command (stdio)' },
      { id: 'http', label: 'HTTP or SSE' },
      ...(this.existing ? [] : [{ id: 'oauth' as const, label: 'OAuth' }]),
    ];
    const buttons = new Map<string, HTMLElement>();
    for (const { id, label } of types) {
      const btn = typeRow.createEl('button', {
        cls: 'ct-modal-type-btn' + (this.serverType === id ? ' ct-modal-type-btn--active' : ''),
        text: label,
      });
      buttons.set(id, btn);
      btn.addEventListener('click', () => {
        this.serverType = id;
        for (const [otherId, otherBtn] of buttons) {
          otherBtn.toggleClass('ct-modal-type-btn--active', otherId === id);
        }
        this.renderTypeContent();
      });
    }

    this.contentEl2 = contentEl.createEl('div');

    this.renderTypeContent();
  }

  private renderTypeContent(): void {
    this.contentEl2.empty();
    if (this.serverType === 'stdio') this.renderStdioForm();
    else if (this.serverType === 'oauth') this.renderOAuthForm();
    else this.renderHttpForm();
  }

  private renderStdioForm(): void {
    const el = this.contentEl2;
    const ex = this.existing?.type === 'stdio' ? this.existing : null;

    el.createEl('label', { text: 'Name', cls: 'ct-modal-label' });
    const nameInput = el.createEl('input', { type: 'text', placeholder: 'my-mcp-server', cls: 'ct-modal-input' });
    nameInput.value = this.existing?.name ?? '';

    el.createEl('label', { text: 'Command', cls: 'ct-modal-label' });
    const commandInput = el.createEl('input', { type: 'text', placeholder: 'npx', cls: 'ct-modal-input' });
    commandInput.value = ex?.command ?? '';

    el.createEl('label', { text: 'Arguments (one per line)', cls: 'ct-modal-label' });
    const argsInput = el.createEl('textarea', { cls: 'ct-modal-input ct-modal-textarea' });
    argsInput.placeholder = '-y\nmy-mcp-package';
    argsInput.value = (ex?.args ?? []).join('\n');

    el.createEl('label', { text: 'Environment variables', cls: 'ct-modal-label' });
    const envInput = el.createEl('textarea', { cls: 'ct-modal-input ct-modal-textarea' });
    envInput.placeholder = 'API_TOKEN=${MY_SECRET}';
    envInput.value = Object.entries(ex?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');

    const errorEl = el.createEl('p', { cls: 'ct-modal-error' });
    errorEl.style.display = 'none';

    const buttonRow = el.createDiv('ct-modal-button-row');
    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    const saveBtn = buttonRow.createEl('button', { text: this.existing ? 'Save' : 'Add', cls: 'mod-cta' });

    const showError = (msg: string) => {
      errorEl.textContent = msg;
      errorEl.style.display = '';
    };

    const handleSave = () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { saveMcpServer } = require('./mcpServerStore') as typeof import('./mcpServerStore');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { parseExtraEnv } = require('./types') as typeof import('./types');

      const name = nameInput.value.trim();
      if (!name) { showError('Name is required.'); return; }

      const args = argsInput.value.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      const env = parseExtraEnv(envInput.value);

      const server: McpServerEntry = {
        name,
        type: 'stdio',
        command: commandInput.value.trim(),
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };

      const result = saveMcpServer(this.plugin.settings, server, this.existing?.name);
      if (!result.ok) { showError(result.error); return; }
      void this.plugin.saveSettings();

      new Notice(`Saved MCP server "${name}".`);
      this.close();
      this.onSaved();
    };

    saveBtn.addEventListener('click', handleSave);
    nameInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') handleSave(); });
    commandInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') handleSave(); });

    setTimeout(() => nameInput.focus(), 50);
  }

  private renderHttpForm(): void {
    const el = this.contentEl2;
    const ex = (this.existing?.type === 'http' || this.existing?.type === 'sse') ? this.existing : null;

    el.createEl('label', { text: 'Name', cls: 'ct-modal-label' });
    const nameInput = el.createEl('input', { type: 'text', placeholder: 'compass', cls: 'ct-modal-input' });
    nameInput.value = this.existing?.name ?? '';

    el.createEl('label', { text: 'Transport', cls: 'ct-modal-label' });
    const transportSelect = el.createEl('select', { cls: 'ct-modal-input' });
    transportSelect.createEl('option', { text: 'HTTP', value: 'http' });
    transportSelect.createEl('option', { text: 'SSE', value: 'sse' });
    transportSelect.value = ex?.type === 'sse' ? 'sse' : 'http';

    el.createEl('label', { text: 'URL', cls: 'ct-modal-label' });
    const urlInput = el.createEl('input', {
      type: 'text',
      placeholder: 'https://example.com/api/mcp',
      cls: 'ct-modal-input',
    });
    urlInput.value = ex?.url ?? '';

    el.createEl('label', { text: 'Headers', cls: 'ct-modal-label' });
    const headersInput = el.createEl('textarea', { cls: 'ct-modal-input ct-modal-textarea' });
    headersInput.placeholder = 'Authorization=Bearer ${API_KEY}';
    headersInput.value = Object.entries(ex?.headers ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');

    const errorEl = el.createEl('p', { cls: 'ct-modal-error' });
    errorEl.style.display = 'none';

    const buttonRow = el.createDiv('ct-modal-button-row');
    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    const saveBtn = buttonRow.createEl('button', { text: this.existing ? 'Save' : 'Add', cls: 'mod-cta' });

    const showError = (msg: string) => {
      errorEl.textContent = msg;
      errorEl.style.display = '';
    };

    const handleSave = () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { saveMcpServer } = require('./mcpServerStore') as typeof import('./mcpServerStore');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { parseExtraEnv } = require('./types') as typeof import('./types');

      const name = nameInput.value.trim();
      if (!name) { showError('Name is required.'); return; }

      const url = urlInput.value.trim();
      if (!url) { showError('URL is required.'); return; }

      const headers = parseExtraEnv(headersInput.value);
      const transport = transportSelect.value === 'sse' ? 'sse' : 'http';

      const server: McpServerEntry = {
        name,
        type: transport,
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };

      const result = saveMcpServer(this.plugin.settings, server, this.existing?.name);
      if (!result.ok) { showError(result.error); return; }
      void this.plugin.saveSettings();

      new Notice(`Saved MCP server "${name}".`);
      this.close();
      this.onSaved();
    };

    saveBtn.addEventListener('click', handleSave);
    nameInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') handleSave(); });
    urlInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') handleSave(); });

    setTimeout(() => nameInput.focus(), 50);
  }

  /**
   * Connect an OAuth-gated server (`type: "oauth"`). Unlike the stdio/HTTP forms
   * this does not write settings directly: `OAuthMcpRegistry.registerServer()`
   * owns the whole round-trip (discovery → DCR → consent in the Web Viewer →
   * token exchange → proxy start → save), and only it knows how to unwind a
   * half-finished attempt. So the modal's job is to collect fields, hand them
   * over, and stay open across a wait that can legitimately run to the flow's
   * 5-minute consent timeout.
   */
  private renderOAuthForm(): void {
    const el = this.contentEl2;

    el.createEl('p', {
      cls: 'ct-modal-desc',
      text:
        'Connecting opens the provider\'s sign-in page in the Web Viewer. Tokens are stored ' +
        'in the OS keychain, never in this plugin\'s data.json.',
    });

    el.createEl('label', { text: 'Name', cls: 'ct-modal-label' });
    const nameInput = el.createEl('input', { type: 'text', placeholder: 'vercel', cls: 'ct-modal-input' });

    el.createEl('label', { text: 'URL', cls: 'ct-modal-label' });
    const urlInput = el.createEl('input', {
      type: 'text',
      placeholder: 'https://mcp.vercel.com/',
      cls: 'ct-modal-input',
    });

    el.createEl('label', { text: 'Scopes (optional, space-separated)', cls: 'ct-modal-label' });
    const scopesInput = el.createEl('input', {
      type: 'text',
      placeholder: 'openid profile email',
      cls: 'ct-modal-input',
    });

    el.createEl('label', { text: 'Tool filter (optional)', cls: 'ct-modal-label' });
    const filterModeSelect = el.createEl('select', { cls: 'ct-modal-input' });
    filterModeSelect.createEl('option', { text: 'No filter', value: 'none' });
    filterModeSelect.createEl('option', { text: 'Allow only these', value: 'allow' });
    filterModeSelect.createEl('option', { text: 'Deny these', value: 'deny' });
    const toolsInput = el.createEl('textarea', { cls: 'ct-modal-input ct-modal-textarea' });
    toolsInput.placeholder = 'buy_pro\nbuy_credits';
    toolsInput.style.display = 'none';
    filterModeSelect.addEventListener('change', () => {
      toolsInput.style.display = filterModeSelect.value === 'none' ? 'none' : '';
    });

    const advanced = el.createEl('details');
    advanced.createEl('summary', { text: 'Advanced' });
    advanced.createEl('label', { text: 'Client ID (skips Dynamic Client Registration)', cls: 'ct-modal-label' });
    const clientIdInput = advanced.createEl('input', { type: 'text', cls: 'ct-modal-input' });
    advanced.createEl('label', { text: 'Authorization server URL (skips discovery)', cls: 'ct-modal-label' });
    const asUrlInput = advanced.createEl('input', { type: 'text', cls: 'ct-modal-input' });
    advanced.createEl('label', { text: 'Redirect URI (optional — e.g. http://localhost:3118/callback for Slack)', cls: 'ct-modal-label' });
    const redirectUriInput = advanced.createEl('input', {
      type: 'text',
      placeholder: 'http://localhost:3118/callback',
      cls: 'ct-modal-input',
    });

    const errorEl = el.createEl('p', { cls: 'ct-modal-error' });
    errorEl.style.display = 'none';
    const statusEl = el.createEl('p', { cls: 'ct-modal-desc' });
    statusEl.style.display = 'none';

    const buttonRow = el.createDiv('ct-modal-button-row');
    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    const saveBtn = buttonRow.createEl('button', { text: 'Connect', cls: 'mod-cta' });

    const showError = (msg: string) => {
      errorEl.textContent = msg;
      errorEl.style.display = '';
    };

    let connecting = false;
    const handleConnect = async () => {
      if (connecting) return;
      errorEl.style.display = 'none';

      const registry = this.plugin.oauthMcpRegistry;
      if (!registry) { showError('OAuth MCP registration is unavailable in this context.'); return; }

      const mode = filterModeSelect.value;
      const toolNames = toolsInput.value.split('\n').map(t => t.trim()).filter(Boolean);
      const entry = {
        name: nameInput.value.trim(),
        type: 'oauth' as const,
        url: urlInput.value.trim(),
        ...(scopesInput.value.trim() ? { scopes: scopesInput.value.trim() } : {}),
        ...(mode !== 'none' && toolNames.length > 0 ? { tools: { [mode]: toolNames } } : {}),
        ...(clientIdInput.value.trim() ? { clientId: clientIdInput.value.trim() } : {}),
        ...(asUrlInput.value.trim() ? { authorizationServerUrl: asUrlInput.value.trim() } : {}),
        ...(redirectUriInput.value.trim() ? { redirectUri: redirectUriInput.value.trim() } : {}),
      };

      if (!entry.name) { showError('Name is required.'); return; }
      if (!entry.url) { showError('URL is required.'); return; }

      // Validate against the same schema the agent tool path uses, so the two
      // entry points cannot drift on what counts as a valid OAuth server.
      const parsed = mcpRegistrationSchema.safeParse(entry);
      if (!parsed.success) {
        showError(parsed.error.issues[0]?.message ?? 'Invalid OAuth MCP configuration.');
        return;
      }

      connecting = true;
      saveBtn.setAttribute('disabled', 'true');
      cancelBtn.setAttribute('disabled', 'true');
      saveBtn.textContent = 'Connecting…';
      statusEl.textContent = 'Waiting for you to finish signing in…';
      statusEl.style.display = '';

      let result: { success: boolean; message: string };
      try {
        result = await registry.registerServer({
          name: entry.name,
          url: entry.url,
          scopes: entry.scopes,
          tools: entry.tools,
          clientId: entry.clientId,
          authorizationServerUrl: entry.authorizationServerUrl,
          redirectUri: entry.redirectUri,
        });
      } catch (err) {
        result = { success: false, message: err instanceof Error ? err.message : String(err) };
      }

      connecting = false;
      statusEl.style.display = 'none';
      saveBtn.removeAttribute('disabled');
      cancelBtn.removeAttribute('disabled');
      saveBtn.textContent = 'Connect';

      if (!result.success) {
        showError(result.message || 'Could not connect this OAuth MCP server.');
        return;
      }

      new Notice(`Connected OAuth MCP server "${entry.name}".`);
      this.close();
      this.onSaved();
    };

    saveBtn.addEventListener('click', () => { void handleConnect(); });
    // Enter-to-submit, matching the stdio and HTTP forms. This is why
    // handleConnect keeps its own `connecting` guard: a keypress reaches the
    // handler even while the Connect button is disabled, so the disabled
    // attribute alone would not prevent a second consent round-trip.
    const submitOnEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') void handleConnect(); };
    nameInput.addEventListener('keydown', submitOnEnter);
    urlInput.addEventListener('keydown', submitOnEnter);
    scopesInput.addEventListener('keydown', submitOnEnter);

    setTimeout(() => nameInput.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Settings tab
// ───────────────────────────────────────────────────────────────────────────

type SettingsTabId = 'general' | 'claude' | 'tools' | 'vault' | 'features' | 'projects' | 'secrets' | 'scheduled' | 'remote' | 'skills' | 'mcp';

const TAB_GROUPS: { label: string; tabs: { id: SettingsTabId; label: string }[] }[] = [
  { label: 'Preferences', tabs: [
    { id: 'general', label: 'General' }, { id: 'claude', label: 'Agent' },
    { id: 'tools', label: 'Tools' }, { id: 'vault', label: 'Vault' }, { id: 'features', label: 'Features' },
  ] },
  { label: 'Workspace', tabs: [
    { id: 'projects', label: 'Projects' }, { id: 'secrets', label: 'Secrets' }, { id: 'scheduled', label: 'Scheduled' },
  ] },
  { label: 'Extensions', tabs: [{ id: 'skills', label: 'Skills' }, { id: 'mcp', label: 'MCP' }] },
  { label: 'Connectivity', tabs: [{ id: 'remote', label: 'Remote' }] },
];

/** Fallback model list shown before any session has run and populated discoveredModels. */
const FALLBACK_MODELS: { value: string; displayName: string }[] = [
  { value: 'claude-fable-5', displayName: 'Claude Fable 5' },
  { value: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
  { value: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
  { value: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
];

export class ClaudeThreadsSettingTab extends PluginSettingTab {
  /** Survives re-renders (display() is called after toggles, modals, etc.). */
  private activeTab: SettingsTabId = 'general';
  private selectedProjectId: string | null = null;
  private selectedSecretName: string | null = null;

  constructor(
    app: App,
    private plugin: ClaudeThreadsPlugin,
  ) {
    super(app, plugin);
  }

  /** Re-renders any open Kanban board / Agent Dashboard leaves so a setting toggled here (e.g. scheduled-thread stacking) takes effect immediately, without requiring the user to close and reopen the tab. */
  private refreshKanbanAndDashboardViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(KANBAN_VIEW_TYPE)) {
      (leaf.view as KanbanView).render();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE)) {
      (leaf.view as AgentDashboard).render();
    }
  }

  /**
   * Adds model options to a dropdown. Family aliases appear first (always
   * track the latest release), followed by pinned model IDs sourced from the
   * SDK capabilities query, falling back to a hardcoded list when no session
   * has run yet.
   */
  private addModelOptions(
    dropdown: import('obsidian').DropdownComponent,
    opts: { includeCliDefault?: boolean } = {},
  ): void {
    if (opts.includeCliDefault) {
      dropdown.addOption('', 'CLI default');
    }
    const harness = this.plugin.settings.agentHarness ?? 'claude';
    if (harness === 'claude') {
      // Family aliases are Claude Code-specific and must not be sent to Codex.
      dropdown.addOption('fable', 'Fable (latest)');
      dropdown.addOption('opus', 'Opus (latest)');
      dropdown.addOption('sonnet', 'Sonnet (latest)');
      dropdown.addOption('haiku', 'Haiku (latest)');
    }
    const discovered = this.plugin.discoveredModelsByHarness[harness];
    // Codex intentionally has no guessed fallback: wait for model/list so we
    // never offer a model unavailable to the signed-in Codex account.
    const pinned = harness === 'claude'
      ? (discovered.length > 0 ? discovered : FALLBACK_MODELS)
      : discovered;
    for (const m of pinned) {
      dropdown.addOption(m.value, m.displayName);
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    if (Platform.isMobile) {
      this.renderMobileOnlySettings(containerEl);
      return;
    }

    const shell = containerEl.createDiv({ cls: 'ct-settings-shell' });
    const compact = shell.createDiv({ cls: 'ct-settings-compact-nav' });
    compact.createEl('strong', { text: 'Agent Threads' });
    const selectLabel = compact.createEl('label');
    selectLabel.createSpan({ text: 'Settings section' });
    const select = selectLabel.createEl('select', { attr: { 'aria-label': 'Settings section' } });
    for (const group of TAB_GROUPS) {
      const options = select.createEl('optgroup', { attr: { label: group.label } });
      for (const tab of group.tabs) options.createEl('option', { text: tab.label, value: tab.id });
    }
    select.value = this.activeTab;
    select.addEventListener('change', () => {
      const retainFocus = select === select.ownerDocument.activeElement;
      this.activeTab = select.value as SettingsTabId;
      this.display();
      if (retainFocus) containerEl.querySelector<HTMLSelectElement>('.ct-settings-compact-nav select')?.focus();
    });

    const body = shell.createDiv({ cls: 'ct-settings-tab-body' });
    switch (this.activeTab) {
      case 'general': this.renderGeneralTab(body); break;
      case 'claude': this.renderClaudeTab(body); break;
      case 'tools': this.renderToolsTab(body); break;
      case 'vault': this.renderVaultTab(body); break;
      case 'features': this.renderFeaturesTab(body); break;
      case 'projects': this.renderProjectsTab(body); break;
      case 'secrets': this.renderSecretsTab(body); break;
      case 'scheduled': this.renderScheduledTab(body); break;
      case 'remote': this.renderRemoteTab(body); break;
      case 'skills': this.renderSkillsTab(body); break;
      case 'mcp': this.renderMcpTab(body); break;
    }
  }

  // ── General ─────────────────────────────────────────────────────────────

  private renderGeneralTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Conversation placement')
      .setDesc('Keep chat in its classic sidebar, or use a main-area conversation with one reusable native companion panel.')
      .addDropdown((drop) =>
        drop
          .addOption('classic', 'Classic sidebar')
          .addOption('conversation-first', 'Conversation first (default)')
          .setValue(this.plugin.settings.threadViewPlacement ?? 'conversation-first')
          .onChange(async (value) => {
            const previous = this.plugin.settings.threadViewPlacement;
            const next = value as PluginSettings['threadViewPlacement'];
            const { transitionConversationPlacement } = require('./conversationFirstPlacement') as typeof import('./conversationFirstPlacement');
            try {
              await transitionConversationPlacement(
                this.plugin.settings,
                next,
                () => this.plugin.activateView(),
                () => this.plugin.saveSettings(),
              );
            } catch (error) {
              drop.setValue(previous);
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`Could not change conversation placement: ${message}`);
            }
          }),
      );

    new Setting(containerEl)
      .setName('Layout density')
      .setDesc('How compact the conversation view feels.')
      .addDropdown((drop) =>
        drop
          .addOption('compact', 'Compact')
          .addOption('comfortable', 'Comfortable (default)')
          .addOption('spacious', 'Spacious')
          .setValue(this.plugin.settings.layoutDensity ?? 'comfortable')
          .onChange(async (value) => {
            this.plugin.settings.layoutDensity = value as LayoutDensity;
            await this.plugin.saveSettings();
            this.plugin.getView()?.applyDensity();
          }),
      );

    new Setting(containerEl)
      .setName('Context footer command')
      .setDesc(
        'Shell command that populates the context bar below the input area (git branch, PR, dev URL, …). ' +
        'Receives {cwd, workspace:{current_dir}} as JSON on stdin. Output may be a JSON array of status tags ' +
        '({label, url?, icon?, tone?, kind?}) or legacy plaintext (split on double-spaces). Run per-thread ' +
        'in the background (desktop only); a kind:"pr" tag drives the PR pill. Compatible with the Claude Code ' +
        'statusLine script. Leave empty to disable.',
      )
      .addText((text) => {
        text
          .setPlaceholder('bash $HOME/claude-config/bin/statusline-command.sh')
          .setValue(this.plugin.settings.statusLineCommand)
          .onChange(async (value) => {
            this.plugin.settings.statusLineCommand = value;
            await this.plugin.saveSettings();
            this.plugin.getView()?.updateStatusLineCommand();
          });
        text.inputEl.addClass('ct-settings-wide-input');
      });

    new Setting(containerEl).setName('Pull requests').setHeading();

    new Setting(containerEl)
      .setName('Create PR message')
      .setDesc('Sent directly to the active agent. This may call a skill defined by your agent system. Blank uses /create-pr.')
      .addTextArea((area) => {
        area
          .setPlaceholder('/create-pr')
          .setValue(this.plugin.settings.createPrMessage)
          .onChange(async (value) => {
            this.plugin.settings.createPrMessage = value;
            await this.plugin.saveSettings();
          });
        area.inputEl.addClass('ct-settings-wide-input');
      });

    new Setting(containerEl)
      .setName('Create draft PR message')
      .setDesc('Sent directly to the active agent for draft PRs. This may call a skill defined by your agent system. Blank uses /create-pr --draft.')
      .addTextArea((area) => {
        area
          .setPlaceholder('/create-pr --draft')
          .setValue(this.plugin.settings.createDraftPrMessage)
          .onChange(async (value) => {
            this.plugin.settings.createDraftPrMessage = value;
            await this.plugin.saveSettings();
          });
        area.inputEl.addClass('ct-settings-wide-input');
      });

    new Setting(containerEl)
      .setName('Keep computer awake')
      .setDesc('Prevent sleep while an agent is responding. Shows ☕ in the status bar when active.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.wakeLockEnabled).onChange(async (value) => {
          this.plugin.settings.wakeLockEnabled = value;
          this.plugin.wakeLock.setEnabled(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Verbose console logs for stream events, session lifecycle, and relay connections. Turn on only when diagnosing issues.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLogging ?? false).onChange(async (value) => {
          this.plugin.settings.debugLogging = value;
          setDebugLogging(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Diagnostics')
      .setDesc(
        'Collect local-only performance counters and renderer CPU/memory samples so a slowdown can be diagnosed. ' +
        'Nothing ever leaves your machine. Use "Copy diagnostics" (or the "Generate diagnostics report" command) to ' +
        'save a redacted report to agent-threads-diagnostics/ and copy it to your clipboard for a GitHub issue.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.telemetryEnabled ?? true).onChange(async (value) => {
          this.plugin.settings.telemetryEnabled = value;
          telemetry.setEnabled(value);
          await this.plugin.saveSettings();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Copy diagnostics')
          .onClick(() => {
            void this.plugin.runDiagnosticsReport?.();
          }),
      );
  }

  // ── Agent harness ───────────────────────────────────────────────────────

  private renderClaudeTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Agent harness')
      .setDesc('New threads use this local coding agent. Existing threads retain the harness that created them.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('claude', 'Claude Code')
          .addOption('codex', 'OpenAI Codex')
          .setValue(this.plugin.settings.agentHarness ?? 'claude')
          .onChange(async (value) => {
            this.plugin.settings.agentHarness = value as 'claude' | 'codex';
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Codex binary path')
      .setDesc('Path to the codex executable. Codex threads use its local app-server for streaming, approvals, and durable sessions.')
      .addText((text) =>
        text
          .setPlaceholder('codex')
          .setValue(this.plugin.settings.codexBinaryPath ?? 'codex')
          .onChange(async (value) => {
            this.plugin.settings.codexBinaryPath = value || 'codex';
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Codex computer use')
      .setDesc('Allow Codex computer-use capabilities from your local Codex configuration. Off by default; shared Codex browser tools may also be disabled. Changes apply when a Codex session next starts or restarts; existing sessions keep their current access. Use “Reload plugin (safe)” after active work finishes to apply to all sessions.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.codexComputerUseEnabled === true)
          .onChange(async (value) => {
            this.plugin.settings.codexComputerUseEnabled = value;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Worktree location')
      .setDesc(
        'Where enter_worktree creates worktrees. Leave empty to use ~/.geode/worktrees. '
        + 'Must be durable storage — a temp directory is cleared on reboot, which deletes '
        + 'the worktree and any uncommitted work in it.',
      )
      .addText((text) =>
        text
          .setPlaceholder('~/.geode/worktrees')
          .setValue(this.plugin.settings.worktreeRoot ?? '')
          .onChange(async (value) => {
            this.plugin.settings.worktreeRoot = value.trim();
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Claude binary path')
      .setDesc('Path to the claude executable. Leave empty to find it on $PATH.')
      .addText((text) =>
        text
          .setPlaceholder('/opt/homebrew/bin/claude')
          .setValue(this.plugin.settings.claudeBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.claudeBinaryPath = value;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Account / provider')
      .setDesc(
        'Claude account uses the CLI\'s own login. ' +
        'Amazon Bedrock sets CLAUDE_CODE_USE_BEDROCK=1 — also add AWS_PROFILE and AWS_REGION under Extra environment variables.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('claude', 'Claude account (default)')
          .addOption('bedrock', 'Amazon Bedrock')
          .setValue(this.plugin.settings.provider ?? 'claude')
          .onChange(async (value) => {
            this.plugin.settings.provider = value as ProviderMode;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default model')
      .setDesc(
        'Model for new turns unless a thread overrides it with /model. ' +
          '"CLI default" defers to the Claude Code CLI configuration. ' +
          'Aliases always track the latest version; pinned IDs lock to a specific release. ' +
          'Start a thread to populate the full model list from the CLI.',
      )
      .addDropdown((dropdown) => {
        this.addModelOptions(dropdown, { includeCliDefault: true });
        return dropdown
          .setValue(this.plugin.settings.defaultModel ?? '')
          .onChange(async (value) => {
            this.plugin.settings.defaultModel = value;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Thinking mode')
      .setDesc('Controls extended reasoning. "Adaptive" lets Claude decide; "Enabled" uses a fixed token budget; "Disabled" turns off extended thinking.')
      .addDropdown((drop) =>
        drop
          .addOption('disabled', 'Disabled')
          .addOption('adaptive', 'Adaptive (Claude decides)')
          .addOption('enabled', 'Enabled (fixed token budget)')
          .setValue(this.plugin.settings.thinkingMode ?? 'disabled')
          .onChange(async (value) => {
            this.plugin.settings.thinkingMode = value as PluginSettings['thinkingMode'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Thinking token budget')
      .setDesc('Maximum tokens for thinking when mode is "Enabled".')
      .addText((text) =>
        text
          .setPlaceholder('8000')
          .setValue(String(this.plugin.settings.thinkingBudgetTokens ?? 8000))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.thinkingBudgetTokens = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    const isCodex = (this.plugin.settings.agentHarness ?? 'claude') === 'codex';
    new Setting(containerEl)
      .setName(isCodex ? 'Codex effort level' : 'Effort level')
      .setDesc(isCodex
        ? 'How much reasoning effort Codex applies. Ultra enables proactive native agents on supported models; Default uses the model default.'
        : 'How much reasoning effort Claude applies. "Default" uses the CLI default.')
      .addDropdown((drop) => {
        drop
          .addOption('default', 'Default')
          .addOption('low', 'Low (fastest)')
          .addOption('medium', 'Medium')
          .addOption('high', 'High')
          .addOption('xhigh', isCodex ? 'Extra high' : 'Extra high (Opus 4.7+)')
          .addOption('max', isCodex ? 'Max' : 'Max (Opus 4.6+, Sonnet 4.6)');
        if (isCodex) drop.addOption('ultra', 'Ultra (proactive agents)');
        return drop
          .setValue(isCodex ? (this.plugin.settings.codexEffort ?? 'default') : (this.plugin.settings.effort ?? 'default'))
          .onChange(async (value) => {
            if (isCodex) this.plugin.settings.codexEffort = value as PluginSettings['codexEffort'];
            else this.plugin.settings.effort = value as PluginSettings['effort'];
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Agent progress summaries')
      .setDesc('When enabled, running subagents emit an AI-generated progress summary every ~30 seconds.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.agentProgressSummaries ?? true)
          .onChange(async (value) => {
            this.plugin.settings.agentProgressSummaries = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Enable 1M context window (beta)')
      .setDesc('Passes the context-1m-2025-08-07 beta header for Sonnet 4/4.5. Requires a model that supports it.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enable1MContext ?? false)
          .onChange(async (value) => {
            this.plugin.settings.enable1MContext = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default working directory')
      .setDesc('Starting directory for new threads. Leave empty to use the vault root.')
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.getEffectiveCwd())
          .setValue(this.plugin.settings.defaultCwd)
          .onChange(async (value) => {
            this.plugin.settings.defaultCwd = value;
            await this.plugin.saveSettings();
          }),
      );

    // — Environment —
    new Setting(containerEl).setName('Environment').setHeading();

    new Setting(containerEl)
      .setName('Extra environment variables')
      .setDesc('KEY=VALUE pairs (one per line) merged into the Claude process environment.')
      .addTextArea((text) =>
        text
          .setPlaceholder('AWS_PROFILE=my-sso-profile\nAWS_REGION=us-east-1')
          .setValue(this.plugin.settings.extraEnv)
          .onChange(async (value) => {
            this.plugin.settings.extraEnv = value;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    // macOS privacy notice
    const macOSNote = containerEl.createDiv({ cls: 'ct-settings-notice' });
    macOSNote.createEl('strong', { text: 'macOS users: ' });
    macOSNote.appendText(
      'The first time Claude accesses a folder like ~/Documents, macOS shows a privacy dialog. ' +
      'Click Allow — it only appears once per folder.',
    );

    // — Model escalation —
    new Setting(containerEl).setName('Model escalation').setHeading();

    new Setting(containerEl)
      .setName('Enable model escalation')
      .setDesc('When the keyword appears in a message, route that single turn to the escalation model. The keyword is stripped before sending.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.escalationEnabled).onChange(async (value) => {
          this.plugin.settings.escalationEnabled = value;
          this.plugin.manager.updateSettings(this.plugin.settings);
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.escalationEnabled) {
      new Setting(containerEl)
        .setName('Escalation keyword')
        .setDesc('Word or phrase that triggers escalation.')
        .addText((text) =>
          text
            .setPlaceholder('/escalate')
            .setValue(this.plugin.settings.escalationKeyword)
            .onChange(async (value) => {
              this.plugin.settings.escalationKeyword = value || '/escalate';
              this.plugin.manager.updateSettings(this.plugin.settings);
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('Escalation model')
        .setDesc('Model the escalation keyword routes that turn to.')
        .addDropdown((dropdown) => {
          this.addModelOptions(dropdown);
          return dropdown
            .setValue(this.plugin.settings.escalationModel || 'opus')
            .onChange(async (value) => {
              this.plugin.settings.escalationModel = value;
              this.plugin.manager.updateSettings(this.plugin.settings);
              await this.plugin.saveSettings();
            });
        });
    }
  }

  // ── Tools ───────────────────────────────────────────────────────────────

  private renderToolsTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Permission mode')
      .setDesc('How Claude handles tool-use permission prompts.')
      .addDropdown((drop) =>
        drop
          .addOption('default', 'Prompt for permissions')
          .addOption('acceptEdits', 'Accept edits automatically')
          .addOption('bypassPermissions', 'Bypass all permissions (trusted directories only)')
          .addOption('plan', 'Plan only: Claude reads and proposes, never executes')
          .addOption('dontAsk', 'Silent deny: unrecognized tools denied without prompting (CI)')
          .addOption('auto', 'Auto-approve: classifier approves common ops, escalates uncertain ones')
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (value) => {
            this.plugin.settings.permissionMode = value as PluginSettings['permissionMode'];
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    {
      const wvAvailable = isWebViewerEnabled(this.plugin.app);
      new Setting(containerEl)
        .setName('Web Viewer tool')
        .setDesc(
          wvAvailable
            ? 'Let Claude open URLs directly in the host Web Viewer panel (host_open_url).'
            : 'Requires the Web Viewer core plugin — enable it under Settings → Core plugins, then reopen this tab.',
        )
        .addToggle((toggle) => {
          toggle
            .setValue(wvAvailable && (this.plugin.settings.enableWebViewerTool ?? true))
            .setDisabled(!wvAvailable)
            .onChange(async (value) => {
              this.plugin.settings.enableWebViewerTool = value;
              await this.plugin.saveSettings();
            });
        });
    }

    // Agent browser. Gated on the host reporting process diagnostics: without
    // the file-descriptor probe there is no way to avoid launching a guest that
    // dies on arrival, so the feature refuses to run rather than run blind.
    {
      const agentBrowserAvailable =
        typeof (window as { geode?: { getFdPressure?: unknown } }).geode?.getFdPressure === 'function';
      new Setting(containerEl)
        .setName('Agent browser')
        .setDesc(
          agentBrowserAvailable
            ? 'Let Claude drive an in-app browser built on the host\'s embedded web view, instead of launching an external browser. Sessions are capped and reclaimed automatically.'
            : 'Requires a host that reports process diagnostics (Geode desktop). Claude will continue to use the external agent-browser CLI here.',
        )
        .addToggle((toggle) => {
          toggle
            .setValue(agentBrowserAvailable && (this.plugin.settings.enableAgentBrowser ?? false))
            .setDisabled(!agentBrowserAvailable)
            .onChange(async (value) => {
              this.plugin.settings.enableAgentBrowser = value;
              await this.plugin.saveSettings();
              new Notice('Reload Obsidian to apply the agent browser change.');
            });
        });

      if (agentBrowserAvailable && (this.plugin.settings.enableAgentBrowser ?? false)) {
        new Setting(containerEl)
          .setName('Maximum browser sessions')
          .setDesc(
            'Concurrent in-app browser sessions across all threads. Each one is a separate sandboxed process, so this is a real resource ceiling rather than a preference.',
          )
          .addSlider((slider) => {
            slider
              .setLimits(1, 4, 1)
              .setValue(this.plugin.settings.agentBrowserMaxGuests ?? 2)
              .setDynamicTooltip()
              .onChange(async (value) => {
                this.plugin.settings.agentBrowserMaxGuests = value;
                await this.plugin.saveSettings();
              });
          });

        new Setting(containerEl)
          .setName('Allow private network access')
          .setDesc(
            'Let the agent browser reach private addresses such as 192.168.x.x and .local hosts. Cloud metadata endpoints stay blocked either way.',
          )
          .addToggle((toggle) => {
            toggle
              .setValue(this.plugin.settings.agentBrowserAllowPrivateNetwork ?? false)
              .onChange(async (value) => {
                this.plugin.settings.agentBrowserAllowPrivateNetwork = value;
                await this.plugin.saveSettings();
              });
          });
      }
    }

    new Setting(containerEl)
      .setName('Inline visualizations')
      .setDesc(
        'Render Codex\'s canonical wrapped visualize content references as live sandboxed charts inside messages, with a pop-out to full size. Desktop only.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableInlineVisualizations !== false)
          .onChange(async (value) => {
            this.plugin.settings.enableInlineVisualizations = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Hidden built-in tools')
      .setDesc('Comma-separated Claude Code built-in tools to hide from sessions. Cron* tools are hidden by default — the plugin has its own scheduler.')
      .addText((text) =>
        text
          .setPlaceholder('CronCreate, CronDelete, CronList, CronUpdate')
          .setValue(this.plugin.settings.disallowedTools.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.disallowedTools = value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    // — Always-allowed tools —
    new Setting(containerEl).setName('Always-allowed tools').setHeading();

    const allowedList = containerEl.createDiv({ cls: 'ct-allowed-tools-list' });
    const renderAllowedTools = () => {
      allowedList.empty();
      const tools = this.plugin.settings.alwaysAllowedTools;
      if (tools.length === 0) {
        allowedList.createEl('p', { text: 'No tools always allowed yet.', cls: 'ct-settings-empty' });
      } else {
        for (const tool of tools) {
          new Setting(allowedList)
            .setName(tool)
            .addButton((btn) =>
              btn.setButtonText('Remove').setWarning().onClick(async () => {
                this.plugin.settings.alwaysAllowedTools =
                  this.plugin.settings.alwaysAllowedTools.filter((t) => t !== tool);
                await this.plugin.saveSettings();
                renderAllowedTools();
              }),
            );
        }
      }
    };

    let newToolInput: HTMLInputElement | null = null;
    new Setting(containerEl)
      .setName('Add always-allowed tool')
      .setDesc('Granted automatically without prompting. Tools land here when you choose "Always allow" in a permission prompt; you can also add one by name.')
      .addText((text) => {
        text.setPlaceholder('e.g. Bash, Read, mcp__claude_threads__…');
        newToolInput = text.inputEl;
      })
      .addButton((btn) =>
        btn.setButtonText('Add').setCta().onClick(async () => {
          const tool = newToolInput?.value.trim() ?? '';
          if (!tool) return;
          if (!this.plugin.settings.alwaysAllowedTools.includes(tool)) {
            this.plugin.settings.alwaysAllowedTools.push(tool);
            await this.plugin.saveSettings();
            renderAllowedTools();
          }
          if (newToolInput) newToolInput.value = '';
        }),
      );
    containerEl.appendChild(allowedList);
    renderAllowedTools();
  }

  // ── Vault ───────────────────────────────────────────────────────────────

  private renderVaultTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Save threads to vault')
      .setDesc('Auto-save conversations as Markdown notes in the vault after each response.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.saveThreadsToVault).onChange(async (value) => {
          this.plugin.settings.saveThreadsToVault = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Save raw JSONL logs')
      .setDesc('Append each thread\'s raw event stream (tool calls, results, usage) to <vault folder>/logs/<thread id>.jsonl, linked from the note\'s raw_log frontmatter. Lets agents retrieve and analyze the full transcript.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.saveRawLogs).onChange(async (value) => {
          this.plugin.settings.saveRawLogs = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-archive idle threads after (days)')
      .setDesc('Automatically archive a waiting thread once it has been idle this many days: its readable Markdown note and versioned recovery snapshot are saved, then it is removed from the live thread list, keeping data.json from growing without bound. Active threads, the orchestrator, and threads awaiting a plan or question are never touched. Set to 0 to disable.')
      .addText((text) =>
        text
          .setPlaceholder('14')
          .setValue(String(this.plugin.settings.autoArchiveIdleDays ?? 14))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.autoArchiveIdleDays = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName('Vault folder')
      .setDesc('Where thread notes are saved, relative to the vault root.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_VAULT_FOLDER)
          .setValue(this.plugin.settings.vaultFolder)
          .onChange(async (value) => {
            this.plugin.settings.vaultFolder = value || DEFAULT_VAULT_FOLDER;
            await this.plugin.saveSettings();
          }),
      );

  }

  private renderManagerHeader(container: HTMLElement, title: string, description: string, actionLabel: string, onAction: () => void): void {
    const header = container.createDiv({ cls: 'ct-settings-page-header' });
    const copy = header.createDiv();
    copy.createEl('h1', { text: title });
    copy.createEl('p', { text: description });
    const action = header.createEl('button', { text: actionLabel, cls: 'mod-cta', attr: { type: 'button' } });
    action.addEventListener('click', onAction);
  }

  private createManagerField(
    container: HTMLElement,
    label: string,
    value: string,
    options: { textarea?: boolean; placeholder?: string; disabled?: boolean; description?: string; type?: string } = {},
  ): HTMLInputElement | HTMLTextAreaElement {
    const field = container.createEl('label', { cls: 'ct-manager-field' });
    field.createSpan({ text: label, cls: 'ct-manager-field-label' });
    const input = options.textarea
      ? field.createEl('textarea', { attr: { rows: '6', 'aria-label': label } })
      : field.createEl('input', { type: options.type ?? 'text', attr: { 'aria-label': label } });
    input.value = value;
    if (options.placeholder) input.setAttribute('placeholder', options.placeholder);
    if (options.disabled && input instanceof HTMLInputElement) input.disabled = true;
    if (options.description) field.createEl('small', { text: options.description });
    return input;
  }

  private renderProjectsTab(containerEl: HTMLElement): void {
    this.renderManagerHeader(containerEl, 'Projects', 'Group threads and keep each agent focused on the right context.', 'New project', () => {
      this.selectedProjectId = '';
      this.display();
      this.containerEl.querySelector<HTMLInputElement>('[aria-label="Project name"]')?.focus();
    });

    const projects = this.plugin.manager.getProjects();
    if (this.selectedProjectId === null || (this.selectedProjectId && !projects.some(project => project.id === this.selectedProjectId))) {
      this.selectedProjectId = projects[0]?.id ?? '';
    }
    const manager = containerEl.createDiv({ cls: 'ct-settings-manager' });
    const list = manager.createEl('section', { cls: 'ct-manager-list', attr: { 'aria-label': 'Projects' } });
    const search = list.createEl('input', { type: 'search', placeholder: 'Search projects', attr: { 'aria-label': 'Search projects' } });
    const rows = list.createDiv({ cls: 'ct-manager-list-rows' });
    const renderRows = () => {
      rows.empty();
      const query = search.value.trim().toLowerCase();
      const matches = projects.filter(project => `${project.name} ${project.vaultFolder} ${this.plugin.manager.getProjectCwd(project)}`.toLowerCase().includes(query));
      if (matches.length === 0) rows.createEl('p', { cls: 'ct-settings-empty', text: projects.length === 0 ? 'No projects yet.' : 'No matching projects.' });
      for (const project of matches) {
        const threadCount = this.plugin.manager.getThreadsByProject(project.id).length;
        const row = rows.createEl('button', { cls: `ct-manager-list-item${project.id === this.selectedProjectId ? ' is-selected' : ''}`, attr: { type: 'button' } });
        row.createEl('strong', { text: project.name });
        row.createEl('small', { text: this.plugin.manager.getProjectCwd(project) });
        row.createEl('span', { text: `${project.orchestratorThreadId ? 'Orchestrator active' : 'No orchestrator'} · ${threadCount} thread${threadCount === 1 ? '' : 's'}` });
        row.addEventListener('click', () => { this.selectedProjectId = project.id; this.display(); });
      }
    };
    search.addEventListener('input', renderRows);
    renderRows();
    list.createEl('footer', { text: `${projects.length} project${projects.length === 1 ? '' : 's'}` });

    const detail = manager.createEl('section', { cls: 'ct-manager-detail' });
    const project = projects.find(candidate => candidate.id === this.selectedProjectId);
    const isNew = this.selectedProjectId === '';
    if (!project && !isNew) {
      detail.createEl('div', { cls: 'ct-manager-empty', text: 'Create a project to group related threads and working context.' });
      return;
    }
    const heading = detail.createDiv({ cls: 'ct-manager-detail-header' });
    heading.createEl('h2', { text: isNew ? 'New project' : project!.name });
    if (project) {
      const orchestrator = heading.createEl('button', { text: project.orchestratorThreadId ? 'Open orchestrator' : 'Create orchestrator', attr: { type: 'button' } });
      orchestrator.addEventListener('click', async () => { await this.plugin.ensureProjectOrchestratorThread(project.id, true); this.display(); });
    }
    const form = detail.createDiv({ cls: 'ct-manager-form' });
    const name = this.createManagerField(form, 'Project name', project?.name ?? '', { placeholder: 'Project name' }) as HTMLInputElement;
    const folder = this.createManagerField(form, 'Vault folder', project?.vaultFolder ?? '', {
      placeholder: 'Products/My Project', description: 'Changing this updates future context. Existing files are not moved.',
    }) as HTMLInputElement;
    const cwd = this.createManagerField(form, 'Filesystem working directory', project?.cwdOverride ?? '', {
      placeholder: 'Optional absolute path', description: project ? `Effective cwd: ${this.plugin.manager.getProjectCwd(project)}` : 'Leave blank to derive it from the vault folder.',
    }) as HTMLInputElement;
    const description = this.createManagerField(form, 'Project context', project?.description ?? '', {
      textarea: true, placeholder: 'Goals, conventions, and key files…', description: 'Injected into the agent system prompt for every thread in this project.',
    }) as HTMLTextAreaElement;
    const error = detail.createEl('p', { cls: 'ct-manager-error', attr: { role: 'alert' } });
    error.style.display = 'none';
    if (project) {
      const danger = detail.createDiv({ cls: 'ct-manager-danger' });
      const warning = danger.createDiv();
      warning.createEl('strong', { text: 'Delete project' });
      warning.createEl('small', { text: 'Threads are kept and detached. Schedules retain their current cwd.' });
      const remove = danger.createEl('button', { text: 'Delete…', cls: 'mod-warning', attr: { type: 'button' } });
      remove.addEventListener('click', async () => {
        const threadCount = this.plugin.manager.getThreadsByProject(project.id).length;
        const scheduleCount = (this.plugin.settings.scheduledItems ?? []).filter(item => item.projectId === project.id).length;
        if (!window.confirm(`Delete ${project.name}? ${threadCount} thread(s) will be detached and ${scheduleCount} schedule(s) will keep their current effective cwd.`)) return;
        await this.plugin.deleteProject(project.id);
        this.selectedProjectId = null;
        this.display();
      });
    }
    const actions = detail.createEl('footer', { cls: 'ct-manager-actions' });
    const state = actions.createEl('span', { text: isNew ? 'New project draft' : 'No unsaved changes' });
    for (const input of [name, folder, cwd, description]) input.addEventListener('input', () => { state.textContent = 'Unsaved changes'; });
    const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
    cancel.addEventListener('click', () => { if (isNew) this.selectedProjectId = projects[0]?.id ?? null; this.display(); });
    const save = actions.createEl('button', { text: isNew ? 'Create project' : 'Save changes', cls: 'mod-cta', attr: { type: 'button' } });
    save.addEventListener('click', async () => {
      const projectName = name.value.trim();
      const vaultFolder = folder.value.trim();
      if (!projectName || !vaultFolder) { error.textContent = 'Project name and vault folder are required.'; error.style.display = ''; return; }
      if (project) this.plugin.manager.updateProject(project.id, { name: projectName, vaultFolder, cwdOverride: cwd.value.trim() || undefined, description: description.value });
      else this.selectedProjectId = this.plugin.manager.createProject(projectName, vaultFolder, description.value, cwd.value.trim() || undefined).id;
      await this.plugin.saveSettings();
      this.display();
    });
  }

  private renderSecretsTab(containerEl: HTMLElement): void {
    this.renderManagerHeader(containerEl, 'Secrets', 'Securely provide API keys and tokens to agent sessions.', 'Add secret', () => {
      this.selectedSecretName = '';
      this.display();
      this.containerEl.querySelector<HTMLInputElement>('[aria-label="Variable name"]')?.focus();
    });
    const notice = containerEl.createDiv({ cls: 'ct-settings-notice ct-secret-storage-notice' });
    applySecretStorageCopy(this.app, notice, storage => `${storage} Values never appear in data.json. Only names and project access are saved with plugin settings.`);

    const keys = this.plugin.settings.secretEnvKeys ?? [];
    if (this.selectedSecretName === null || (this.selectedSecretName && !keys.includes(this.selectedSecretName))) this.selectedSecretName = keys[0] ?? '';
    const manager = containerEl.createDiv({ cls: 'ct-settings-manager' });
    const list = manager.createEl('section', { cls: 'ct-manager-list', attr: { 'aria-label': 'Secrets' } });
    const search = list.createEl('input', { type: 'search', placeholder: 'Search secrets', attr: { 'aria-label': 'Search secrets' } });
    const rows = list.createDiv({ cls: 'ct-manager-list-rows' });
    const mask = (value: string | null) => !value ? 'No value stored' : value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`;
    const renderRows = () => {
      rows.empty();
      const query = search.value.trim().toLowerCase();
      const matches = keys.filter(key => key.toLowerCase().includes(query));
      if (matches.length === 0) rows.createEl('p', { cls: 'ct-settings-empty', text: keys.length === 0 ? 'No secrets configured yet.' : 'No matching secrets.' });
      for (const key of matches) {
        const value = this.plugin.app.secretStorage.getSecret(secretStorageKey(key));
        const scoped = this.plugin.settings.secretEnvScopes?.[key] ?? [];
        const row = rows.createEl('button', { cls: `ct-manager-list-item${key === this.selectedSecretName ? ' is-selected' : ''}`, attr: { type: 'button' } });
        row.createEl('strong', { text: key });
        row.createEl('small', { text: mask(value) });
        row.createEl('span', { text: `${value ? 'Set' : 'Missing'} · ${scoped.length ? `${scoped.length} project${scoped.length === 1 ? '' : 's'}` : 'Global'}` });
        row.addEventListener('click', () => { this.selectedSecretName = key; this.display(); });
      }
    };
    search.addEventListener('input', renderRows);
    renderRows();

    const detail = manager.createEl('section', { cls: 'ct-manager-detail' });
    const isNew = this.selectedSecretName === '';
    const secretName = isNew ? '' : this.selectedSecretName!;
    if (!isNew && !keys.includes(secretName)) { detail.createEl('div', { cls: 'ct-manager-empty', text: 'Add a secret to securely provide credentials to agent sessions.' }); return; }
    detail.createEl('h2', { text: isNew ? 'New secret' : secretName });
    const currentValue = isNew ? null : this.plugin.app.secretStorage.getSecret(secretStorageKey(secretName));
    const form = detail.createDiv({ cls: 'ct-manager-form' });
    const name = this.createManagerField(form, 'Variable name', secretName, {
      placeholder: 'MY_API_KEY', disabled: !isNew, description: isNew ? 'Use an environment-variable identifier.' : 'Names cannot change because integrations may reference this identifier.',
    }) as HTMLInputElement;
    const replacement = this.createManagerField(form, isNew ? 'Value' : 'Replace value', '', {
      type: 'password', placeholder: isNew ? 'Paste the secret value' : 'Leave blank to keep the current value', description: !isNew ? `Current value: ${mask(currentValue)}` : undefined,
    }) as HTMLInputElement;
    const scope = form.createEl('fieldset', { cls: 'ct-secret-scope-choice' });
    scope.createEl('legend', { text: 'Project access' });
    const existingScope = this.plugin.settings.secretEnvScopes?.[secretName] ?? [];
    const globalLabel = scope.createEl('label');
    const globalRadio = globalLabel.createEl('input', { type: 'radio', attr: { name: 'secret-scope', 'aria-label': 'Global' } });
    globalRadio.checked = existingScope.length === 0;
    globalLabel.createSpan({ text: 'Global — every project and project-less thread.' });
    const selectedLabel = scope.createEl('label');
    const selectedRadio = selectedLabel.createEl('input', { type: 'radio', attr: { name: 'secret-scope', 'aria-label': 'Selected projects' } });
    selectedRadio.checked = existingScope.length > 0;
    selectedLabel.createSpan({ text: 'Selected projects' });
    const checklist = form.createDiv({ cls: 'ct-secret-projects' });
    const projectSearch = checklist.createEl('input', { type: 'search', placeholder: 'Filter projects', attr: { 'aria-label': 'Filter projects' } });
    const checks = checklist.createDiv();
    const chosen = new Set(existingScope);
    const renderChecks = () => {
      checks.empty();
      const query = projectSearch.value.trim().toLowerCase();
      for (const project of this.plugin.manager.getProjects().filter(project => project.name.toLowerCase().includes(query))) {
        const label = checks.createEl('label');
        const checkbox = label.createEl('input', { type: 'checkbox', attr: { 'aria-label': project.name } });
        checkbox.checked = chosen.has(project.id);
        checkbox.addEventListener('change', () => checkbox.checked ? chosen.add(project.id) : chosen.delete(project.id));
        label.createSpan({ text: project.name });
      }
    };
    projectSearch.addEventListener('input', renderChecks);
    renderChecks();
    const updateScopeVisibility = () => checklist.toggleClass('is-hidden', !selectedRadio.checked);
    globalRadio.addEventListener('change', updateScopeVisibility);
    selectedRadio.addEventListener('change', updateScopeVisibility);
    updateScopeVisibility();
    const error = detail.createEl('p', { cls: 'ct-manager-error', attr: { role: 'alert' } });
    error.style.display = 'none';
    if (!isNew) {
      const danger = detail.createDiv({ cls: 'ct-manager-danger' });
      const warning = danger.createDiv(); warning.createEl('strong', { text: 'Remove secret' }); warning.createEl('small', { text: 'Clears the stored value and project access.' });
      const remove = danger.createEl('button', { text: 'Remove…', cls: 'mod-warning', attr: { type: 'button' } });
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Remove ${secretName}? Its stored value and project access will be cleared.`)) return;
        this.plugin.app.secretStorage.setSecret(secretStorageKey(secretName), '');
        this.plugin.settings.secretEnvKeys = keys.filter(key => key !== secretName);
        if (this.plugin.settings.secretEnvScopes) delete this.plugin.settings.secretEnvScopes[secretName];
        await this.plugin.saveSettings(); this.selectedSecretName = null; this.display();
      });
    }
    const actions = detail.createEl('footer', { cls: 'ct-manager-actions' });
    const state = actions.createEl('span', { text: isNew ? 'New secret draft' : 'No unsaved changes' });
    for (const input of [name, replacement, globalRadio, selectedRadio]) input.addEventListener('input', () => { state.textContent = 'Unsaved changes'; });
    const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
    cancel.addEventListener('click', () => { if (isNew) this.selectedSecretName = keys[0] ?? null; this.display(); });
    const save = actions.createEl('button', { text: isNew ? 'Add secret' : 'Save changes', cls: 'mod-cta', attr: { type: 'button' } });
    save.addEventListener('click', async () => {
      const resolvedName = name.value.trim().toUpperCase();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(resolvedName)) { error.textContent = 'Use a valid environment-variable name (letters, numbers, and underscores).'; error.style.display = ''; return; }
      if (isNew && keys.includes(resolvedName)) { error.textContent = 'A secret with this name already exists.'; error.style.display = ''; return; }
      if (isNew && !replacement.value.trim()) { error.textContent = 'A value is required for a new secret.'; error.style.display = ''; return; }
      if (selectedRadio.checked && chosen.size === 0) { error.textContent = 'Select at least one project, or choose Global.'; error.style.display = ''; return; }
      if (replacement.value.trim()) this.plugin.app.secretStorage.setSecret(secretStorageKey(resolvedName), replacement.value.trim());
      if (isNew) this.plugin.settings.secretEnvKeys = [...keys, resolvedName];
      const scopes = this.plugin.settings.secretEnvScopes ?? (this.plugin.settings.secretEnvScopes = {});
      if (selectedRadio.checked) scopes[resolvedName] = [...chosen]; else delete scopes[resolvedName];
      await this.plugin.saveSettings(); this.selectedSecretName = resolvedName; this.display();
    });
  }

  // ── Features ────────────────────────────────────────────────────────────

  private renderFeaturesTab(containerEl: HTMLElement): void {
    // — Summarization —
    new Setting(containerEl)
      .setName('Summarization')
      .setDesc('Short summary + suggested title per thread, generated with the Claude CLI. Keeps the Agents List readable at a glance.')
      .setHeading();

    new Setting(containerEl)
      .setName('Enable summarization')
      .setDesc('Master switch. Auto-names threads once each turn completes, shows a Summarize button in each thread, and enables the "Summarize active thread" command. Turn off to stop all summarizer calls.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.summarizationEnabled).onChange(async (value) => {
          this.plugin.settings.summarizationEnabled = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.summarizationEnabled) {
      new Setting(containerEl)
        .setName('Auto-summarize after response')
        .setDesc('Keep refreshing the summary after every completed turn even once you have renamed a thread yourself. When off, threads are still summarized each turn, but only until you rename one — after that the thread is left alone.')
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.autoSummarize).onChange(async (value) => {
            this.plugin.settings.autoSummarize = value;
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('Summarization model')
        .setDesc('Model alias passed to claude --model. "haiku" is fast and cheap; "sonnet" is higher quality.')
        .addText((text) =>
          text
            .setPlaceholder('haiku')
            .setValue(this.plugin.settings.inprocessModel)
            .onChange(async (value) => {
              this.plugin.settings.inprocessModel = value || 'haiku';
              await this.plugin.saveSettings();
            }),
        );
    }

    // — Speech to text —
    new Setting(containerEl).setName('Speech to text').setHeading();

    {
      const existingKey = this.app.secretStorage.getSecret('openai-api-key');
      const maskedKey = maskOpenAiKey(existingKey);
      const openAiSetting = new Setting(containerEl)
        .setName('OpenAI API key')
        .setDesc('Used for Whisper speech-to-text.');

      // Its own span, because the masked key below is a sibling in the same
      // descEl and must survive the async correction.
      applySecretStorageCopy(
        this.app,
        openAiSetting.descEl.createEl('span'),
        (storage) => ` ${storage}`,
      );

      openAiSetting.descEl.createEl('br');
      openAiSetting.descEl.createEl('span', {
        text: maskedKey,
        cls: 'ct-openai-key-display',
      });

      openAiSetting
        .addButton((btn) => {
          if (!existingKey) btn.setCta();
          btn.setButtonText(existingKey ? 'Change' : 'Set key').onClick(() => {
            new OpenAiKeyModal(this.app, () => this.display()).open();
          });
        })
        .addButton((btn) => {
          btn.setButtonText('Link existing').setTooltip('Use a key already stored by another plugin').onClick(() => {
            openSecretPicker(this.app, (secretName) => {
              if (!secretName) return;
              const actualValue = this.app.secretStorage.getSecret(secretName);
              if (actualValue) {
                this.app.secretStorage.setSecret('openai-api-key', actualValue);
                new Notice('Key linked');
                this.display();
              } else {
                new Notice('That secret has no value stored');
              }
            });
          });
        });
    }

    new Setting(containerEl)
      .setName('Push-to-talk hotkey')
      .setDesc('Hold this key while focused in any input to record. Default: Alt+Space (Option+Space on Mac).')
      .addButton((btn) => {
        const updateLabel = () => {
          btn.setButtonText(this.plugin.settings.pttKey || 'Click to set');
        };
        updateLabel();
        btn.onClick(() => {
          btn.setButtonText('Press a key…');
          btn.buttonEl.classList.add('mod-warning');
          const capture = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const key = serializeKey(e);
            if (!key) return; // bare modifier — wait for a real key
            window.removeEventListener('keydown', capture, true);
            btn.buttonEl.classList.remove('mod-warning');
            this.plugin.settings.pttKey = key;
            void this.plugin.saveSettings();
            updateLabel();
          };
          window.addEventListener('keydown', capture, true);
        });
      })
      .addExtraButton((btn) => {
        btn.setIcon('rotate-ccw').setTooltip('Reset to Alt+Space');
        btn.onClick(() => {
          this.plugin.settings.pttKey = 'Alt+Space';
          void this.plugin.saveSettings();
          this.display();
        });
      });

    // — Kanban board —
    new Setting(containerEl).setName('Agent Board').setHeading();

    new Setting(containerEl)
      .setName('Auto-collapse side panel')
      .setDesc('Collapse a sidebar when the Agent Board opens to give it more horizontal room. The panel is restored when you close the Agent Board tab.')
      .addDropdown((drop) =>
        drop
          .addOption('none', 'None (default)')
          .addOption('left', 'Left sidebar')
          .addOption('right', 'Right sidebar')
          .addOption('both', 'Both sidebars')
          .setValue(this.plugin.settings.kanbanCollapseSide ?? 'none')
          .onChange(async (value) => {
            this.plugin.settings.kanbanCollapseSide = value as PluginSettings['kanbanCollapseSide'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Stack scheduled job threads')
          .setDesc('Collapse repeat runs of the same scheduled/cron job into a single expandable stack within each project\'s quiet status sections on the Agents List and Agent Board. A run that\'s running, waiting on input, or errored is never stacked.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.stackScheduledThreads ?? true)
          .onChange(async (value) => {
            this.plugin.settings.stackScheduledThreads = value;
            await this.plugin.saveSettings();
            this.refreshKanbanAndDashboardViews();
          }),
      );

    // — Orchestrator —
    new Setting(containerEl)
      .setName('Portfolio Orchestrator')
      .setDesc('The persistent portfolio-level thread that reviews unassigned work and Project summaries.')
      .setHeading();

    {
      const orchestratorId = this.plugin.settings.orchestratorThreadId;
      const orchestratorThread = orchestratorId ? this.plugin.manager.getThread(orchestratorId) : undefined;

      if (!orchestratorId) {
        new Setting(containerEl)
          .setName('Not yet created')
          .setDesc('Run "Open Portfolio Orchestrator" from the command palette (Cmd+P) to create it.');
      } else if (orchestratorThread) {
        new Setting(containerEl)
          .setName(orchestratorThread.title)
          .setDesc('This is your Portfolio Orchestrator thread. It is marked with a bot badge in the Agents List, Agent Board, and thread switcher.')
          .addButton((btn) =>
            btn.setButtonText('Open').setCta().onClick(() => {
              void this.plugin.openThreadInChatView(orchestratorId);
            }),
          );
      } else {
        const warning = containerEl.createDiv({ cls: 'ct-settings-warning' });
        warning.createEl('strong', { text: 'Orchestrator thread missing: ' });
        warning.appendText(
          'The thread previously tracked as your Portfolio Orchestrator was deleted or archived. ' +
          'Run "Open Portfolio Orchestrator" from the command palette (Cmd+P) to create a new one.',
        );
      }
    }

  }

  // ── Scheduled ───────────────────────────────────────────────────────────

  private renderScheduledTab(containerEl: HTMLElement): void {
    const header = new Setting(containerEl)
      .setName('Scheduled work')
      .setDesc('See what runs next, review recent outcomes, and manage recurring jobs, loops, and wakeups.')
      .setHeading();

    header.addButton((btn) =>
      btn
        .setButtonText('Create with Claude')
        .setCta()
        .onClick(() => {
          const prompt =
            'Help me create scheduled work. Ask me what should happen, when it should run, and whether it needs active hours or a deterministic gate. Then use CronCreate once the schedule is clear.';
          void this.plugin.dispatchNewThread(prompt, undefined, 'Create scheduled work').then(async (threadId) => {
            await this.plugin.openThreadInChatView(threadId);
          });
        }),
    );

    const dashboard = containerEl.createDiv({ cls: 'ct-scheduled-dashboard' });
    const renderDashboard = () => {
      dashboard.empty();
      const groups = classifyScheduledItems(this.plugin.settings.scheduledItems ?? []);

      this.renderScheduledGroup(
        dashboard,
        'Recurring jobs',
        'Schedules that create a new thread when they run.',
        groups.recurring,
        renderDashboard,
      );
      this.renderScheduledGroup(
        dashboard,
        'Thread loops & wakeups',
        'Work that resumes or repeats inside an existing thread.',
        groups.threadSpecific,
        renderDashboard,
      );
      this.renderWatchedDocumentsSection(dashboard, renderDashboard);
    };

    renderDashboard();
  }

  private renderWatchedDocumentsSection(containerEl: HTMLElement, refresh: () => void): void {
    const section = containerEl.createEl('section', { cls: 'ct-scheduled-section' });
    section.createEl('h2', { text: 'Watched documents' });
    section.createEl('p', {
      text: 'Documents a thread is watching for content changes. Any edit alerts the owning thread — only that thread.',
      cls: 'ct-scheduled-section-desc',
    });

    const watches = this.plugin.settings.watchedDocuments ?? [];
    if (watches.length === 0) {
      section.createEl('p', { text: 'None yet.', cls: 'ct-settings-empty' });
      return;
    }

    for (const watch of watches) {
      const thread = this.plugin.manager.getThread(watch.threadId);
      const ownerLabel = thread ? thread.title : 'Thread no longer exists';

      const card = section.createEl('details', { cls: 'ct-scheduled-card' });
      const summary = card.createEl('summary', { cls: 'ct-scheduled-summary' });
      const titleRow = summary.createSpan({ cls: 'ct-scheduled-card-title-row' });
      titleRow.createEl('span', { text: watch.path, cls: 'ct-scheduled-name' });
      titleRow.createEl('span', {
        text: watch.enabled ? 'Watching' : 'Paused',
        cls: `ct-scheduled-status ${watch.enabled ? 'is-enabled' : 'is-paused'}`,
      });
      const summaryMeta = summary.createSpan({ cls: 'ct-scheduled-summary-meta' });
      summaryMeta.createEl('span', { text: `Owner: ${ownerLabel}` });
      summaryMeta.createEl('span', {
        text: watch.lastAlertedAt ? `Last alerted ${new Date(watch.lastAlertedAt).toLocaleString()}` : 'Never alerted',
      });

      const content = card.createDiv({ cls: 'ct-scheduled-content' });
      const metadata = content.createDiv({ cls: 'ct-scheduled-metadata' });
      this.renderScheduledMetadata(metadata, 'Path', watch.path, true);
      this.renderScheduledMetadata(metadata, 'Owning thread', ownerLabel);
      this.renderScheduledMetadata(metadata, 'Created', new Date(watch.createdAt).toLocaleString());
      this.renderScheduledMetadata(
        metadata,
        'Last alerted',
        watch.lastAlertedAt ? new Date(watch.lastAlertedAt).toLocaleString() : 'Never',
      );

      const actions = new Setting(content).setClass('ct-scheduled-actions');
      if (thread) {
        actions.addButton((btn) =>
          btn.setButtonText('Open owning thread').onClick(() => {
            void this.plugin.openThreadInChatView(watch.threadId);
          }),
        );
      }
      actions.addButton((btn) =>
        btn.setButtonText('Unwatch').setWarning().setTooltip('Stop watching this document').onClick(async () => {
          await this.plugin.unwatchDocument(watch.threadId, { id: watch.id });
          refresh();
        }),
      );
    }
  }

  private renderScheduledGroup(
    containerEl: HTMLElement,
    title: string,
    description: string,
    items: ScheduledItem[],
    refresh: () => void,
  ): void {
    const section = containerEl.createEl('section', { cls: 'ct-scheduled-section' });
    section.createEl('h2', { text: title });
    section.createEl('p', { text: description, cls: 'ct-scheduled-section-desc' });

    if (items.length === 0) {
      section.createEl('p', { text: 'None yet.', cls: 'ct-settings-empty' });
      return;
    }

    const projectNames = new Map(this.plugin.manager.getProjects().map((project) => [project.id, project.name]));
    for (const item of items) {
      const occurrence = formatNextOccurrence(item);
      const targetThread = item.targetThreadId ? this.plugin.manager.getThread(item.targetThreadId) : undefined;
      const execution = describeScheduledExecution(
        item,
        this.plugin.settings.agentHarness ?? 'claude',
        this.plugin.settings.defaultModel ?? '',
        targetThread,
      );
      const projectName = item.projectId ? (projectNames.get(item.projectId) ?? 'Unknown project') : 'No project';
      const card = section.createEl('details', { cls: 'ct-scheduled-card' });
      const summary = card.createEl('summary', { cls: 'ct-scheduled-summary' });
      const titleRow = summary.createSpan({ cls: 'ct-scheduled-card-title-row' });
      titleRow.createEl('span', { text: item.name, cls: 'ct-scheduled-name' });
      titleRow.createEl('span', {
        text: item.enabled ? (occurrence?.overdue ? 'Catching up' : 'Enabled') : 'Paused',
        cls: `ct-scheduled-status ${item.enabled ? (occurrence?.overdue ? 'is-overdue' : 'is-enabled') : 'is-paused'}`,
      });
      const summaryMeta = summary.createSpan({ cls: 'ct-scheduled-summary-meta' });
      summaryMeta.createEl('span', { text: formatScheduleDescription(item.schedule, !!item.gate?.command) });
      summaryMeta.createEl('span', {
        text: occurrence
          ? `${occurrence.label}: ${occurrence.relative}`
          : item.enabled
            ? `${item.gate?.command ? 'Next check' : 'Next run'} unavailable`
            : 'Paused',
        cls: occurrence?.overdue ? 'is-overdue' : '',
        attr: occurrence ? { title: occurrence.exact } : undefined,
      });
      summaryMeta.createEl('span', { text: projectName });
      summaryMeta.createEl('span', {
        text: execution.summary,
        cls: execution.missingTarget ? 'ct-scheduled-execution is-missing' : 'ct-scheduled-execution',
      });

      const content = card.createDiv({ cls: 'ct-scheduled-content' });
      const prompt = content.createDiv({ cls: 'ct-scheduled-prompt' });
      prompt.createEl('span', { text: 'Prompt', cls: 'ct-scheduled-meta-label' });
      prompt.createEl('p', { text: item.prompt });

      const metadata = content.createDiv({ cls: 'ct-scheduled-metadata' });
      this.renderScheduledMetadata(metadata, 'Last run', item.lastRun ? new Date(item.lastRun).toLocaleString() : 'Never');
      if (occurrence) {
        this.renderScheduledMetadata(metadata, occurrence.label, `${occurrence.relative} · ${occurrence.exact}`);
      }
      if (item.schedule.activeHours) {
        this.renderScheduledMetadata(
          metadata,
          'Active hours',
          `${item.schedule.activeHours.start}–${item.schedule.activeHours.end} local time`,
        );
      }
      this.renderScheduledMetadata(metadata, 'Project', projectName);
      let effectiveCwd: string;
      try {
        effectiveCwd = this.plugin.scheduler.getEffectiveCwd(item);
      } catch (err) {
        effectiveCwd = err instanceof Error ? err.message : String(err);
      }
      this.renderScheduledMetadata(metadata, 'Working directory', effectiveCwd);
      if (item.gate?.command) {
        const timeout = item.gate.timeoutSeconds ?? 30;
        const failureMode = item.gate.failOpen === false ? 'fail closed' : 'fail open';
        this.renderScheduledMetadata(metadata, 'Gate', `${item.gate.command} · ${timeout}s timeout · ${failureMode}`, true);
      } else {
        this.renderScheduledMetadata(metadata, 'Gate', 'None');
      }
      this.renderScheduledMetadata(metadata, 'Execution', execution.detail);

      const actions = new Setting(content).setClass('ct-scheduled-actions');
      actions.addButton((btn) =>
        btn.setButtonText(item.enabled ? 'Pause' : 'Resume').onClick(async () => {
          await this.plugin.scheduler.updateItem(item.id, { enabled: !item.enabled });
          refresh();
        }),
      );

      if (item.lastThreadId && this.plugin.manager.getThread(item.lastThreadId)) {
        actions.addButton((btn) =>
          btn.setButtonText('Open last run').onClick(() => {
            void this.plugin.openThreadInChatView(item.lastThreadId as string);
          }),
        );
      }

      actions.addButton((btn) =>
        btn.setButtonText('Delete').setWarning().setTooltip('Delete scheduled work').onClick(async () => {
          await this.plugin.scheduler.deleteItem(item.id);
          refresh();
        }),
      );

      renderRunHistory(content, item.runHistory ?? []);
    }
  }

  private renderScheduledMetadata(
    containerEl: HTMLElement,
    label: string,
    value: string,
    code = false,
  ): void {
    const row = containerEl.createDiv({ cls: 'ct-scheduled-meta-row' });
    row.createEl('span', { text: label, cls: 'ct-scheduled-meta-label' });
    row.createEl(code ? 'code' : 'span', { text: value, cls: 'ct-scheduled-meta-value' });
  }

  // ── Remote ──────────────────────────────────────────────────────────────

  private renderRemoteTab(containerEl: HTMLElement): void {
    const ra = this.plugin.settings.remoteAccess;

    new Setting(containerEl)
      .setName('Enable remote access')
      .setDesc('Let Obsidian Mobile connect to this desktop via a relay server and control sessions in real time.')
      .addToggle((toggle) =>
        toggle.setValue(ra.enabled).onChange(async (value) => {
          ra.enabled = value;
          if (value && !ra.roomId) {
            ra.roomId = generateRoomId();
          }
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.initDesktopRelayClient();
          } else {
            this.plugin.relayClient?.disconnect();
            this.plugin.relayClient = null;
          }
          this.display(); // Refresh to show/hide controls
        }),
      );

    if (ra.enabled && ra.roomId) {
      const maskedId = '••••••••-••••••••-••••••••-' + ra.roomId.slice(-8).toUpperCase();

      new Setting(containerEl)
        .setName('Room ID')
        .setDesc(`Your device pairing identifier. ${maskedId}`)
        .addButton((btn) =>
          btn
            .setButtonText('Show pairing QR code')
            .setCta()
            .onClick(() => {
              new PairingModal(this.app, this.plugin).open();
            }),
        )
        .addButton((btn) =>
          btn
            .setButtonText('Rotate room ID')
            .setWarning()
            .onClick(async () => {
              ra.roomId = generateRoomId();
              ra.pairingCode = null;
              ra.pairingExpiresAt = null;
              await this.plugin.saveSettings();
              this.plugin.relayClient?.disconnect();
              this.plugin.relayClient = null;
              if (ra.enabled) {
                this.plugin.initDesktopRelayClient();
              }
              this.display();
            }),
        );

      const isConnected = this.plugin.relayClient?.isConnected() ?? false;
      new Setting(containerEl)
        .setName('Connection status')
        .setDesc(isConnected ? 'Mobile relay connected' : 'Mobile relay not connected');

      new Setting(containerEl)
        .setName('Relay URL')
        .setDesc('WebSocket relay server URL. Change only if self-hosting.')
        .addText((text) =>
          text
            .setPlaceholder('wss://relay.claude-threads.rbcodelabs.com')
            .setValue(ra.relayUrl)
            .onChange(async (value) => {
              ra.relayUrl = value || 'wss://relay.claude-threads.rbcodelabs.com';
              await this.plugin.saveSettings();
            }),
        );
    }
  }

  // ── Skills ───────────────────────────────────────────────────────────────

  private renderSkillsTab(containerEl: HTMLElement): void {
    let localFolder = this.plugin.settings.localSkillsFolder ?? 'Skills';
    new Setting(containerEl)
      .setName('Local skills folder')
      .setDesc('Vault-relative folder for authored skills. Changes apply to new sessions; existing files are not moved. Installs and imports keep their current location.')
      .addText(text => text.setValue(localFolder).onChange(value => { localFolder = value; }))
      .addButton(button => button.setButtonText('Apply').onClick(async () => {
        try {
          await this.plugin.setLocalSkillsFolder(localFolder);
          new Notice('Local skills folder saved. Skills are available in new sessions.');
        } catch (error) { new Notice(String(error)); }
      }));
    containerEl.createEl('h2', { text: 'Skill Sources' });
    containerEl.createEl('p', {
      text: 'Register local skill collections to browse and install from within the Skills Manager.',
      cls: 'setting-item-description',
    });

    const sourcesList = containerEl.createDiv({ cls: 'ct-skill-sources-list' });
    const renderSources = () => {
      sourcesList.empty();
      const sources = this.plugin.settings.skillSources ?? [];
      if (sources.length === 0) {
        sourcesList.createEl('p', { text: 'No skill sources configured yet.', cls: 'ct-settings-empty' });
      } else {
        for (const source of sources) {
          const desc = source.type === 'github'
            ? (source.repoUrl ?? source.clonePath ?? '')
            : (source.skillsPath ?? '');

          const row = new Setting(sourcesList)
            .setName(source.name)
            .setDesc(desc);

          // Staleness badge
          if (source.type === 'github' && source.behindCount && source.behindCount > 0) {
            row.nameEl.createEl('span', {
              cls: 'ct-skill-source-updates-badge',
              text: `• ${source.behindCount} update${source.behindCount > 1 ? 's' : ''} available`,
            });
          }

          if (source.type === 'github' && source.repoUrl) {
            row.descEl.createEl('br');
            row.descEl.createEl('span', {
              text: `Clone: ${source.clonePath ?? source.id}`,
              cls: 'ct-skill-source-repo',
            });
          } else if (source.type === 'local' && source.repoPath) {
            row.descEl.createEl('br');
            row.descEl.createEl('span', {
              text: `Repo: ${source.repoPath}`,
              cls: 'ct-skill-source-repo',
            });
          }

          // Update button (github sources only, when behind)
          if (source.type === 'github' && source.behindCount && source.behindCount > 0) {
            row.addButton((btn) =>
              btn.setButtonText('Update').onClick(async () => {
                try {
                  // eslint-disable-next-line @typescript-eslint/no-require-imports
                  const { execSync } = require('child_process') as typeof import('child_process');
                  execSync(`git -C "${source.clonePath}" pull`, { stdio: 'pipe', timeout: 60_000 });
                  source.behindCount = 0;
                  await this.plugin.saveSettings();
                  renderSources();
                  new Notice(`Updated ${source.name}`);
                } catch (err) {
                  new Notice(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              }),
            );
          }

          row.addButton((btn) =>
            btn.setButtonText('Remove').setWarning().onClick(async () => {
              if (source.type === 'github' && source.clonePath) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fsNode = require('fs') as typeof import('fs');
                try { fsNode.rmSync(source.clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
              }
              this.plugin.settings.skillSources =
                this.plugin.settings.skillSources.filter((s) => s.id !== source.id);
              await this.plugin.saveSettings();
              renderSources();
              // Refresh Skills Manager view if it is currently open
              const { SKILLS_VIEW_TYPE, SkillsManagerView } =
                require('./SkillsManagerView') as typeof import('./SkillsManagerView');
              for (const leaf of this.app.workspace.getLeavesOfType(SKILLS_VIEW_TYPE)) {
                if (leaf.view instanceof SkillsManagerView) {
                  void leaf.view.refresh();
                }
              }
            }),
          );
        }
      }
    };
    renderSources();

    new Setting(containerEl)
      .addButton((btn) =>
        btn.setButtonText('Add Source').setCta().onClick(() => {
          new AddSkillSourceModal(this.app, this.plugin, () => {
            renderSources();
            // Refresh Skills Manager view if it is currently open
            const { SKILLS_VIEW_TYPE, SkillsManagerView } =
              require('./SkillsManagerView') as typeof import('./SkillsManagerView');
            for (const leaf of this.app.workspace.getLeavesOfType(SKILLS_VIEW_TYPE)) {
              if (leaf.view instanceof SkillsManagerView) {
                void leaf.view.refresh();
              }
            }
          }).open();
        }),
      );
  }

  // ── MCP ─────────────────────────────────────────────────────────────────

  private renderMcpTab(containerEl: HTMLElement): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listMcpServers, deleteMcpServer, findUnresolvedPlaceholders } =
      require('./mcpServerStore') as typeof import('./mcpServerStore');

    containerEl.createEl('h2', { text: 'MCP Servers' });
    containerEl.createEl('h3', { text: 'Google Workspace' });
    const googleStatus = containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: this.plugin.googleWorkspaceMcp?.status() ?? 'Google Workspace requires desktop Google Docs Sync with a connected account.',
    });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Enable Google-provided read and write tools using your Google Docs Sync connection. Selected services apply to new threads, including scheduled threads. Disabling a service revokes existing Google connections. After reconnecting, changing auth hosts, or token rotation, start a new thread. Google Workspace Developer Preview enrollment and service APIs are required.',
    });
    for (const [service, label] of [['docs', 'Google Docs'], ['drive', 'Google Drive'], ['sheets', 'Google Sheets'], ['slides', 'Google Slides']] as const) {
      new Setting(containerEl).setName(label).addToggle(toggle => toggle
        .setValue(this.plugin.settings.googleWorkspaceMcp?.[service] === true)
        .onChange(async enabled => {
          this.plugin.settings.googleWorkspaceMcp = { ...this.plugin.settings.googleWorkspaceMcp, [service]: enabled };
          await this.plugin.saveSettings();
          await this.plugin.googleWorkspaceMcp?.configure(this.plugin.settings.googleWorkspaceMcp);
          googleStatus.setText(this.plugin.googleWorkspaceMcp?.status() ?? 'Google Workspace requires desktop Google Docs Sync with a connected account.');
        }));
    }
    containerEl.createEl('h3', { text: 'OAuth MCP servers' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Remote MCP servers that require their own OAuth sign-in. Connect one with "Add MCP server" ' +
        'below (choose OAuth), or by asking an agent to call mcp_register_server. Either way the ' +
        'provider\'s consent screen opens in the Web Viewer; tokens are kept in the OS keychain. ' +
        'Disconnect revokes them and stops the local proxy.',
    });
    const oauthListEl = containerEl.createDiv({ cls: 'ct-oauth-mcp-servers-list' });
    const renderOAuthList = () => {
      oauthListEl.empty();
      const entries = Object.entries(this.plugin.settings.oauthMcpServers ?? {}).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) {
        oauthListEl.createEl('p', { text: 'No OAuth MCP servers connected yet.', cls: 'ct-settings-empty' });
        return;
      }
      for (const [name, entry] of entries) {
        const state = this.plugin.oauthMcpRegistry?.status(name);
        const { label, tone } = describeOAuthMcpStatus(state);
        const row = new Setting(oauthListEl).setName(name).setDesc(entry.url);
        row.nameEl.createEl('span', { cls: `ct-oauth-status-dot ct-oauth-status-dot--${tone}` });
        row.nameEl.createEl('span', { cls: 'ct-oauth-status-label', text: label });
        if (state?.status === 'error' && state.errorMessage) {
          row.descEl.createEl('br');
          row.descEl.createEl('span', { cls: 'ct-mcp-server-warning', text: state.errorMessage });
        }
        row.addButton((btn) =>
          btn.setButtonText('Disconnect').setWarning().onClick(async () => {
            await this.plugin.oauthMcpRegistry?.disconnect(name);
            new Notice(`Disconnected "${name}".`);
            renderOAuthList();
          }),
        );
      }
    };
    renderOAuthList();

    containerEl.createEl('h3', { text: 'Custom MCP servers' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'External MCP servers merged into every new thread this plugin starts, on both the Claude ' +
        'and Codex harnesses. These are stored in this plugin\'s own data.json and are injected ' +
        'into each session at runtime — they are not written to ~/.claude/, and the `claude` CLI ' +
        'does not see them. Changes apply to new threads only; sessions already running are unaffected.',
    });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Use ${VAR_NAME} anywhere in a header, URL, or env value to reference a secret, then ' +
        'register that name under Settings → Secrets. A server whose placeholders cannot be ' +
        'resolved is skipped rather than started with blank values.',
    });

    // Presence check only — the settings UI never reads secret values out of the
    // keychain. A name registered under Settings → Secrets counts as resolvable.
    const knownEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const key of this.plugin.settings.secretEnvKeys ?? []) knownEnv[key] = 'set';

    const listEl = containerEl.createDiv({ cls: 'ct-mcp-servers-list' });
    const renderList = () => {
      listEl.empty();
      const { servers, invalid } = listMcpServers(this.plugin.settings);

      if (servers.length === 0 && invalid.length === 0) {
        listEl.createEl('p', { text: 'No MCP servers configured yet.', cls: 'ct-settings-empty' });
        return;
      }

      for (const server of servers) {
        const summary =
          server.type === 'stdio'
            ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
            : (server.url ?? '');

        const row = new Setting(listEl)
          .setName(server.name)
          .setDesc(summary || '(not configured)');

        row.nameEl.createEl('span', {
          cls: `ct-mcp-type-badge ct-mcp-type-badge--${server.type}`,
          text: server.type,
        });

        const missing = findUnresolvedPlaceholders(server, knownEnv);
        if (missing.length > 0) {
          row.descEl.createEl('br');
          row.descEl.createEl('span', {
            cls: 'ct-mcp-server-warning',
            text:
              `Will be skipped: ${missing.map((m) => '${' + m + '}').join(', ')} ` +
              `${missing.length === 1 ? 'is' : 'are'} not registered under Settings → Secrets.`,
          });
        }

        row.addButton((btn) =>
          btn.setButtonText('Edit').onClick(() => {
            new McpServerModal(this.app, this.plugin, server, () => renderList()).open();
          }),
        );

        row.addButton((btn) =>
          btn.setButtonText('Remove').setWarning().onClick(() => {
            const result = deleteMcpServer(this.plugin.settings, server.name);
            if (!result.ok) {
              new Notice(`Could not remove "${server.name}": ${result.error}`);
              return;
            }
            void this.plugin.saveSettings();
            new Notice(`Removed MCP server "${server.name}".`);
            renderList();
          }),
        );
      }

      // Entries that failed validation are shown rather than silently dropped,
      // so hand-edited data.json damage is visible and removable.
      for (const name of invalid) {
        const row = new Setting(listEl)
          .setName(name)
          .setDesc('Not a valid MCP server entry — it will be skipped. Remove it, or fix it in data.json.');
        row.nameEl.createEl('span', {
          cls: 'ct-mcp-type-badge ct-mcp-type-badge--unknown',
          text: 'invalid',
        });
        row.addButton((btn) =>
          btn.setButtonText('Remove').setWarning().onClick(() => {
            deleteMcpServer(this.plugin.settings, name);
            void this.plugin.saveSettings();
            new Notice(`Removed invalid MCP entry "${name}".`);
            renderList();
          }),
        );
      }
    };
    renderList();

    new Setting(containerEl)
      .addButton((btn) =>
        btn.setButtonText('Add MCP server').setCta().onClick(() => {
          // Refresh both lists: the modal can now land an entry in either
          // `mcpServers` (stdio/http/sse) or `oauthMcpServers` (oauth).
          new McpServerModal(this.app, this.plugin, null, () => {
            renderList();
            renderOAuthList();
          }).open();
        }),
      );
  }

  // ── Mobile ──────────────────────────────────────────────────────────────

  /** Minimal settings shown on mobile (desktop-only settings are omitted). */
  private renderMobileOnlySettings(containerEl: HTMLElement): void {
    const ra = this.plugin.settings.remoteAccess;
    const isConnected = this.plugin.relayClient?.isConnected() ?? false;

    // Connection status banner
    const statusEl = containerEl.createDiv({ cls: 'ct-mobile-status' });
    statusEl.createEl('p', {
      text: isConnected ? 'Connected to desktop.' : 'Not connected to desktop.',
      cls: isConnected ? 'ct-mobile-status-ok' : 'ct-mobile-status-disconnected',
    });

    new Setting(containerEl).setName('Pair with desktop').setHeading();
    containerEl.createEl('p', {
      text: 'On your desktop, open Settings > Agent Threads > Remote, enable remote access, then tap "Show pairing QR code". Scan that QR code with your phone camera — your phone will ask to open Obsidian, which will connect automatically.',
      cls: 'ct-settings-desc',
    });

    let manualRoomId = '';
    new Setting(containerEl)
      .setName('Pairing code')
      .setDesc('If the QR scan does not work, paste the code shown on desktop.')
      .addText((text) => {
        text
          .setPlaceholder('XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX')
          .setValue(ra.roomId ? formatRoomIdAsCode(ra.roomId) : '')
          .onChange((val) => { manualRoomId = val.trim(); });
        return text;
      })
      .addButton((btn) =>
        btn.setButtonText('Connect').setCta().onClick(async () => {
          // Accept both the formatted code (XXXX-XXXX-...) and raw hex
          const raw = manualRoomId.replace(/-/g, '').toLowerCase();
          if (!/^[0-9a-f]{32}$/.test(raw)) {
            new Notice('Invalid pairing code. Copy the code exactly from desktop Settings.');
            return;
          }
          ra.roomId = raw;
          ra.enabled = true;
          await this.plugin.saveSettings();
          this.plugin.initMobileRelayClient();
          new Notice('Connecting to desktop…');
          this.display(); // Refresh status
        }),
      );

    // Show current room ID if paired
    if (ra.roomId) {
      const maskedId = '••••••••-••••••••-••••••••-' + ra.roomId.slice(-8).toUpperCase();
      new Setting(containerEl)
        .setName('Paired room')
        .setDesc(maskedId)
        .addButton((btn) =>
          btn.setButtonText('Disconnect').setWarning().onClick(async () => {
            this.plugin.relayClient?.disconnect();
            this.plugin.relayClient = null;
            ra.roomId = '';
            ra.enabled = false;
            await this.plugin.saveSettings();
            this.display();
          }),
        );
    }

    // ── Safe Reload ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Plugin').setHeading();

    new Setting(containerEl)
      .setName('Reload plugin')
      .setDesc(
        'Reload Agent Threads. If any threads are currently running you will be warned before the plugin restarts.',
      )
      .addButton((btn) =>
        btn
          .setButtonText('Reload…')
          .onClick(() => {
            this.plugin.safeReloadPlugin().catch(console.error);
          }),
      );

    new Setting(containerEl).setName('Advanced').setHeading();

    new Setting(containerEl)
      .setName('Relay URL')
      .setDesc('WebSocket relay server. Change only if self-hosting.')
      .addText((text) =>
        text
          .setPlaceholder('wss://claude-threads-relay.rbcodelabs.workers.dev')
          .setValue(ra.relayUrl)
          .onChange(async (value) => {
            ra.relayUrl = value || 'wss://claude-threads-relay.rbcodelabs.workers.dev';
            await this.plugin.saveSettings();
          }),
      );
  }
}
