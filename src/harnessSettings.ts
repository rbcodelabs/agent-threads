/**
 * Pure per-harness settings resolution, migration, and model-catalog helpers.
 *
 * Intentionally free of Obsidian and Node.js built-in imports so this module is
 * safe in the Obsidian Mobile eager bundle (`SettingsTab.ts`, `main.ts`) AND in
 * the headless daemon / core closure (`ThreadManager.ts`, `tsconfig.core.json`).
 */
import { CLAUDE_FAMILY_ALIASES, parseClaudeModelId } from './modelOptions';
import type { AgentHarness, PluginSettings, Thread } from './types';

export interface CachedHarnessModel {
  value: string;
  displayName: string;
  description?: string;
  resolvedModel?: string;
}

const CLAUDE_ALIAS_SET: ReadonlySet<string> = new Set(CLAUDE_FAMILY_ALIASES.map((a) => a.value));

/** True when `model` is a Claude family alias or a recognized Claude model ID. */
export function isLikelyClaudeModel(model: string | undefined): boolean {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return false;
  if (CLAUDE_ALIAS_SET.has(trimmed.toLowerCase())) return true;
  return parseClaudeModelId(trimmed) !== undefined;
}

/**
 * Idempotently migrates legacy single-string `settings.defaultModel` into
 * `settings.defaultModelByHarness` while keeping `settings.defaultModel` in sync
 * with Claude's default model for backwards compatibility.
 *
 * Also rescues a non-Claude model ID written to `settings.defaultModel` when the
 * user previously switched `agentHarness` in the old single-dropdown UI.
 */
export function migrateHarnessSettings(
  settings: Pick<PluginSettings, 'agentHarness' | 'defaultModel' | 'defaultModelByHarness'>,
): boolean {
  let changed = false;
  const legacyModel = (settings.defaultModel ?? '').trim();
  const activeHarness: AgentHarness = settings.agentHarness ?? 'claude';

  if (legacyModel && settings.defaultModelByHarness?.claude === undefined) {
    if (
      activeHarness !== 'claude'
      && !isLikelyClaudeModel(legacyModel)
      && !settings.defaultModelByHarness?.[activeHarness]
    ) {
      settings.defaultModelByHarness = {
        ...(settings.defaultModelByHarness ?? {}),
        [activeHarness]: legacyModel,
      };
      settings.defaultModel = '';
      changed = true;
    } else {
      settings.defaultModelByHarness = {
        ...(settings.defaultModelByHarness ?? {}),
        claude: legacyModel,
      };
      changed = true;
    }
  }

  if (settings.defaultModelByHarness?.claude !== undefined) {
    const claudeModel = settings.defaultModelByHarness.claude.trim();
    if (!claudeModel) {
      const next = { ...settings.defaultModelByHarness };
      delete next.claude;
      settings.defaultModelByHarness = next;
      changed = true;
    }
    if ((settings.defaultModel ?? '') !== claudeModel) {
      settings.defaultModel = claudeModel;
      changed = true;
    }
  }

  return changed;
}

/**
 * Resolves the configured default model for `harness`, or `undefined` when that
 * harness should use its own CLI default.
 */
export function resolveHarnessDefaultModel(
  settings: Pick<PluginSettings, 'defaultModel' | 'defaultModelByHarness'> | undefined,
  harness: AgentHarness | undefined,
): string | undefined {
  if (!settings) return undefined;
  const h: AgentHarness = harness ?? 'claude';
  if (settings.defaultModelByHarness && Object.prototype.hasOwnProperty.call(settings.defaultModelByHarness, h)) {
    const configured = settings.defaultModelByHarness[h]?.trim();
    return configured || undefined;
  }
  if (h === 'claude') {
    const legacy = settings.defaultModel?.trim();
    return legacy || undefined;
  }
  return undefined;
}

/**
 * Updates the default model for `harness`. Empty/undefined restores CLI default.
 * Mirrors Claude's choice onto `settings.defaultModel` so legacy callers stay aligned.
 */
export function setHarnessDefaultModel(
  settings: Pick<PluginSettings, 'defaultModel' | 'defaultModelByHarness'>,
  harness: AgentHarness,
  value: string | undefined,
): void {
  const trimmed = (value ?? '').trim();
  const next: Partial<Record<AgentHarness, string>> = { ...(settings.defaultModelByHarness ?? {}) };
  if (trimmed) next[harness] = trimmed;
  else delete next[harness];
  settings.defaultModelByHarness = next;
  if (harness === 'claude') {
    settings.defaultModel = trimmed;
  }
}

