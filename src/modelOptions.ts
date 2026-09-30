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
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1',
};

/**
 * Parses a Claude model id into family and version. Accepts first-party ids
 * (`claude-opus-4-8`, `claude-haiku-4-5-20251001`, `claude-sonnet-5[1m]`) and
 * cloud-provider forms (`us.anthropic.claude-opus-5-5`,
 * `anthropic.claude-sonnet-5-v1:0`, `claude-opus-4-8@20260101`).
 */
export function parseClaudeModelId(modelId: string | undefined): { family: string; version: string } | undefined {
  if (!modelId) return undefined;
  const bare = modelId
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./i, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-v\d+(?::\d+)?$/i, '')
    .replace(/-\d{8}$/, '');
  const match = bare.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/i);
  if (!match) return undefined;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  return { family, version: match[3] ? `${match[2]}.${match[3]}` : match[2] };
}

/** Version of a model id: `claude-opus-4-8` -> "4.8". Undefined when unparseable. */
export function modelVersionFromId(modelId: string | undefined): string | undefined {
  return parseClaudeModelId(modelId)?.version;
}

/** Human name for an exact model id: "Opus 5.5"; the raw id when unparseable. */
export function formatModelId(modelId: string): string {
  const parsed = parseClaudeModelId(modelId);
  return parsed ? `${parsed.family} ${parsed.version}` : modelId;
}

/**
 * Menu/label text for the model a thread last actually ran on, e.g.
 * "Opus 5.5 (us.anthropic.claude-opus-5-5)". The raw id is kept so the exact
 * provider model is always visible.
 */
export function activeModelLabel(modelId: string): string {
  const pretty = formatModelId(modelId);
  return pretty === modelId ? modelId : `${pretty} (${modelId})`;
}

/**
 * What a family alias points at. Uses the catalog alias entry when the SDK
 * lists one; otherwise the catalog row the CLI names after the bare family
 * ("Opus", "Fable"), which is how it marks the current release on Bedrock
 * and Vertex, where the alias entry is omitted. Falls back to built-ins.
 */
function resolvedIdForAlias(alias: string, catalog: readonly ModelCatalogEntry[]): string | undefined {
  const direct = catalog.find((m) => m.value === alias);
  if (direct) return direct.resolvedModel ?? FALLBACK_RESOLVED[alias];
  const family = CLAUDE_FAMILY_ALIASES.find((a) => a.value === alias)?.family;
  const named = family ? catalog.find((m) => m.displayName === family) : undefined;
  return named ? named.resolvedModel ?? named.value : FALLBACK_RESOLVED[alias];
}

/**
 * Label for a catalog row. The SDK often omits the version from displayName
 * (the current Opus is just "Opus"), so derive it from the id when possible:
 * "Opus 5.5", "Opus 5.5 (1M context)". Falls back to displayName, then the id.
 */
export function catalogModelLabel(m: ModelCatalogEntry): string {
  const id = m.resolvedModel ?? m.value;
  const parsed = parseClaudeModelId(id);
  if (!parsed) return m.displayName || m.value;
  const base = `${parsed.family} ${parsed.version}`;
  return /\[1m\]$/i.test(id) || /\[1m\]$/i.test(m.value) ? `${base} (1M context)` : base;
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
    options.push({ label: catalogModelLabel(m), value: m.value });
  }
  return options;
}

/**
 * True for a real provider model id. Rejects empty values and the CLI's
 * placeholder ids such as `<synthetic>`, used on locally generated messages.
 */
export function isReportedModelId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.startsWith('<');
}
