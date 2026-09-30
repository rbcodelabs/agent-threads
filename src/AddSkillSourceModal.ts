import { App, Modal } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { SkillSource } from './types';

export type AddSkillSourceType = 'github' | 'local';

/** Modal for adding a new skill source (GitHub or local path). */
export class AddSkillSourceModal extends Modal {
  private sourceType: AddSkillSourceType;
  private contentEl2!: HTMLElement; // content area below type toggle

  constructor(
    app: App,
    private plugin: ClaudeThreadsPlugin,
    private onAdded: (source: SkillSource) => void,
    initialType: AddSkillSourceType = 'github',
  ) {
    super(app);
    this.sourceType = initialType;
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

      // Required lazily (not imported at the top of this file) because
      // skillManager pulls in Node built-ins, and SettingsTab loads on mobile too.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { parseGithubRepoUrl, addGithubSkillSource } = require('./skillManager') as typeof import('./skillManager');

      const repoUrl = parseGithubRepoUrl(rawUrl);
      if (!repoUrl) { showError('Please enter a valid GitHub repo URL (e.g. https://github.com/owner/repo).'); return; }

      // Clones live inside the vault's plugin folder, never the home directory.
      const cloneBase = this.plugin.getSkillSourceCloneBase();
      if (!cloneBase) {
        showError('Cannot resolve the vault folder on this platform, so there is nowhere to clone to. Skill sources need a desktop vault on a real filesystem.');
        return;
      }

      addBtn.setAttribute('disabled', 'true');
      showProgress('Cloning repository…');

      try {
        // Shared with Chief of Staff onboarding: clones non-interactively,
        // removes a partial clone on failure, and names the source from
        // plugin.json. A hand-added source keeps its random id.
        const source: SkillSource = await addGithubSkillSource({
          repoUrl,
          cloneBase,
          displayName: nameInput.value,
          id: crypto.randomUUID(),
        });
        this.plugin.settings.skillSources.push(source);
        await this.plugin.saveSettings();
        this.close();
        this.onAdded(source);
      } catch (err) {
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
      this.onAdded(source);
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
