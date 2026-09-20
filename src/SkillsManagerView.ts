import { ItemView, WorkspaceLeaf, setIcon, setTooltip, Notice, Menu } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import {
  parseFrontmatter,
  copySkillFiles,
  findSkillDir,
  deriveSkillId,
  extractZipToDir,
  importSkillFromPath,
  listInstalledSkills,
  uninstallSkillByPath,
  searchMarketplaceSkills,
  getPopularMarketplaceSkills,
  getMarketplaceSkillDescription,
  checkAllSourcesForUpdates,
  cloneGithubSource,
  pullGithubSourceUpdates,
  listGithubSourceSkills,
  installSkillFromMarketplace,
  type InstalledSkillInfo,
  type MarketplaceSkill,
} from './skillManager';
import { canEditSkill } from './skillPaths';
import { ConfirmModal } from './confirmModal';

// ConfirmModal used to be declared in this file. It moved to confirmModal.ts so
// leaf modules (the archive context menu) can use it without importing the
// whole skills manager; re-exported here so existing importers keep working.
export { ConfirmModal } from './confirmModal';

// Re-exported so existing unit tests (test/unit/findSkillDir.test.ts,
// importSkill.test.ts, parseFrontmatter.test.ts) that import these helpers
// from '../../src/SkillsManagerView' keep working unchanged — skillManager.ts
// is now their single source of truth.
export {
  parseFrontmatter,
  copySkillFiles,
  findSkillDir,
  deriveSkillId,
  extractZipToDir,
  importSkillFromPath,
};

export const SKILLS_VIEW_TYPE = 'claude-threads:skills';

// ── Types ────────────────────────────────────────────────────────────────────

/** Alias kept for readability within this file; identical shape to skillManager's InstalledSkillInfo. */
type InstalledSkill = InstalledSkillInfo;

/** Alias kept for readability within this file; identical shape to skillManager's MarketplaceSkill. */
type BrowseSkill = MarketplaceSkill;

interface LocalSkill {
  id: string;           // subdir name
  name: string;         // from SKILL.md frontmatter, or subdir name
  description: string;
  skillsPath: string;   // expanded skillsPath from source
  skillDir: string;     // full path to this skill's directory
  /** True when this skill comes from a github-type source (registered via settings.json, no symlink needed) */
  isGithubSource?: boolean;
}

interface InstalledAgent {
  name: string;
  description: string;
  /** Absolute path to the .md file */
  agentPath: string;
  content: string;
}

/**
 * Electron's renderer `File` objects carry a non-standard absolute `.path`
 * property (populated because this plugin runs with nodeIntegration on).
 * Used by the folder/file import pickers to get a filesystem path instead of
 * file contents.
 */