/** Returns the explicit permission-mode override configured for `harness`, or `undefined` when inheriting global. */
export function resolveHarnessPermissionModeOverride(
  settings: Pick<PluginSettings, 'permissionModeByHarness'> | undefined,
  harness: AgentHarness | undefined,
): PluginSettings['permissionMode'] | undefined {
  if (!settings?.permissionModeByHarness) return undefined;
  return settings.permissionModeByHarness[harness ?? 'claude'];
}

/** Sets or clears (`undefined`) the permission-mode override for `harness`. */
export function setHarnessPermissionModeOverride(
  settings: Pick<PluginSettings, 'permissionModeByHarness'>,
  harness: AgentHarness,
  mode: PluginSettings['permissionMode'] | undefined,
): void {
  const next: Partial<Record<AgentHarness, PluginSettings['permissionMode']>> = {
    ...(settings.permissionModeByHarness ?? {}),
  };
  if (mode) next[harness] = mode;
  else delete next[harness];
  settings.permissionModeByHarness = next;
}

/**
 * Resolves the default permission mode for a harness (before any per-thread override):
 * `permissionModeByHarness[harness] ?? settings.permissionMode ?? 'acceptEdits'`.
 */
export function resolveDefaultPermissionMode(
  settings: Pick<PluginSettings, 'permissionMode' | 'permissionModeByHarness'> | undefined,
  harness: AgentHarness | undefined,
): PluginSettings['permissionMode'] {
  const override = resolveHarnessPermissionModeOverride(settings, harness);
  return override ?? settings?.permissionMode ?? 'acceptEdits';
}

/**
 * Resolves the effective permission mode for a thread:
 * `thread.permissionMode ?? permissionModeByHarness[harness] ?? settings.permissionMode`.
 */
export function resolveEffectivePermissionMode(
  settings: Pick<PluginSettings, 'permissionMode' | 'permissionModeByHarness'> | undefined,
  thread: Pick<Thread, 'permissionMode' | 'agentHarness'> | null | undefined,
): PluginSettings['permissionMode'] {
  if (thread?.permissionMode) return thread.permissionMode;
  return resolveDefaultPermissionMode(settings, thread?.agentHarness);
}

/** Sanitizes and deduplicates raw model entries by `value`. */
export function normalizeCatalogEntries(
  models: ReadonlyArray<{ value?: unknown; displayName?: unknown; description?: unknown; resolvedModel?: unknown }> | undefined,
): CachedHarnessModel[] {
  if (!Array.isArray(models)) return [];
  const out: CachedHarnessModel[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const value = typeof raw.value === 'string' ? raw.value.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const displayName = typeof raw.displayName === 'string' && raw.displayName.trim()
      ? raw.displayName.trim()
      : value;
    const description = typeof raw.description === 'string' && raw.description.trim()
      ? raw.description.trim()
      : undefined;
    const resolvedModel = typeof raw.resolvedModel === 'string' && raw.resolvedModel.trim()
      ? raw.resolvedModel.trim()
      : undefined;
    out.push({
      value,
      displayName,
      ...(description !== undefined ? { description } : {}),
      ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    });
  }
  return out;
}

function catalogsEqual(a: readonly CachedHarnessModel[], b: readonly CachedHarnessModel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].value !== b[i].value
      || a[i].displayName !== b[i].displayName
      || (a[i].description ?? '') !== (b[i].description ?? '')
      || (a[i].resolvedModel ?? '') !== (b[i].resolvedModel ?? '')
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Applies discovered models to an existing catalog (`'replace'` on explicit refresh,
 * `'merge'` on passive session discovery) and reports whether anything changed.
 */
export function updateCatalogEntries(
  existing: readonly CachedHarnessModel[] | undefined,
  incoming: ReadonlyArray<{ value?: unknown; displayName?: unknown; description?: unknown; resolvedModel?: unknown }> | undefined,
  mode: 'merge' | 'replace' = 'merge',
): { entries: CachedHarnessModel[]; changed: boolean } {
  const prev = normalizeCatalogEntries(existing);
  const nextIncoming = normalizeCatalogEntries(incoming);
  if (nextIncoming.length === 0) {
    return { entries: prev, changed: false };
  }
  let next: CachedHarnessModel[];
  if (mode === 'replace') {
    next = nextIncoming;
  } else {
    const incomingByValue = new Map(nextIncoming.map((entry) => [entry.value, entry]));
    const seen = new Set<string>();
    next = [];
    for (const old of prev) {
      const updated = incomingByValue.get(old.value);
      next.push(updated ?? old);
      seen.add(old.value);
    }
    for (const fresh of nextIncoming) {
      if (!seen.has(fresh.value)) {
        next.push(fresh);
        seen.add(fresh.value);
      }
    }
  }
  return { entries: next, changed: !catalogsEqual(prev, next) };
}
