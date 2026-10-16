import { ProjectPicker } from './ProjectPicker';
import { computeProjectLastUsed, normalizeProjectSort } from './projectPickerLogic';
import type { PluginSettings, Project, Thread } from './types';

/** The slice of the plugin the Project picker needs (kept narrow so it is trivially fakeable in tests). */
export interface ProjectPickerHost {
  manager: {
    getProjects(): Project[];
    getThreads(): Thread[];
  };
  settings: Pick<PluginSettings, 'projectPickerSort' | 'projectLastUsed'>;
  saveSettings(): Promise<void>;
  openNewProjectSettings(): void;
}

export interface OpenProjectPickerOptions {
  anchor: HTMLElement;
  /** Selected project id, or null for "No Project". */
  selectedId: string | null;
  /** Called with a project id, or null for "No Project". */
  onSelect: (projectId: string | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
}

/**
 * Opens the shared searchable Project picker wired to plugin state: the sort
 * choice persists in settings, and choosing a project stamps it as recently
 * used (so the 'recent' order reflects picks even before a thread is created).
 */
export function openProjectPicker(host: ProjectPickerHost, options: OpenProjectPickerOptions): ProjectPicker {
  const picker = new ProjectPicker({
    anchor: options.anchor,
    selectedId: options.selectedId,
    allowNone: options.allowNone,
    noneLabel: options.noneLabel,
    sort: normalizeProjectSort(host.settings.projectPickerSort),
    getProjects: () => host.manager.getProjects(),
    getLastUsed: () => computeProjectLastUsed(host.manager.getThreads(), host.settings.projectLastUsed),
    onSortChange: (mode) => {
      host.settings.projectPickerSort = mode;
      void host.saveSettings();
    },
    onSelect: (projectId) => {
      if (projectId) {
        host.settings.projectLastUsed = { ...(host.settings.projectLastUsed ?? {}), [projectId]: Date.now() };
        void host.saveSettings();
      }
      options.onSelect(projectId);
    },
    onNewProject: () => host.openNewProjectSettings(),
  });
  picker.open();
  return picker;
}