type ElectronFile = File & { path: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatInstalls(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K installs`;
  return `${count} install${count === 1 ? '' : 's'}`;
}

// ── Main View ─────────────────────────────────────────────────────────────────

export class SkillsManagerView extends ItemView {
  private plugin: ClaudeThreadsPlugin;

  // Tab state
  private activeTab: 'installed' | 'browse' = 'installed';

  // Installed tab
  private installedSkills: InstalledSkill[] = [];
  private selectedInstalled: InstalledSkill | null = null;
  private editContent = '';
  private isDirty = false;
  private installedFilter = '';

  // Agents (Installed tab)
  private installedAgents: InstalledAgent[] = [];
  private selectedAgent: InstalledAgent | null = null;
  private agentEditContent = '';
  private isAgentDirty = false;

  // Browse tab
  private browseResults: BrowseSkill[] = [];
  private browsePopularResults: BrowseSkill[] = [];
  private selectedBrowse: BrowseSkill | null = null;
  private browseQuery = '';
  private isBrowseLoading = false;
  private isPopularLoading = false;
  private browseSearchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cache of fetched SKILL.md descriptions keyed by slug */
  private browseDescriptions: Map<string, string | null> = new Map();
  /** Slugs currently being fetched */
  private browseDescLoading: Set<string> = new Set();
  /** Active browse source: 'registry' for skills.sh, or a SkillSource ID for a local source */
  private browseSource: 'registry' | string = 'registry';
  /** Skills loaded from the active local source */
  private localSkills: LocalSkill[] = [];
  /** Selected skill from a local source */
  private selectedLocalSkill: LocalSkill | null = null;
  /** Whether local skills are loading */
  private isLocalSkillsLoading = false;

  /** Selected GitHub source plugin in the Installed tab */
  private selectedGithubSource: import('./types').SkillSource | null = null;
  /** Skills loaded per GitHub source id (installed tab detail) */
  private githubSourceSkillsMap: Map<string, LocalSkill[]> = new Map();
  /** Source ids whose skills are currently being loaded */
  private githubSourceSkillsLoadingSet: Set<string> = new Set();
  /** Which source tree nodes are expanded (a source id, or one of the group keys below) */
  private expandedSources: Set<string> = new Set();
  /** Selected child skill within a GitHub source node */
  private selectedGithubSourceSkill: { skill: LocalSkill; source: import('./types').SkillSource } | null = null;

  // Install progress
  private installingSlug: string | null = null;
  private installOutput = '';

  /**
   * True while the "New skill" authoring form owns the detail pane. Tracked as
   * state rather than rendered ad-hoc so it survives a `renderDetail()` call
   * and counts as a detail view for the narrow-mode single-pane collapse.
   */
  private isCreatingNewSkill = false;

  // Check for updates state
  private isCheckingUpdates = false;

  // DOM refs (stable across re-renders)
  private tabsEl!: HTMLElement;
  private tabsListEl!: HTMLElement;
  private tabActionsEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private listEl!: HTMLElement;
  private dividerEl!: HTMLElement;
  private detailEl!: HTMLElement;
  /** Hidden input used by the "Import Folder…" button in the Installed tab */
  private importFolderInputEl!: HTMLInputElement;
  /** Hidden input used by the "Import File (.skill)…" button in the Installed tab */
  private importFileInputEl!: HTMLInputElement;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeThreadsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  /** Shown wherever an install/import is attempted without a resolvable vault skills folder. */
  private static readonly NO_INSTALL_ROOT_MESSAGE =
    'Cannot resolve the vault skills folder, so there is nowhere to install to. Skill installs need a desktop vault on a real filesystem.';

  /** Tree group key: skills this plugin installed into the vault. Editable. */
  private static readonly VAULT_GROUP = '__vault__';
  /** Tree group key: everything under ~/.claude/ — skills and agents alike. Read-only. */
  private static readonly CLAUDE_GROUP = '__claude__';

  getViewType(): string { return SKILLS_VIEW_TYPE; }
  getDisplayText(): string { return 'Skills Manager'; }
  getIcon(): string { return 'puzzle'; }

  async onOpen(): Promise<void> {
    this.buildShell();

    // Expand all sources (including both local groups) by default
    const githubSources = (this.plugin.settings.skillSources ?? []).filter(s => s.type === 'github');
    this.expandedSources = new Set([
      ...githubSources.map(s => s.id),
      SkillsManagerView.VAULT_GROUP,
      SkillsManagerView.CLAUDE_GROUP,
    ]);

    await Promise.all([this.loadInstalledSkills(), this.loadInstalledAgents()]);

    // Preload skills for all github sources in the background
    for (const source of githubSources) {
      void this.loadGithubSourceSkillsForInstalled(source);
    }

    // Background staleness check for github sources
    void this.checkAllSourceStaleness();
  }

  /** Re-load installed skills and agents, then re-render the list/detail panes. Called by
   *  SettingsTab when a new GitHub source is added so the view stays in sync. */
  async refresh(): Promise<void> {
    await Promise.all([this.loadInstalledSkills(), this.loadInstalledAgents()]);
    this.renderList();
    this.renderDetail();
    void this.checkAllSourceStaleness();
  }

  /** Shared "All up to date" / "N plugins have updates" phrasing for the check-for-updates tooltip and toast. */
  private describeUpdateStatus(totalBehind: number, sources: import('./types').SkillSource[]): string {
    if (totalBehind === 0) return 'All up to date';
    const n = sources.filter((s) => (s.behindCount ?? 0) > 0).length;
    return `${n} plugin${n !== 1 ? 's' : ''} ${n !== 1 ? 'have' : 'has'} updates`;
  }

  /** Result of a bulk staleness check: how many sources were attempted and which ones failed (with a reason). */
  private async checkAllSourceStaleness(): Promise<{ checked: number; failed: { name: string; error: string }[] }> {
    const sources = (this.plugin.settings.skillSources ?? []).filter(
      (s) => s.type === 'github' && s.clonePath,
    );
    const results = await checkAllSourcesForUpdates(sources);
    const failed: { name: string; error: string }[] = [];

    for (const result of results) {
      const source = sources.find((s) => s.id === result.id);
      if (!source) continue;

      if (result.error) {
        // Previously swallowed silently, which made "Check for updates" look like a no-op
        // whenever git failed (auth prompt, offline, wrong path, etc). Surface it instead.
        console.error(`[ClaudeThreads] Staleness check failed for "${source.name}":`, result.error);
        failed.push({ name: source.name, error: result.error });
        continue;
      }

      source.behindCount = result.behindCount;
      source.lastFetched = result.lastFetched;
      await this.plugin.saveSettings();
      // Re-render to reflect updated staleness badges
      this.renderList();
      if (this.selectedGithubSource?.id === source.id) {
        this.renderDetail();
      }
    }

    return { checked: sources.length, failed };
  }

  async onClose(): Promise<void> {
    if (this.browseSearchTimer) clearTimeout(this.browseSearchTimer);
  }

  // ── Shell (built once) ────────────────────────────────────────────────────

  private buildShell(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-skills-root');

    // Reset Obsidian's default button box-shadow in our root
    // (ct-skills-root button rule in styles.css handles this)

    // Hidden file inputs backing the "Import Folder…" / "Import File (.skill)…"
    // buttons in the Installed tab. `webkitdirectory` has no meaningful string
    // value in HTML, so it's set directly via setAttribute rather than through
    // createEl's attr map.
    this.importFolderInputEl = root.createEl('input', { attr: { type: 'file' } });
    this.importFolderInputEl.setAttribute('webkitdirectory', '');
    this.importFolderInputEl.style.display = 'none';
    this.importFolderInputEl.addEventListener('change', () => {
      const files = this.importFolderInputEl.files;
      const first = files?.[0] as ElectronFile | undefined;
      this.importFolderInputEl.value = '';
      if (!first || !first.path || !first.webkitRelativePath) return;
      const folderPath = first.path.slice(0, first.path.length - first.webkitRelativePath.length);
      void this.importSkillFromFolder(folderPath);
    });

    this.importFileInputEl = root.createEl('input', {
      attr: { type: 'file', accept: '.skill,.zip' },
    });
    this.importFileInputEl.style.display = 'none';
    this.importFileInputEl.addEventListener('change', () => {
      const file = this.importFileInputEl.files?.[0] as ElectronFile | undefined;
      this.importFileInputEl.value = '';
      if (!file || !file.path) return;
      void this.importSkillFromFile(file.path);
    });

    // Tab bar: tab labels on the left, Import/Check-for-updates icon buttons on the right
    this.tabsEl = root.createEl('div', { cls: 'ct-skills-tabs' });
    this.tabsListEl = this.tabsEl.createEl('div', { cls: 'ct-skills-tabs-list' });
    this.tabActionsEl = this.tabsEl.createEl('div', { cls: 'ct-skills-tabs-actions' });
    this.buildTabs();

    // Body: left list + draggable divider + right detail.
    // Also the container for the narrow-mode query — sized off this element
    // rather than the viewport so the layout responds to the pane's own width,
    // which is what actually varies (sidebar vs. full-width tab).
    const body = root.createEl('div', { cls: 'ct-skills-body' });
    this.bodyEl = body;
    this.listEl = body.createEl('div', { cls: 'ct-skills-list' });
    this.dividerEl = body.createEl('div', { cls: 'ct-skills-divider' });
    this.detailEl = body.createEl('div', { cls: 'ct-skills-detail' });

    this.listEl.style.width = `${this.clampListWidth(this.plugin.settings.skillsListWidth, body)}px`;
    this.setupListResizer(body);

    this.renderList();
    this.renderDetail();
  }

  /** Minimum/maximum width (px) the left list panel can be dragged to. */
  private static readonly LIST_MIN_WIDTH = 140;
  private static readonly LIST_MAX_WIDTH = 480;

  /** Clamps a candidate list-panel width to the allowed range and to whatever room `body` actually has. */
  private clampListWidth(width: number, body: HTMLElement): number {
    const bodyWidth = body.getBoundingClientRect().width;
    // Leave room for the divider itself plus a usable minimum on the detail panel.
    const roomLimit = bodyWidth > 0 ? bodyWidth - 4 - 160 : SkillsManagerView.LIST_MAX_WIDTH;
    const max = Math.max(SkillsManagerView.LIST_MIN_WIDTH, Math.min(SkillsManagerView.LIST_MAX_WIDTH, roomLimit));
    return Math.min(Math.max(width, SkillsManagerView.LIST_MIN_WIDTH), max);
  }

  /** Wires up drag-to-resize on `this.dividerEl`, persisting the chosen width when the drag ends. */
  private setupListResizer(body: HTMLElement): void {
    this.dividerEl.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      this.dividerEl.setPointerCapture(e.pointerId);
      this.dividerEl.classList.add('ct-skills-divider--dragging');
      document.body.classList.add('ct-skills-resizing');

      const onPointerMove = (moveEvent: PointerEvent) => {
        const bodyRect = body.getBoundingClientRect();
        const raw = moveEvent.clientX - bodyRect.left;
        this.listEl.style.width = `${this.clampListWidth(raw, body)}px`;
      };

      const onPointerUp = () => {
        this.dividerEl.releasePointerCapture(e.pointerId);
        this.dividerEl.classList.remove('ct-skills-divider--dragging');
        document.body.classList.remove('ct-skills-resizing');
        this.dividerEl.removeEventListener('pointermove', onPointerMove);
        this.dividerEl.removeEventListener('pointerup', onPointerUp);

        const finalWidth = parseInt(this.listEl.style.width, 10);
        if (!isNaN(finalWidth)) {
          this.plugin.settings.skillsListWidth = finalWidth;
          void this.plugin.saveSettings();
        }
      };

      this.dividerEl.addEventListener('pointermove', onPointerMove);
      this.dividerEl.addEventListener('pointerup', onPointerUp);
    });

    // Double-click resets to the default width.
    this.dividerEl.addEventListener('dblclick', () => {
      const defaultWidth = this.clampListWidth(200, body);
      this.listEl.style.width = `${defaultWidth}px`;
      this.plugin.settings.skillsListWidth = defaultWidth;
      void this.plugin.saveSettings();
    });
  }

  // ── Narrow-mode (single-pane) navigation ──────────────────────────────────
  //
  // Below the container breakpoint there is not enough room for list + detail
  // side by side, so the CSS shows exactly one of them: the list until
  // something is selected, then the detail pane with a back bar. The class
  // toggled here is the only signal the stylesheet needs — the breakpoint
  // itself lives entirely in CSS, so nothing here has to measure widths or
  // listen for resizes.

  /** True when the detail pane has something to show (any tab). Drives the single-pane swap. */
  private hasActiveSelection(): boolean {
    if (this.isCreatingNewSkill) return true;
    if (this.activeTab === 'installed') {
      return !!(
        this.selectedInstalled ||
        this.selectedAgent ||
        this.selectedGithubSource ||
        this.selectedGithubSourceSkill
      );
    }
    if (this.browseSource !== 'registry') return !!this.selectedLocalSkill;
    return !!this.selectedBrowse;
  }

  /** Mirrors `hasActiveSelection()` onto the body element for the container query to key off. */
  private syncPaneVisibility(): void {
    this.bodyEl?.toggleClass('ct-skills-body--has-selection', this.hasActiveSelection());
  }

  /** Clears whatever the detail pane is showing, returning the narrow layout to the list. */
  private clearSelection(): void {
    this.isCreatingNewSkill = false;
    this.selectedInstalled = null;
    this.selectedAgent = null;
    this.selectedGithubSource = null;
    this.selectedGithubSourceSkill = null;
    this.selectedBrowse = null;
    this.selectedLocalSkill = null;
    this.editContent = '';
    this.isDirty = false;
    this.agentEditContent = '';
    this.isAgentDirty = false;
    this.renderList();
    this.renderDetail();
  }

  /**
   * Back navigation out of the detail pane. Unsaved edits would be silently
   * dropped by `clearSelection()`, so confirm first — in narrow mode this is
   * the only way back to the list, and hard-blocking it (as the "New skill"
   * button does) would strand the user in the editor.
   */
  private goBackToList(): void {
    if (this.isDirty || this.isAgentDirty) {
      new ConfirmModal(
        this.app,
        'Discard unsaved changes to this file?',
        'Discard',
        (confirmed) => { if (confirmed) this.clearSelection(); },
      ).open();
      return;
    }
    this.clearSelection();
  }

  /** Back bar prepended to the detail pane. Rendered always; shown by CSS only in narrow mode. */
  private renderDetailBackBar(): void {
    const bar = this.detailEl.createEl('div', { cls: 'ct-skills-detail-back' });
    const btn = bar.createEl('button', {
      cls: 'ct-skills-back-btn',
      attr: { 'aria-label': 'Back to skill list' },
    });
    setIcon(btn, 'arrow-left');
    btn.createEl('span', { text: this.activeTab === 'installed' ? 'Skills' : 'Browse' });
    btn.addEventListener('click', () => this.goBackToList());
  }

  /** Import / Check-for-updates icon buttons, right-aligned in the tab bar. Installed-tab only. */
  private renderTabActions(): void {
    this.tabActionsEl.empty();
    if (this.activeTab !== 'installed') return;

    const canInstall = !!this.plugin.getPluginSkillsRoot();
    const newBtn = this.tabActionsEl.createEl('button', { text: 'New skill', cls: 'ct-skills-btn ct-skills-author-btn' });
    newBtn.disabled = !this.plugin.getLocalSkillsRoot?.();
    newBtn.addEventListener('click', () => this.startNewSkill());
    const importBtn = this.tabActionsEl.createEl('button', { cls: 'clickable-icon ct-skills-tab-action' });
    setIcon(importBtn, 'plus');
    importBtn.disabled = !canInstall;
    setTooltip(importBtn, canInstall ? 'Import skill' : SkillsManagerView.NO_INSTALL_ROOT_MESSAGE);
    importBtn.addEventListener('click', (e) => {
      if (!canInstall) return;
      const menu = new Menu();
      menu.addItem(item =>
        item
          .setTitle('Folder…')
          .setIcon('folder-plus')
          .onClick(() => this.importFolderInputEl.click())
      );
      menu.addItem(item =>
        item
          .setTitle('File (.skill)…')
          .setIcon('file-up')
          .onClick(() => this.importFileInputEl.click())
      );
      menu.showAtMouseEvent(e);
    });

    const githubSources = (this.plugin.settings.skillSources ?? []).filter(s => s.type === 'github');
    if (githubSources.length === 0) return;

    const checkBtn = this.tabActionsEl.createEl('button', {
      cls: 'clickable-icon ct-skills-tab-action' + (this.isCheckingUpdates ? ' ct-skills-tab-action--spinning' : ''),
    });
    checkBtn.disabled = this.isCheckingUpdates;
    setIcon(checkBtn, 'refresh-cw');

    if (this.isCheckingUpdates) {
      setTooltip(checkBtn, 'Checking…');
      return;
    }

    // Compute result status from current behindCounts, surfaced as a tooltip
    // (plus a small dot when updates are available) rather than inline text —
    // keeps the tab bar compact instead of a wrapping text row.
    const totalBehind = githubSources.reduce((sum, s) => sum + (s.behindCount ?? 0), 0);
    const anyFetched = githubSources.some((s) => s.lastFetched != null);
    if (totalBehind > 0) {
      checkBtn.createEl('span', { cls: 'ct-skills-update-dot ct-skills-update-dot--badge' });
    }

    if (anyFetched) {
      const lastChecked = new Date(
        Math.max(...githubSources.map((s) => s.lastFetched ?? 0))
      ).toLocaleString();
      setTooltip(checkBtn, `${this.describeUpdateStatus(totalBehind, githubSources)} · Last checked ${lastChecked}`);
    } else {
      setTooltip(checkBtn, 'Check for updates');
    }

    checkBtn.addEventListener('click', () => {
      void (async () => {
        this.isCheckingUpdates = true;
        this.renderList();
        const { checked, failed } = await this.checkAllSourceStaleness();
        this.isCheckingUpdates = false;
        this.renderList();

        // Always surface a result — previously a git failure (offline, auth
        // prompt, bad clone path) was swallowed silently and the button
        // looked like it did nothing at all when clicked.
        const newTotalBehind = githubSources.reduce((sum, s) => sum + (s.behindCount ?? 0), 0);
        if (checked === 0) {
          new Notice('No GitHub plugin sources to check.');
        } else if (failed.length === checked) {
          new Notice(`Could not check for updates: ${failed[0].error}`);
        } else if (failed.length > 0) {
          const names = failed.map((f) => f.name).join(', ');
          new Notice(`${this.describeUpdateStatus(newTotalBehind, githubSources)} (failed to check: ${names})`);
        } else {
          new Notice(this.describeUpdateStatus(newTotalBehind, githubSources));
        }
      })();
    });
  }

  private buildTabs(): void {
    this.tabsListEl.empty();

    const tabs: Array<{ id: 'installed' | 'browse'; label: string }> = [
      { id: 'installed', label: 'Installed' },
      { id: 'browse', label: 'Browse' },
    ];

    for (const tab of tabs) {
      const btn = this.tabsListEl.createEl('button', {
        cls: 'ct-skills-tab' + (this.activeTab === tab.id ? ' ct-skills-tab--active' : ''),
        text: tab.label,
      });
      btn.addEventListener('click', () => {
        if (this.activeTab === tab.id) return;
        this.activeTab = tab.id;
        // The authoring form belongs to the Installed tab; leaving the tab
        // abandons it rather than letting it bleed into Browse.
        this.isCreatingNewSkill = false;
        if (tab.id !== 'installed') {
          this.selectedGithubSource = null;
          this.selectedGithubSourceSkill = null;
        }
        this.buildTabs();
        this.renderList();
        this.renderDetail();
        if (tab.id === 'browse' && this.browsePopularResults.length === 0 && !this.isPopularLoading) {
          void this.fetchPopularSkills();
        }
      });
    }
  }

  // ── List Panel ─────────────────────────────────────────────────────────────

  private renderList(): void {
    this.listEl.empty();
    this.renderTabActions();
    if (this.activeTab === 'installed') {
      this.renderInstalledList();
    } else {
      this.renderBrowseList();
    }
  }

  private renderInstalledList(): void {
    const githubSources = (this.plugin.settings.skillSources ?? []).filter(s => s.type === 'github');

    // ── Filter bar (TOP) ────────────────────────────────────────────────────
    const searchRow = this.listEl.createEl('div', { cls: 'ct-skills-search-row' });
    const searchIcon = searchRow.createEl('span', { cls: 'ct-skills-search-icon' });
    setIcon(searchIcon, 'search');
    const searchInput = searchRow.createEl('input', {
      cls: 'ct-skills-search',
      attr: { type: 'text', placeholder: 'Filter…', value: this.installedFilter },
    });
    searchInput.addEventListener('input', () => {
      this.installedFilter = searchInput.value;
      this.renderList();
      const next = this.listEl.querySelector<HTMLInputElement>('.ct-skills-search');
      if (next) { next.focus(); const len = next.value.length; next.setSelectionRange(len, len); }
    });

    // ── Count line ───────────────────────────────────────────────────────────
    const vaultCount = this.installedSkills.filter(s => s.origin === 'vault' || s.origin === 'local').length;
    const homeCount = this.installedSkills.length - vaultCount;
    const agentCount = this.installedAgents.length;
    const sourceCount = githubSources.length;
    const countParts: string[] = [];
    if (vaultCount > 0) countParts.push(`${vaultCount} vault skill${vaultCount !== 1 ? 's' : ''}`);
    if (homeCount + agentCount > 0) countParts.push(`${homeCount + agentCount} read-only`);
    if (sourceCount > 0) countParts.push(`${sourceCount} plugin${sourceCount !== 1 ? 's' : ''}`);
    this.listEl.createEl('div', { cls: 'ct-skills-count', text: countParts.join(' · ') || 'Nothing installed' });

    const q = this.installedFilter.toLowerCase();

    // ── Scrollable body (GitHub source tree + Local group) ───────────────────
    const inner = this.listEl.createEl('div', { cls: 'ct-skills-list-inner' });

    // ── GitHub source tree nodes ─────────────────────────────────────────────
    for (const source of githubSources) {
      const isExpanded = this.expandedSources.has(source.id);
      const isSelected = this.selectedGithubSource?.id === source.id && !this.selectedGithubSourceSkill;
      const sourceSkills = this.githubSourceSkillsMap.get(source.id) ?? [];
      const isLoading = this.githubSourceSkillsLoadingSet.has(source.id);

      const filteredSourceSkills = q
        ? sourceSkills.filter(s => s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q))
        : sourceSkills;

      // Hide collapsed sources with no matching children when filtering
      if (q && !isLoading && filteredSourceSkills.length === 0 && !source.name.toLowerCase().includes(q)) continue;

      // Source header row
      const sourceRow = inner.createEl('div', {
        cls: 'ct-skills-tree-source' + (isSelected ? ' ct-skills-tree-source--active' : ''),
      });
      const toggleEl = sourceRow.createEl('span', { cls: 'ct-skills-tree-toggle' });
      setIcon(toggleEl, isExpanded ? 'chevron-down' : 'chevron-right');
      sourceRow.createEl('span', { cls: 'ct-skills-tree-source-name', text: source.name });
      if (source.behindCount && source.behindCount > 0) {
        sourceRow.createEl('span', {
          cls: 'ct-skills-badge ct-skills-badge--warn',
          text: `•${source.behindCount}`,
        });
      } else {
        sourceRow.createEl('span', { cls: 'ct-skills-badge ct-skills-badge--global', text: 'GitHub' });
      }

      sourceRow.addEventListener('click', () => {
        const wasExpanded = this.expandedSources.has(source.id);
        if (wasExpanded) {
          this.expandedSources.delete(source.id);
        } else {
          this.expandedSources.add(source.id);
          if (!this.githubSourceSkillsMap.has(source.id) && !this.githubSourceSkillsLoadingSet.has(source.id)) {
            void this.loadGithubSourceSkillsForInstalled(source);
          }
        }
        this.selectedGithubSource = source;
        this.selectedInstalled = null;
        this.selectedAgent = null;
        this.selectedGithubSourceSkill = null;
        this.renderList();
        this.renderDetail();
      });

      // Children (when expanded)
      if (isExpanded) {
        if (isLoading) {
          const loadRow = inner.createEl('div', { cls: 'ct-skills-tree-child ct-skills-tree-child--loading' });
          loadRow.createEl('span', { cls: 'ct-skills-spinner' });
          loadRow.createEl('span', { text: ' Loading…' });
        } else if (filteredSourceSkills.length === 0) {
          inner.createEl('div', { cls: 'ct-skills-tree-child ct-skills-tree-empty', text: q ? 'No matches' : 'No skills found' });
        } else {
          for (const skill of filteredSourceSkills) {
            const isChildActive = this.selectedGithubSourceSkill?.skill.id === skill.id && this.selectedGithubSourceSkill?.source.id === source.id;
            const childRow = inner.createEl('div', {
              cls: 'ct-skills-tree-child' + (isChildActive ? ' ct-skills-tree-child--active' : ''),
            });
            childRow.createEl('span', { cls: 'ct-skills-tree-child-name', text: skill.name });
            childRow.createEl('span', { cls: 'ct-skills-tree-child-badge', text: 'skill' });
            childRow.addEventListener('click', () => {
              this.selectedGithubSourceSkill = { skill, source };
              this.selectedGithubSource = null;
              this.selectedInstalled = null;
              this.selectedAgent = null;
              this.renderList();
              this.renderDetail();
            });
          }
        }
      }
    }

    // ── Vault node (this plugin's own installs — editable) ───────────────────
    // Split from the old single "Local" node so the read-only half is obvious
    // at a glance rather than only after clicking into a detail pane.
    const matchesQuery = (name: string, description?: string) =>
      !q || name.toLowerCase().includes(q) || (description?.toLowerCase().includes(q) ?? false);

    const vaultSkills = this.installedSkills.filter(s => !s.sourceName && s.origin === 'vault');
    const homeSkills = this.installedSkills.filter(s => !s.sourceName && s.origin === 'home');
    const authoredSkills = this.installedSkills.filter(s => s.origin === 'local');
    this.renderTreeGroup(inner, {
      key: 'authored', label: 'Local skills', hasAnyItems: authoredSkills.length > 0,
      skills: authoredSkills.filter(s => matchesQuery(s.name, s.description)), agents: [],
    });
    const filteredVaultSkills = vaultSkills.filter(s => matchesQuery(s.name, s.description));
    const filteredHomeSkills = homeSkills.filter(s => matchesQuery(s.name, s.description));
    const filteredAgents = this.installedAgents.filter(a => matchesQuery(a.name, a.description));

    this.renderTreeGroup(inner, {
      key: SkillsManagerView.VAULT_GROUP,
      label: 'Vault',
      hasAnyItems: vaultSkills.length > 0,
      skills: filteredVaultSkills,
      agents: [],
    });

    // ── Claude Code node (~/.claude/ — skills AND agents, all read-only) ─────
    this.renderTreeGroup(inner, {
      key: SkillsManagerView.CLAUDE_GROUP,
      label: 'Claude Code',
      badge: 'read-only',
      hasAnyItems: homeSkills.length > 0 || this.installedAgents.length > 0,
      // Agents first, matching the old ordering within the merged node.
      skills: filteredHomeSkills,
      agents: filteredAgents,
    });
  }

  /** Renders one collapsible group of installed skills and/or agents in the Installed tree. */
  private renderTreeGroup(
    inner: HTMLElement,
    group: {
      key: string;
      label: string;
      badge?: string;
      hasAnyItems: boolean;
      skills: InstalledSkill[];
      agents: InstalledAgent[];
    },
  ): void {
    const hasMatches = group.skills.length > 0 || group.agents.length > 0;
    // Hide the group entirely when it is empty, or when a filter excludes all
    // of its children — but keep it while unfiltered so an empty Vault node
    // does not vanish and leave the user wondering where installs go.
    if (!group.hasAnyItems) return;
    if (this.installedFilter && !hasMatches) return;

    const isExpanded = this.expandedSources.has(group.key);
    const row = inner.createEl('div', { cls: 'ct-skills-tree-source' });
    const toggle = row.createEl('span', { cls: 'ct-skills-tree-toggle' });
    setIcon(toggle, isExpanded ? 'chevron-down' : 'chevron-right');
    row.createEl('span', { cls: 'ct-skills-tree-source-name', text: group.label });
    if (group.badge) {
      row.createEl('span', { cls: 'ct-skills-badge ct-skills-badge--readonly', text: group.badge });
    }
    row.addEventListener('click', () => {
      if (this.expandedSources.has(group.key)) this.expandedSources.delete(group.key);
      else this.expandedSources.add(group.key);
      this.renderList();
    });

    if (!isExpanded) return;

    for (const agent of group.agents) {
      const isActive = this.selectedAgent?.name === agent.name;
      const childRow = inner.createEl('div', {
        cls: 'ct-skills-tree-child' + (isActive ? ' ct-skills-tree-child--active' : ''),
      });
      childRow.createEl('span', { cls: 'ct-skills-tree-child-name', text: agent.name });
      childRow.createEl('span', { cls: 'ct-skills-tree-child-badge ct-skills-tree-child-badge--agent', text: 'agent' });
      childRow.addEventListener('click', () => {
        this.selectedAgent = agent;
        this.selectedInstalled = null;
        this.selectedGithubSource = null;
        this.selectedGithubSourceSkill = null;
        this.agentEditContent = agent.content;
        this.isAgentDirty = false;
        this.renderList();
        this.renderDetail();
      });
    }

    for (const skill of group.skills) {
      const isActive = this.selectedInstalled?.skillPath === skill.skillPath;
      const childRow = inner.createEl('div', {
        cls: 'ct-skills-tree-child' + (isActive ? ' ct-skills-tree-child--active' : ''),
      });
      childRow.createEl('span', { cls: 'ct-skills-tree-child-name', text: skill.name });
      childRow.createEl('span', { cls: 'ct-skills-tree-child-badge', text: 'skill' });
      childRow.addEventListener('click', () => {
        this.selectedInstalled = skill;
        this.selectedGithubSource = null;
        this.selectedAgent = null;
        this.selectedGithubSourceSkill = null;
        this.editContent = skill.content;
        this.isDirty = false;
        this.renderList();
        this.renderDetail();
      });
    }
  }

  private renderBrowseList(): void {
    const sources = (this.plugin.settings.skillSources ?? []).filter(s => s.type === 'local');

    // Source switcher (only shown when at least one local source is configured)
    if (sources.length > 0) {
      const switcher = this.listEl.createEl('div', { cls: 'ct-skills-source-switcher' });

      const registryPill = switcher.createEl('button', {
        cls: 'ct-skills-tab' + (this.browseSource === 'registry' ? ' ct-skills-tab--active' : ''),
        text: 'skills.sh',
      });
      registryPill.addEventListener('click', () => {
        if (this.browseSource === 'registry') return;
        this.browseSource = 'registry';
        this.selectedLocalSkill = null;
        this.renderList();
        this.renderDetail();
      });

      for (const source of sources) {
        const pill = switcher.createEl('button', {
          cls: 'ct-skills-tab' + (this.browseSource === source.id ? ' ct-skills-tab--active' : ''),
          text: source.name,
        });
        pill.addEventListener('click', () => {
          if (this.browseSource === source.id) return;
          this.browseSource = source.id;
          this.selectedLocalSkill = null;
          this.localSkills = [];
          this.renderList();
          this.renderDetail();
          void this.loadLocalSkills(source.id);
        });
      }
    }

    // ── Local source browsing ────────────────────────────────────────────────
    if (this.browseSource !== 'registry') {
      this.renderLocalBrowseList();
      return;
    }

    // ── Registry browsing (existing skills.sh behavior) ──────────────────────
    const searchRow = this.listEl.createEl('div', { cls: 'ct-skills-search-row' });
    const searchIcon = searchRow.createEl('span', { cls: 'ct-skills-search-icon' });
    setIcon(searchIcon, 'search');
    const searchInput = searchRow.createEl('input', {
      cls: 'ct-skills-search',
      attr: { type: 'text', placeholder: 'Search skills.sh…', value: this.browseQuery },
    });
    searchInput.addEventListener('input', () => {
      this.browseQuery = searchInput.value;
      if (this.browseSearchTimer) clearTimeout(this.browseSearchTimer);
      if (this.browseQuery.length < 2) {
        this.browseResults = [];
        this.isBrowseLoading = false;
        this.renderList();
        return;
      }
      this.isBrowseLoading = true;
      this.renderList();
      this.browseSearchTimer = setTimeout(() => void this.fetchBrowseResults(), 350);
    });

    // Keep focus when re-rendering
    setTimeout(() => {
      const el = this.listEl.querySelector<HTMLInputElement>('.ct-skills-search');
      if (el && document.activeElement !== el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    }, 0);

    const inner = this.listEl.createEl('div', { cls: 'ct-skills-list-inner' });

    // ── Search active ────────────────────────────────────────────────────────
    if (this.browseQuery.length >= 2) {
      if (this.isBrowseLoading) {
        const loading = inner.createEl('div', { cls: 'ct-skills-empty' });
        loading.createEl('span', { cls: 'ct-skills-spinner' });
        loading.createEl('span', { text: ' Searching…' });
        return;
      }
      if (this.browseResults.length === 0) {
        inner.createEl('div', { cls: 'ct-skills-empty', text: `No results for "${this.browseQuery}"` });
        return;
      }
      this.renderSkillCards(inner, this.browseResults);
      return;
    }

    // ── No query — show popular list ─────────────────────────────────────────
    if (this.isPopularLoading) {
      const loading = inner.createEl('div', { cls: 'ct-skills-empty' });
      loading.createEl('span', { cls: 'ct-skills-spinner' });
      loading.createEl('span', { text: ' Loading popular skills…' });
      return;
    }

    if (this.browsePopularResults.length > 0) {
      inner.createEl('div', { cls: 'ct-skills-section-label', text: 'Popular' });
      this.renderSkillCards(inner, this.browsePopularResults);
      return;
    }

    inner.createEl('div', { cls: 'ct-skills-empty', text: 'Type to search skills.sh' });
  }

  private renderLocalBrowseList(): void {
    const inner = this.listEl.createEl('div', { cls: 'ct-skills-list-inner' });

    if (this.isLocalSkillsLoading) {
      const loading = inner.createEl('div', { cls: 'ct-skills-empty' });
      loading.createEl('span', { cls: 'ct-skills-spinner' });
      loading.createEl('span', { text: ' Loading skills…' });
      return;
    }

    if (this.localSkills.length === 0) {
      inner.createEl('div', { cls: 'ct-skills-empty', text: 'No skills found in this source' });
      return;
    }

    for (const skill of this.localSkills) {
      const isActive = this.selectedLocalSkill?.id === skill.id;
      const card = inner.createEl('div', {
        cls: 'ct-skills-card' + (isActive ? ' ct-skills-card--active' : ''),
      });

      const main = card.createEl('div', { cls: 'ct-skills-card-main' });
      main.createEl('div', { cls: 'ct-skills-card-name', text: skill.name });
      if (skill.description) {
        main.createEl('div', { cls: 'ct-skills-card-desc', text: skill.description });
      }

      card.addEventListener('click', () => {
        this.selectedLocalSkill = skill;
        this.renderList();
        this.renderDetail();
      });
    }
  }

  /** Render a list of browse skill cards into the given container. */
  private renderSkillCards(container: HTMLElement, skills: BrowseSkill[]): void {
    for (const skill of skills) {
      const isActive = this.selectedBrowse?.slug === skill.slug;
      const card = container.createEl('div', {
        cls: 'ct-skills-card' + (isActive ? ' ct-skills-card--active' : ''),
      });

      const main = card.createEl('div', { cls: 'ct-skills-card-main' });
      main.createEl('div', { cls: 'ct-skills-card-name', text: skill.name });
      if (skill.source) {
        main.createEl('div', { cls: 'ct-skills-card-desc', text: skill.source });
      }

      const meta = card.createEl('div', { cls: 'ct-skills-card-meta' });
      if (skill.installs > 0) {
        meta.createEl('span', { cls: 'ct-skills-installs', text: formatInstalls(skill.installs) });
      }
      if (skill.isInstalled) {
        meta.createEl('span', { cls: 'ct-skills-badge ct-skills-badge--installed', text: 'installed' });
      }

      card.addEventListener('click', () => {
        this.selectedBrowse = skill;
        this.renderList();
        this.renderDetail();
        void this.fetchSkillDescription(skill);
      });
    }
  }

  // ── Detail Panel ───────────────────────────────────────────────────────────

  private renderDetail(): void {
    this.detailEl.empty();
    // Single funnel for every detail pane, so the back bar and the narrow-mode
    // class only have to be applied in one place.
    this.syncPaneVisibility();
    if (this.hasActiveSelection()) this.renderDetailBackBar();

    if (this.isCreatingNewSkill) {
      this.renderNewSkill();
    } else if (this.activeTab === 'installed') {
      this.renderInstalledDetail();
    } else if (this.browseSource !== 'registry') {
      this.renderLocalDetail();
    } else {
      this.renderBrowseDetail();
    }
  }

  private renderInstalledDetail(): void {
    // If an agent is selected, show its detail
    if (this.selectedAgent) {
      this.renderAgentDetail(this.selectedAgent);
      return;
    }

    // If a child skill from a GitHub source is selected, show its read-only viewer
    if (this.selectedGithubSourceSkill) {
      this.renderGithubSourceChildDetail(this.selectedGithubSourceSkill);
      return;
    }

    // If a github source plugin header is selected, show its detail
    if (this.selectedGithubSource) {
      this.renderGithubPluginDetail(this.selectedGithubSource);
      return;
    }

    const skill = this.selectedInstalled;

    if (!skill) {
      const empty = this.detailEl.createEl('div', { cls: 'ct-skills-detail-empty' });
      const iconEl = empty.createEl('div', { cls: 'ct-skills-detail-empty-icon' });
      setIcon(iconEl, 'puzzle');
      empty.createEl('div', { text: 'Select a skill to view and edit' });
      return;
    }

    if (!skill.isEditable) {
      this.renderReadOnlySkillDetail(skill);
      return;
    }

    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: skill.name });
    if (skill.origin === 'local') header.createEl('p', { text: 'Available in new sessions.', cls: 'ct-skills-availability' });

    const pathRow = header.createEl('div', { cls: 'ct-skills-detail-path' });
    const pathText = skill.isSymlink
      ? `${skill.skillPath} → ${skill.realPath}`
      : skill.realPath;
    pathRow.createEl('span', { text: pathText, cls: 'ct-skills-detail-path-text' });

    // Toolbar lives in the header, above the editor, so the textarea below can
    // claim the rest of the pane. Built before the editor so DOM order matches
    // visual order, but `saveBtn` is wired to the textarea further down — hence
    // the forward reference through `.ct-skills-btn-save` in the input handler.
    const actions = header.createEl('div', { cls: 'ct-skills-actions ct-skills-detail-toolbar' });

    const saveBtn = actions.createEl('button', {
      cls: 'ct-skills-btn ct-skills-btn--primary ct-skills-btn-save',
      text: 'Save',
      attr: { disabled: this.isDirty ? null : 'true' },
    });
    saveBtn.disabled = !this.isDirty;

    const revealBtn = actions.createEl('button', {
      cls: 'ct-skills-btn',
      text: 'Reveal in Finder',
    });
    revealBtn.addEventListener('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { shell?: { showItemInFolder: (path: string) => void } };
      electron.shell?.showItemInFolder(skill.skillMdPath);
    });

    // Reload button (re-reads file from disk)
    const reloadBtn = actions.createEl('button', { cls: 'ct-skills-btn', text: 'Reload' });
    reloadBtn.addEventListener('click', () => void this.reloadSkillContent(skill));

    // Uninstall shares the toolbar row but is pushed to the far end, so the
    // destructive action never sits flush against Save.
    const uninstallBtn = actions.createEl('button', {
      cls: 'ct-skills-btn ct-skills-btn--danger ct-skills-btn-uninstall',
      text: 'Uninstall',
    });
    uninstallBtn.addEventListener('click', () => void this.uninstallSkill(skill));

    // Editor section
    const editorWrap = this.detailEl.createEl('div', { cls: 'ct-skills-editor-wrap' });
    const labelRow = editorWrap.createEl('div', { cls: 'ct-skills-editor-label' });
    labelRow.createEl('span', { text: 'SKILL.md' });
    if (this.isDirty) {
      labelRow.createEl('span', { cls: 'ct-skills-dirty-dot', text: '●', attr: { title: 'Unsaved changes' } });
    }

    const textarea = editorWrap.createEl('textarea', { cls: 'ct-skills-textarea' });
    textarea.value = this.editContent;
    textarea.addEventListener('input', () => {
      this.editContent = textarea.value;
      this.isDirty = this.editContent !== skill.content;
      // Patch dirty indicator without a full re-render
      const dot = this.detailEl.querySelector('.ct-skills-dirty-dot');
      if (this.isDirty && !dot) {
        const lbl = this.detailEl.querySelector('.ct-skills-editor-label');
        lbl?.createEl('span', { cls: 'ct-skills-dirty-dot', text: '●', attr: { title: 'Unsaved changes' } });
      } else if (!this.isDirty && dot) {
        dot.remove();
      }
      const btn = this.detailEl.querySelector<HTMLButtonElement>('.ct-skills-btn-save');
      if (btn) btn.disabled = !this.isDirty;
    });

    saveBtn.addEventListener('click', () => void this.saveSkillContent(skill, textarea));
  }

  /**
   * Viewer for a skill this plugin must not modify: anything in
   * `~/.claude/skills`, and any symlink whose target sits outside the vault.
   *
   * Deliberately registers NO input listener on the textarea. A `readonly`
   * textarea can still fire `input` under some IMEs and paste paths, and the
   * dirty flag it would set has no Save button to clear it — it would leak a
   * phantom "unsaved changes" dot into whatever the user selected next.
   */
  private renderReadOnlySkillDetail(skill: InstalledSkill): void {
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    const nameRow = header.createEl('div', { cls: 'ct-skills-detail-name-row' });
    nameRow.createEl('span', { cls: 'ct-skills-detail-name', text: skill.name });
    nameRow.createEl('span', { cls: 'ct-skills-badge ct-skills-badge--readonly', text: 'read-only' });

    // Keep showing "link → target": for a symlinked entry that IS the
    // explanation for why this pane is read-only.
    const pathRow = header.createEl('div', { cls: 'ct-skills-detail-path' });
    pathRow.createEl('span', {
      cls: 'ct-skills-detail-path-text',
      text: skill.isSymlink ? `${skill.skillPath} → ${skill.realPath}` : skill.realPath,
    });

    const actions = header.createEl('div', { cls: 'ct-skills-actions ct-skills-detail-toolbar' });
    const revealBtn = actions.createEl('button', { cls: 'ct-skills-btn', text: 'Reveal in Finder' });
    revealBtn.addEventListener('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { shell?: { showItemInFolder: (path: string) => void } };
      electron.shell?.showItemInFolder(skill.skillMdPath);
    });
    const reloadBtn = actions.createEl('button', { cls: 'ct-skills-btn', text: 'Reload' });
    reloadBtn.addEventListener('click', () => void this.reloadSkillContent(skill));

    const callout = this.detailEl.createEl('div', { cls: 'ct-skills-callout' });
    callout.createEl('div', {
      text: skill.origin === 'home'
        ? 'Managed by Claude Code. This plugin never writes to ~/.claude/ — edit or remove it with the `claude` CLI, or by hand.'
        : 'This skill is a link to a directory outside the vault. Editing here would write straight into that source, so it is shown read-only.',
    });
    // Leftover from the removed "Link" button: a symlink in ~/.claude/skills
    // pointing into a source that is now registered with every session
    // directly. The skill is loaded twice, and only the user can clear it.
    if (skill.origin === 'home' && skill.isSymlink && skill.sourceName) {
      callout.createEl('div', {
        text: `Legacy link into "${skill.sourceName}", which is already registered with every session. Safe to delete by hand — it only makes this skill load twice.`,
      });
    }

    const installRoot = this.plugin.getPluginSkillsRoot();
    if (installRoot) {
      callout.createEl('div', {
        cls: 'ct-skills-callout-sub',
        text: `Skills you install or import go to ${installRoot}`,
      });
    }

    const editorWrap = this.detailEl.createEl('div', { cls: 'ct-skills-editor-wrap' });
    editorWrap.createEl('div', { cls: 'ct-skills-editor-label', text: 'SKILL.md (read-only)' });
    const textarea = editorWrap.createEl('textarea', {
      cls: 'ct-skills-textarea',
      attr: { readonly: 'true' },
    });
    textarea.value = skill.content;
  }

  /**
   * Viewer for an agent profile. `~/.claude/agents/` is read-only for the same
   * reason `~/.claude/skills/` is, so this pane has no Save and no Delete.
   */
  private renderAgentDetail(agent: InstalledAgent): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');

    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    const nameRow = header.createEl('div', { cls: 'ct-skills-detail-name-row' });
    nameRow.createEl('span', { cls: 'ct-skills-detail-name', text: agent.name });
    nameRow.createEl('span', { cls: 'ct-skills-badge ct-skills-badge--readonly', text: 'read-only' });

    const pathRow = header.createEl('div', { cls: 'ct-skills-detail-path' });
    pathRow.createEl('span', { text: agent.agentPath, cls: 'ct-skills-detail-path-text' });

    const actions = header.createEl('div', { cls: 'ct-skills-actions ct-skills-detail-toolbar' });

    const reloadBtn = actions.createEl('button', { cls: 'ct-skills-btn', text: 'Reload' });
    reloadBtn.addEventListener('click', () => void this.reloadAgentContent(agent));

    const revealBtn = actions.createEl('button', {
      cls: 'ct-skills-btn',
      text: 'Reveal in Finder',
    });
    revealBtn.addEventListener('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { shell?: { showItemInFolder: (path: string) => void } };
      electron.shell?.showItemInFolder(agent.agentPath);
    });

    const callout = this.detailEl.createEl('div', { cls: 'ct-skills-callout' });
    callout.createEl('div', {
      text: 'Managed by Claude Code. This plugin never writes to ~/.claude/ — edit or delete this agent with the `claude` CLI, or by hand.',
    });

    // Editor section — read-only, and with no input listener, for the same
    // reason as renderReadOnlySkillDetail: a dirty flag with no Save button to
    // clear it would leak into the next selection.
    const editorWrap = this.detailEl.createEl('div', { cls: 'ct-skills-editor-wrap' });
    editorWrap.createEl('div', {
      cls: 'ct-skills-editor-label',
      text: `agents/${path.basename(agent.agentPath)} (read-only)`,
    });
    const textarea = editorWrap.createEl('textarea', {
      cls: 'ct-skills-textarea',
      attr: { readonly: 'true' },
    });
    textarea.value = agent.content;
  }

  private async reloadAgentContent(agent: InstalledAgent): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    try {
      const content = await fs.promises.readFile(agent.agentPath, 'utf-8');
      agent.content = content;
      this.agentEditContent = content;
      this.isAgentDirty = false;
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to reload: ${String(err)}`);
    }
  }

  private renderGithubPluginDetail(source: import('./types').SkillSource): void {
    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: source.name });

    if (source.repoUrl) {
      const urlRow = header.createEl('div', { cls: 'ct-skills-detail-path' });
      const link = urlRow.createEl('a', {
        cls: 'ct-skills-source-link',
        text: source.repoUrl,
        href: source.repoUrl,
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require('electron') as { shell?: { openExternal: (url: string) => void } };
        electron.shell?.openExternal(source.repoUrl!);
      });
    }

    if (source.lastFetched) {
      header.createEl('div', {
        cls: 'ct-skills-meta-line',
        text: `Last checked: ${new Date(source.lastFetched).toLocaleString()}`,
      });
    }

    // Staleness + actions
    const actions = this.detailEl.createEl('div', { cls: 'ct-skills-actions' });
    const hasUpdates = source.behindCount != null && source.behindCount > 0;
    if (hasUpdates) {
      actions.createEl('span', {
        cls: 'ct-skills-badge--updates',
        text: `• ${source.behindCount} update${source.behindCount! > 1 ? 's' : ''} available`,
      });
    } else if (source.behindCount === 0) {
      actions.createEl('span', { cls: 'ct-skills-meta-line', text: 'Up to date' });
    }
    const updateBtn = actions.createEl('button', {
      cls: 'ct-skills-btn' + (hasUpdates ? ' ct-skills-btn--primary' : ''),
      text: 'Update',
    });
    updateBtn.addEventListener('click', () => void this.updateGithubSource(source));
    const reloadBtn = actions.createEl('button', { cls: 'ct-skills-btn', text: 'Reload' });
    reloadBtn.addEventListener('click', () => void this.reloadGithubSource(source));

    // Skills list
    const skillsSection = this.detailEl.createEl('div', { cls: 'ct-skills-desc-section' });
    skillsSection.createEl('div', { cls: 'ct-skills-section-label', text: 'Skills' });

    if (this.githubSourceSkillsLoadingSet.has(source.id)) {
      const loading = skillsSection.createEl('div', { cls: 'ct-skills-desc-loading' });
      loading.createEl('span', { cls: 'ct-skills-spinner' });
      loading.createEl('span', { text: ' Loading…' });
    } else if ((this.githubSourceSkillsMap.get(source.id) ?? []).length === 0) {
      skillsSection.createEl('div', { cls: 'ct-skills-empty', text: 'No skills found' });
    } else {
      const list = skillsSection.createEl('div', { cls: 'ct-skills-plugin-skill-list' });
      for (const skill of this.githubSourceSkillsMap.get(source.id) ?? []) {
        const row = list.createEl('div', { cls: 'ct-skills-plugin-skill-row' });
        row.createEl('span', { cls: 'ct-skills-plugin-skill-name', text: skill.name });
        if (skill.description) {
          row.createEl('span', { cls: 'ct-skills-plugin-skill-desc', text: skill.description });
        }
      }
    }

    // Remove / Reinstall
    const footer = this.detailEl.createEl('div', { cls: 'ct-skills-browse-footer' });
    const reinstallBtn = footer.createEl('button', { cls: 'ct-skills-btn ct-skills-btn--danger', text: 'Reinstall' });
    reinstallBtn.addEventListener('click', () => {
      new ConfirmModal(
        this.app,
        `Reinstall "${source.name}"? This will delete and re-clone the repository.`,
        'Reinstall',
        (confirmed) => { if (confirmed) void this.reinstallGithubSource(source); },
      ).open();
    });
    const removeBtn = footer.createEl('button', { cls: 'ct-skills-btn ct-skills-btn--danger', text: 'Remove Source' });
    removeBtn.addEventListener('click', () => {
      new ConfirmModal(
        this.app,
        `Remove "${source.name}"? This will delete the local clone and unregister it from Claude Code.`,
        'Remove',
        (confirmed) => { if (confirmed) void this.doRemoveGithubSource(source); },
      ).open();
    });
  }

  private renderGithubSourceChildDetail(item: { skill: LocalSkill; source: import('./types').SkillSource }): void {
    const { skill, source } = item;

    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: skill.name });
    header.createEl('div', { cls: 'ct-skills-detail-path', text: `From ${source.name}` });
    if (skill.description) {
      header.createEl('div', { cls: 'ct-skills-meta-line', text: skill.description });
    }

    // Read skill content
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const skillMdPath = path.join(skill.skillDir, 'SKILL.md');
    let content = '';
    try { content = fs.readFileSync(skillMdPath, 'utf-8'); } catch { content = '(Could not read SKILL.md)'; }

    const actions = header.createEl('div', { cls: 'ct-skills-actions ct-skills-detail-toolbar' });
    const revealBtn = actions.createEl('button', { cls: 'ct-skills-btn', text: 'Reveal in Finder' });
    revealBtn.addEventListener('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { shell?: { showItemInFolder: (p: string) => void } };
      electron.shell?.showItemInFolder(skillMdPath);
    });

    const editorWrap = this.detailEl.createEl('div', { cls: 'ct-skills-editor-wrap' });
    editorWrap.createEl('div', { cls: 'ct-skills-editor-label', text: 'SKILL.md (read-only)' });
    const editor = editorWrap.createEl('textarea', {
      cls: 'ct-skills-textarea',
      attr: { readonly: 'true' },
    });
    editor.value = content;
  }

  private async loadGithubSourceSkillsForInstalled(source: import('./types').SkillSource): Promise<void> {
    if (!source.clonePath) return;
    this.githubSourceSkillsLoadingSet.add(source.id);
    this.renderList();
    if (this.selectedGithubSource?.id === source.id) this.renderDetail();

    const { getSkillsDirForSource } = await import('./claudeSettings');
    const skillsDir = getSkillsDirForSource(source.clonePath);
    const sourceSkills = await listGithubSourceSkills(source);
    const skills: LocalSkill[] = sourceSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      skillsPath: skillsDir,
      skillDir: s.skillDir,
      isGithubSource: true,
    }));

    this.githubSourceSkillsMap.set(source.id, skills);
    this.githubSourceSkillsLoadingSet.delete(source.id);
    this.renderList();
    if (this.selectedGithubSource?.id === source.id) this.renderDetail();
  }

  private async doRemoveGithubSource(source: import('./types').SkillSource): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');

    if (source.clonePath) {
      try { fs.rmSync(source.clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    this.plugin.settings.skillSources = this.plugin.settings.skillSources.filter(s => s.id !== source.id);
    await this.plugin.saveSettings();
    this.selectedGithubSource = null;
    this.selectedGithubSourceSkill = null;
    this.githubSourceSkillsMap.delete(source.id);
    this.githubSourceSkillsLoadingSet.delete(source.id);
    new Notice(`Removed ${source.name}`);
    await this.loadInstalledSkills();
    this.renderList();
    this.renderDetail();
  }

  private renderBrowseDetail(): void {
    const skill = this.selectedBrowse;

    if (!skill) {
      const empty = this.detailEl.createEl('div', { cls: 'ct-skills-detail-empty' });
      const iconEl = empty.createEl('div', { cls: 'ct-skills-detail-empty-icon' });
      setIcon(iconEl, 'globe');
      empty.createEl('div', { text: 'Search and select a skill to install' });
      return;
    }

    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: skill.name });

    if (skill.source) {
      const sourceEl = header.createEl('div', { cls: 'ct-skills-detail-path' });
      const link = sourceEl.createEl('a', {
        cls: 'ct-skills-source-link',
        text: skill.source,
        href: `https://github.com/${skill.source}`,
        attr: { target: '_blank' },
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require('electron') as { shell?: { openExternal: (url: string) => void } };
        electron.shell?.openExternal(`https://github.com/${skill.source}`);
      });
    }

    if (skill.installs > 0) {
      header.createEl('div', {
        cls: 'ct-skills-meta-line',
        text: formatInstalls(skill.installs),
      });
    }

    // Description / SKILL.md preview
    const descSection = this.detailEl.createEl('div', { cls: 'ct-skills-desc-section' });
    if (this.browseDescLoading.has(skill.slug)) {
      const loading = descSection.createEl('div', { cls: 'ct-skills-desc-loading' });
      loading.createEl('span', { cls: 'ct-skills-spinner' });
      loading.createEl('span', { text: ' Loading description…' });
    } else if (this.browseDescriptions.has(skill.slug)) {
      const descText = this.browseDescriptions.get(skill.slug);
      if (descText) {
        descSection.createEl('p', { cls: 'ct-skills-desc-text', text: descText });
      }
    }

    // Install area
    const installArea = this.detailEl.createEl('div', { cls: 'ct-skills-install-area' });

    if (skill.isInstalled) {
      const badge = installArea.createEl('div', { cls: 'ct-skills-installed-badge' });
      const iconEl = badge.createEl('span', { cls: 'ct-skills-installed-icon' });
      setIcon(iconEl, 'check-circle');
      badge.createEl('span', { text: 'Already installed' });
    } else if (this.installingSlug === skill.slug) {
      const progress = installArea.createEl('div', { cls: 'ct-skills-install-progress' });
      progress.createEl('span', { cls: 'ct-skills-spinner' });
      progress.createEl('span', { text: ' Installing…' });
      if (this.installOutput) {
        installArea.createEl('pre', { cls: 'ct-skills-install-output', text: this.installOutput });
      }
    } else {
      const installBtn = installArea.createEl('button', {
        cls: 'ct-skills-btn ct-skills-btn--primary',
        text: 'Install',
      });
      installBtn.addEventListener('click', () => void this.installSkill(skill));
    }

    // skills.sh link
    const footer = this.detailEl.createEl('div', { cls: 'ct-skills-browse-footer' });
    const viewLink = footer.createEl('a', {
      cls: 'ct-skills-link',
      text: `View on skills.sh ↗`,
      href: `https://skills.sh/${skill.slug}`,
    });
    viewLink.addEventListener('click', (e) => {
      e.preventDefault();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { shell?: { openExternal: (url: string) => void } };
      electron.shell?.openExternal(`https://skills.sh/${skill.slug}`);
    });
  }

  // ── Local Source Detail ────────────────────────────────────────────────────

  private renderLocalDetail(): void {
    const skill = this.selectedLocalSkill;

    if (!skill) {
      const empty = this.detailEl.createEl('div', { cls: 'ct-skills-detail-empty' });
      const iconEl = empty.createEl('div', { cls: 'ct-skills-detail-empty-icon' });
      setIcon(iconEl, 'folder-open');
      empty.createEl('div', { text: 'Select a skill to view' });
      return;
    }

    // Find the source so we can check for repoPath
    const sources = this.plugin.settings.skillSources ?? [];
    const source = sources.find((s) => s.id === this.browseSource) ?? null;

    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: skill.name });
    const pathRow = header.createEl('div', { cls: 'ct-skills-detail-path' });
    pathRow.createEl('span', { text: skill.skillDir, cls: 'ct-skills-detail-path-text' });

    // Description
    if (skill.description) {
      const descSection = this.detailEl.createEl('div', { cls: 'ct-skills-desc-section' });
      descSection.createEl('p', { cls: 'ct-skills-desc-text', text: skill.description });
    }

    // Availability. There is nothing to install: configured sources are
    // registered with each session by path, so every skill they provide is
    // already loaded. The old "Link" button symlinked into ~/.claude/skills,
    // which this plugin no longer writes to.
    const installArea = this.detailEl.createEl('div', { cls: 'ct-skills-install-area' });
    const badge = installArea.createEl('div', { cls: 'ct-skills-installed-badge' });
    const iconEl = badge.createEl('span', { cls: 'ct-skills-installed-icon' });
    setIcon(iconEl, 'check-circle');
    badge.createEl('span', { text: 'Available through this source — no install needed' });

    // Pull Updates button (local sources only, if source has repoPath)
    if (source?.repoPath) {
      const actions = this.detailEl.createEl('div', { cls: 'ct-skills-actions' });
      const pullBtn = actions.createEl('button', {
        cls: 'ct-skills-btn',
        text: 'Pull Updates',
      });
      pullBtn.addEventListener('click', () => this.pullSourceUpdates(source));
    }
  }

  private async updateGithubSource(source: import('./types').SkillSource): Promise<void> {
    if (!source.clonePath) return;
    try {
      const { behindCount, lastFetched } = await pullGithubSourceUpdates(source);
      source.behindCount = behindCount;
      source.lastFetched = lastFetched;
      await this.plugin.saveSettings();
      new Notice(`Updated ${source.name}`);
      this.githubSourceSkillsMap.delete(source.id);
      void this.loadGithubSourceSkillsForInstalled(source);
      await this.loadInstalledSkills(); // refresh individual skills list too
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Update failed: ${msg}`);
    }
  }

  private async reloadGithubSource(source: import('./types').SkillSource): Promise<void> {
    this.githubSourceSkillsMap.delete(source.id);
    this.githubSourceSkillsLoadingSet.add(source.id);
    this.renderDetail();
    await this.loadGithubSourceSkillsForInstalled(source);
    new Notice(`Reloaded ${source.name}`);
  }

  private async reinstallGithubSource(source: import('./types').SkillSource): Promise<void> {
    if (!source.clonePath || !source.repoUrl) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');

    try {
      // Remove existing clone
      fs.rmSync(source.clonePath, { recursive: true, force: true });
      // Re-clone via the shared helper
      await cloneGithubSource(source.repoUrl, source.clonePath);
      // Reset staleness state
      source.behindCount = 0;
      source.lastFetched = Date.now();
      await this.plugin.saveSettings();
      new Notice(`Reinstalled ${source.name}`);
      // Reload skills from fresh clone
      this.githubSourceSkillsMap.delete(source.id);
      void this.loadGithubSourceSkillsForInstalled(source);
      await this.loadInstalledSkills();
      this.renderList();
    } catch (err) {
      new Notice(`Reinstall failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private pullSourceUpdates(source: import('./types').SkillSource): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    const expandedRepoPath = (source.repoPath ?? '').replace(/^~/, os.homedir());
    try {
      const output = execSync(`git -C "${expandedRepoPath}" pull`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
      const stdout = output.toString().trim();
      new Notice(`Pull succeeded: ${stdout.slice(0, 100)}`);
      // Reload local skill list to reflect any new/removed skills
      void this.loadLocalSkills(source.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Pull failed: ${msg}`);
    }
  }

  /** Scan a local source directory for skills containing SKILL.md. */
  private async loadLocalSkills(sourceId: string): Promise<void> {
    const sources = this.plugin.settings.skillSources ?? [];
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    this.isLocalSkillsLoading = true;
    this.renderList();

    let skillsDir: string;
    let isGithubSource = false;

    if (source.type === 'github' && source.clonePath) {
      isGithubSource = true;
      const { getSkillsDirForSource } = await import('./claudeSettings');
      skillsDir = getSkillsDirForSource(source.clonePath);
    } else {
      // local type
      const rawPath = source.skillsPath ?? '';
      skillsDir = rawPath.replace(/^~/, os.homedir());
    }

    const skills: LocalSkill[] = [];

    try {
      const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillDir = path.join(skillsDir, entry.name);

        // Check if SKILL.md exists
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        try {
          await fs.promises.access(skillMdPath);
        } catch {
          continue; // no SKILL.md, skip
        }

        let content = '';
        try {
          content = await fs.promises.readFile(skillMdPath, 'utf-8');
        } catch { /* keep empty */ }

        const { name, description } = parseFrontmatter(content);

        skills.push({
          id: entry.name,
          name: name || entry.name,
          description,
          skillsPath: skillsDir,
          skillDir,
          isGithubSource,
        });
      }
    } catch (err) {
      console.warn('[ClaudeThreads] Could not load local skills:', err);
    }

    this.localSkills = skills.sort((a, b) => a.name.localeCompare(b.name));
    this.isLocalSkillsLoading = false;

    // Keep selection in sync
    if (this.selectedLocalSkill) {
      const refreshed = this.localSkills.find((s) => s.id === this.selectedLocalSkill!.id);
      this.selectedLocalSkill = refreshed ?? null;
    }

    this.renderList();
    this.renderDetail();
  }

  // ── Skill Description Fetch ───────────────────────────────────────────────

  /** Fetch the description from SKILL.md for a browse skill, caching the result. */
  private async fetchSkillDescription(skill: BrowseSkill): Promise<void> {
    if (this.browseDescriptions.has(skill.slug) || this.browseDescLoading.has(skill.slug)) {
      return;
    }
    if (!skill.source) {
      this.browseDescriptions.set(skill.slug, null);
      return;
    }

    this.browseDescLoading.add(skill.slug);
    if (this.selectedBrowse?.slug === skill.slug) this.renderDetail();

    const description = await getMarketplaceSkillDescription(skill.slug, skill.source);

    this.browseDescLoading.delete(skill.slug);
    this.browseDescriptions.set(skill.slug, description);
    if (this.selectedBrowse?.slug === skill.slug) this.renderDetail();
  }

  // ── Data Loading ──────────────────────────────────────────────────────────

  async loadInstalledSkills(): Promise<void> {
    const skillSources = this.plugin.settings.skillSources ?? [];
    this.installedSkills = await listInstalledSkills(skillSources, this.plugin.getManagedSkillRoots?.());

    // Keep selected skill in sync after reload. Matched on skillPath, not name:
    // a vault skill can legitimately shadow a same-named home skill, and
    // matching by name would silently swap the selection between the two.
    if (this.selectedInstalled) {
      const refreshed = this.installedSkills.find((s) => s.skillPath === this.selectedInstalled!.skillPath);
      if (refreshed) {
        this.selectedInstalled = refreshed;
        if (!this.isDirty) this.editContent = refreshed.content;
      } else {
        this.selectedInstalled = null;
      }
    }

    this.renderList();
    this.renderDetail();
  }

  async loadInstalledAgents(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    const agentsDir = path.join(os.homedir(), '.claude', 'agents');
    const agents: InstalledAgent[] = [];

    try {
      const entries = await fs.promises.readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.endsWith('.md')) continue;
        const agentPath = path.join(agentsDir, entry.name);
        let content = '';
        try { content = await fs.promises.readFile(agentPath, 'utf-8'); } catch { /* skip */ }
        const { name, description } = parseFrontmatter(content);
        agents.push({
          name: name || entry.name.replace(/\.md$/, ''),
          description,
          agentPath,
          content,
        });
      }
    } catch {
      // agents dir may not exist — ignore
    }

    this.installedAgents = agents.sort((a, b) => a.name.localeCompare(b.name));

    // Keep selection in sync after reload
    if (this.selectedAgent) {
      const refreshed = this.installedAgents.find(a => a.name === this.selectedAgent!.name);
      if (refreshed) {
        this.selectedAgent = refreshed;
        if (!this.isAgentDirty) this.agentEditContent = refreshed.content;
      } else {
        this.selectedAgent = null;
      }
    }
  }

  private async fetchBrowseResults(): Promise<void> {
    if (!this.browseQuery || this.browseQuery.length < 2) {
      this.browseResults = [];
      this.isBrowseLoading = false;
      this.renderList();
      return;
    }

    try {
      this.browseResults = await searchMarketplaceSkills(this.browseQuery, 15, this.installedSkills);
    } catch (err) {
      console.error('[ClaudeThreads] Skills search error:', err);
      this.browseResults = [];
    } finally {
      this.isBrowseLoading = false;
      this.renderList();
    }
  }

  /** Fetch a popular-skills list shown when the Browse tab opens with no query. */
  private async fetchPopularSkills(): Promise<void> {
    this.isPopularLoading = true;
    this.renderList();

    try {
      this.browsePopularResults = await getPopularMarketplaceSkills(this.installedSkills, 30);
    } catch (err) {
      console.error('[ClaudeThreads] Skills popular fetch error:', err);
      this.browsePopularResults = [];
    } finally {
      this.isPopularLoading = false;
      this.renderList();
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Entry point for the "New skill" button. Flips the detail pane into the
   * authoring form via state, so `renderDetail()` stays the only thing that
   * writes to `detailEl` — which is what keeps the back bar and the
   * narrow-mode pane swap working for this view too.
   */
  private startNewSkill(): void {
    if (this.isDirty || this.isAgentDirty) { new Notice('Save or reload your edits before creating a skill.'); return; }
    this.isCreatingNewSkill = true;
    this.selectedInstalled = null;
    this.selectedAgent = null;
    this.selectedGithubSource = null;
    this.selectedGithubSourceSkill = null;
    this.renderList();
    this.renderDetail();
  }

  private renderNewSkill(): void {
    this.detailEl.createEl('h3', { text: 'New local skill' });
    this.detailEl.createEl('p', { text: `Create in ${this.plugin.getLocalSkillsRoot()}. Available in new sessions.`, cls: 'ct-skills-availability' });
    const input = this.detailEl.createEl('input', { type: 'text', placeholder: 'meeting-notes', attr: { 'aria-label': 'Skill identifier' } });
    const errorEl = this.detailEl.createEl('p', { attr: { role: 'alert' } });
    const create = this.detailEl.createEl('button', { text: 'Create skill', cls: 'ct-skills-btn ct-skills-btn--primary ct-skills-author-btn' });
    create.addEventListener('click', async () => {
      const skillId = input.value.trim();
      const content = `---\nname: ${skillId}\ndescription: Describe when to use this skill.\n---\n\n# ${skillId}\n\nWrite the instructions for this skill here.\n`;
      create.disabled = true;
      try {
        const result = await this.plugin.createLocalSkill({ skillId, skillMd: content });
        const skill: InstalledSkill = {
          name: skillId, identifier: `local:${skillId}`, description: 'Describe when to use this skill.',
          skillPath: result.path, realPath: result.path, skillMdPath: `${result.path}/SKILL.md`,
          isSymlink: false, isDirectory: true, content, origin: 'local', isEditable: true, isRemovable: true,
        };
        this.installedSkills.push(skill);
        this.isCreatingNewSkill = false;
        this.selectedInstalled = skill;
        this.selectedAgent = null;
        this.selectedGithubSource = null;
        this.selectedGithubSourceSkill = null;
        this.editContent = content;
        this.isDirty = false;
        this.expandedSources.add('authored');
        this.renderList();
        this.renderDetail();
      } catch (error) { errorEl.setText(String(error)); create.disabled = false; }
    });
    input.focus();
  }

  private async saveSkillContent(skill: InstalledSkill, textarea: HTMLTextAreaElement): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // Belt and braces: renderInstalledDetail already routes non-editable skills
    // to a pane with no Save button, but this is the function that used to
    // write through a symlink into a user's git repo with no warning.
    if (!canEditSkill(skill)) {
      new Notice(`"${skill.name}" is read-only — this plugin does not write outside the vault skills folder.`);
      return;
    }
    try {
      if (skill.origin === 'local') {
        await this.plugin.updateLocalSkill({ skillId: skill.skillPath.split(/[\\/]/).pop()!, files: [{ path: 'SKILL.md', encoding: 'utf8', content: this.editContent }] });
      } else await fs.promises.writeFile(skill.skillMdPath, this.editContent, 'utf-8');
      skill.content = this.editContent;
      this.isDirty = false;
      new Notice(`Saved ${skill.name}`);
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to save: ${String(err)}`);
    }
  }

  private async reloadSkillContent(skill: InstalledSkill): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    try {
      const content = await fs.promises.readFile(skill.skillMdPath, 'utf-8');
      skill.content = content;
      this.editContent = content;
      this.isDirty = false;
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to reload: ${String(err)}`);
    }
  }

  private uninstallSkill(skill: InstalledSkill): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathNode = require('path') as typeof import('path');
    new ConfirmModal(
      this.app,
      `Remove "${skill.name}" from ${pathNode.dirname(skill.skillPath)}/? This cannot be undone.`,
      'Uninstall',
      (confirmed) => {
        if (confirmed) void this.doUninstall(skill);
      },
    ).open();
  }

  private async doUninstall(skill: InstalledSkill): Promise<void> {
    try {
      await uninstallSkillByPath(skill.skillPath, this.plugin.getManagedSkillRoots?.());
      new Notice(`Uninstalled ${skill.name}`);
      this.installedSkills = this.installedSkills.filter((s) => s.skillPath !== skill.skillPath);
      if (this.selectedInstalled?.skillPath === skill.skillPath) {
        this.selectedInstalled = null;
        this.editContent = '';
        this.isDirty = false;
      }
      this.renderList();
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to uninstall: ${String(err)}`);
    }
  }

  private async installSkill(skill: BrowseSkill): Promise<void> {
    if (!skill.source) {
      new Notice('No GitHub source available for this skill');
      return;
    }
    const installRoot = this.plugin.getPluginSkillsRoot();
    if (!installRoot) {
      new Notice(SkillsManagerView.NO_INSTALL_ROOT_MESSAGE);
      return;
    }

    this.installingSlug = skill.slug;
    this.installOutput = '';
    this.renderDetail();

    try {
      await installSkillFromMarketplace(
        { slug: skill.slug, skillId: skill.skillId, name: skill.name, source: skill.source },
        {
          installRoot,
          onProgress: (message: string) => {
            this.installOutput = message;
            this.renderDetail();
          },
        },
      );

      new Notice(`Installed ${skill.name}`);

      // Update browse state
      const inResults = this.browseResults.find((s) => s.slug === skill.slug);
      if (inResults) inResults.isInstalled = true;
      const inPopular = this.browsePopularResults.find((s) => s.slug === skill.slug);
      if (inPopular) inPopular.isInstalled = true;
      this.selectedBrowse = { ...skill, isInstalled: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Install failed: ${msg}`);
      console.error('[ClaudeThreads] Skill install failed:', err);
    } finally {
      this.installingSlug = null;
      this.installOutput = '';
      this.renderDetail();
      this.renderList(); // refresh installed count badge

      // Reload installed list in the background
      void this.loadInstalledSkills();
    }
  }

  /**
   * Import a skill from a folder already on disk (picked via the folder input).
   * No tmpdir/extraction needed — `importSkillFromPath` locates and copies
   * directly from `folderPath`. Follows the same Notice/reload/re-render
   * pattern as `installSkill`.
   */
  private async importSkillFromFolder(folderPath: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');

    const skillsDir = this.plugin.getPluginSkillsRoot();
    if (!skillsDir) {
      new Notice(SkillsManagerView.NO_INSTALL_ROOT_MESSAGE);
      return;
    }

    try {
      const { name } = await importSkillFromPath(folderPath, skillsDir, fs, path);
      new Notice(`Imported ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Import failed: ${msg}`);
      console.error('[ClaudeThreads] Skill folder import failed:', err);
    } finally {
      void this.loadInstalledSkills();
      this.renderList();
    }
  }

  /**
   * Import a skill from a packaged `.skill`/`.zip` archive (picked via the file
   * input). Extracts to a tmpdir with `extractZipToDir`, then reuses the same
   * `importSkillFromPath` core as the folder import. Follows the same
   * tmpdir-cleanup/Notice/reload pattern as `installSkill`.
   */
  private async importSkillFromFile(filePath: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    const skillsDir = this.plugin.getPluginSkillsRoot();
    if (!skillsDir) {
      new Notice(SkillsManagerView.NO_INSTALL_ROOT_MESSAGE);
      return;
    }
    const tmpDir = path.join(os.tmpdir(), `ct-skill-${Date.now()}`);

    try {
      await extractZipToDir(filePath, tmpDir);
      const { name } = await importSkillFromPath(tmpDir, skillsDir, fs, path);
      new Notice(`Imported ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Import failed: ${msg}`);
      console.error('[ClaudeThreads] Skill file import failed:', err);
    } finally {
      // Clean up temp dir (best-effort)
      try {
        if (fs.existsSync(tmpDir)) {
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
      } catch { /* ignore */ }

      void this.loadInstalledSkills();
      this.renderList();
    }
  }

}
