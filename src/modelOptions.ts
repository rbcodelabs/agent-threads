/**
 * Builds the Claude model choices shown in the per-thread model menu.
 *
 * The family aliases (opus, sonnet, haiku, fable) always track the newest
 * release, so a bare "Opus" row hides which model a conversation really runs
 * on. These helpers label each alias with the version it currently resolves to
 * and add pinned models from the SDK catalog so an older version is selectable.
 */

/** One row in the model menu. `value: undefined` clears the per-thread override. */
export interface ModelOption {
  label: string;
  value: string | undefined;
}

/** Minimal slice of the SDK's ModelInfo that this module reads. */
export interface ModelCatalogEntry {
  value: string;
  displayName: string;
  resolvedModel?: string;
}

/** Family aliases in menu order, with the display name used in labels. */
export const CLAUDE_FAMILY_ALIASES: ReadonlyArray<{ value: string; family: string }> = [
  { value: 'opus', family: 'Opus' },
  { value: 'sonnet', family: 'Sonnet' },
  { value: 'haiku', family: 'Haiku' },
  { value: 'fable', family: 'Fable' },
];

/**
 * Used when the SDK catalog has not been discovered yet (no session has run).
 * Mirrors the FALLBACK_MODELS list in SettingsTab.
 */
const FALLBACK_RESOLVED: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
};

/**
 * Extracts a human version from a canonical model id:
 * `claude-opus-4-8` -> "4.8", `claude-sonnet-5` -> "5",
 * `claude-haiku-4-5-20251001` -> "4.5". Returns undefined when unparseable.
 */
export function modelVersionFromId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const match = modelId.match(/^claude-[a-z]+-(\d+(?:-\d{1,2}(?!\d))?)(?:-\d{8})?(?:\[[^\]]*\])?$/i);
  return match ? match[1].replace('-', '.') : undefined;
}

function resolvedIdForAlias(alias: string, catalog: readonly ModelCatalogEntry[]): string | undefined {
  return catalog.find((m) => m.value === alias)?.resolvedModel ?? FALLBACK_RESOLVED[alias];
}

/** Label for a family alias: "Opus 4.8 (latest)", or plain "Opus" if the version is unknown. */
export function aliasLabel(alias: string, catalog: readonly ModelCatalogEntry[] = []): string {
  const entry = CLAUDE_FAMILY_ALIASES.find((a) => a.value === alias);
  if (!entry) return alias;
  const version = modelVersionFromId(resolvedIdForAlias(alias, catalog));
  return version ? `${entry.family} ${version} (latest)` : entry.family;
}

/**
 * Menu rows for a Claude thread: Default, each family alias with its resolved
 * version, then pinned catalog models. Catalog rows are skipped when they are
 * the alias rows themselves, "default", or the exact canonical id an alias
 * already points at (that would be a duplicate of the alias row).
 */
export function buildClaudeModelOptions(catalog: readonly ModelCatalogEntry[] = []): ModelOption[] {
  const options: ModelOption[] = [{ label: 'Default', value: undefined }];
  const aliasValues = new Set(CLAUDE_FAMILY_ALIASES.map((a) => a.value));
  const aliasTargets = new Set<string>();
  for (const { value } of CLAUDE_FAMILY_ALIASES) {
    options.push({ label: aliasLabel(value, catalog), value });
    const target = resolvedIdForAlias(value, catalog);
    if (target) aliasTargets.add(target);
  }
  const seen = new Set<string>();
  for (const m of catalog) {
    if (m.value === 'default' || aliasValues.has(m.value) || aliasTargets.has(m.value) || seen.has(m.value)) continue;
    seen.add(m.value);
    options.push({ label: m.displayName || m.value, value: m.value });
  }
  return options;
}
