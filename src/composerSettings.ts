/**
 * Pure state -> presentation mapping for the composer's "settings indicator"
 * (the Quiet Rail button) and the project popover's list helpers. No DOM here:
 * `composerGlyphs.ts` draws the glyph ids, `composerSettingsPopover.ts` the UI.
 */
import { agentHarnessLabel, resolveEffectiveHarnessVmMode, type AgentHarness, type HarnessVmMode } from './types';

export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'unknown';
export type ModelGlyph = 'chip' | 'chip-1' | 'chip-2' | 'chip-3' | 'sparkle';
export type ProviderGlyph = 'claude' | 'codex' | 'opencode';
export type LocationGlyph = 'laptop' | 'cube' | 'cloud';
export type RemoteConnection = 'connected' | 'pending' | 'unreachable';

export interface ComposerSettingsInput {
  harness: AgentHarness | undefined;
  /** Selected model (alias or id); undefined follows the global default. */
  model: string | undefined;
  /** Exact model the provider last reported. */
  activeModel: string | undefined;
  /** Per-thread container override. */
  vmMode: HarnessVmMode | undefined;
  /** Global container routing setting. */
  settingsVmMode: HarnessVmMode | undefined;
  remote?: { daemonName: string; connection: RemoteConnection };
}

export interface ComposerSettingsDescription {
  model: { glyph: ModelGlyph; tier: ModelTier; label: string };
  provider: { glyph: ProviderGlyph; label: string };
  location: { glyph: LocationGlyph; label: string; marker?: 'connected' | 'unreachable' };
  ariaLabel: string;
}

const TIER_LABEL: Record<Exclude<ModelTier, 'unknown'>, string> = {
  haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable',
};
const TIER_GLYPH: Record<ModelTier, ModelGlyph> = {
  haiku: 'chip-1', sonnet: 'chip-2', opus: 'chip-3', fable: 'sparkle', unknown: 'chip',
};

/** Family of a model alias or id; anything unrecognised (other harnesses) is 'unknown'. */
export function modelTier(model: string | undefined): ModelTier {
  const m = (model ?? '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  if (m.includes('fable')) return 'fable';
  return 'unknown';
}

export function describeComposerSettings(input: ComposerSettingsInput): ComposerSettingsDescription {
  const harness: AgentHarness = input.harness ?? 'claude';
  const shown = input.activeModel || input.model;
  const tier = modelTier(shown);
  const model = {
    glyph: TIER_GLYPH[tier],
    tier,
    label: tier !== 'unknown' ? TIER_LABEL[tier] : (shown || 'Default'),
  };
  const provider = { glyph: harness as ProviderGlyph, label: agentHarnessLabel(harness) };

  let location: ComposerSettingsDescription['location'];
  let locationAria: string;
  if (input.remote) {
    const marker = input.remote.connection === 'connected' ? 'connected'
      : input.remote.connection === 'unreachable' ? 'unreachable' : undefined;
    location = { glyph: 'cloud', label: 'remote', ...(marker ? { marker } : {}) };
    locationAria = `remote on ${input.remote.daemonName}${marker ? ` (${marker})` : ''}`;
  } else if (harness === 'claude' && resolveEffectiveHarnessVmMode(input.vmMode, input.settingsVmMode) !== 'never') {
    location = { glyph: 'cube', label: 'container' };
    locationAria = 'container';
  } else {
    location = { glyph: 'laptop', label: 'host' };
    locationAria = 'host';
  }
  return {
    model,
    provider,
    location,
    ariaLabel: `Composer settings: ${model.label}, ${provider.label}, ${locationAria}`,
  };
}

interface NamedProject { id: string; name: string; createdAt: number }
interface ActivityThread { projectId?: string; updatedAt: number }

export function filterProjects<P extends { name: string }>(projects: readonly P[], query: string): P[] {
  const q = query.trim().toLowerCase();
  return q ? projects.filter(p => p.name.toLowerCase().includes(q)) : [...projects];
}

/** 'recent' = most recent thread activity in the project (creation time when it has none). */
export function sortProjects<P extends NamedProject>(
  projects: readonly P[],
  threads: readonly ActivityThread[],
  mode: 'recent' | 'alpha',
): P[] {
  const out = [...projects];
  if (mode === 'alpha') return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const last = new Map<string, number>();
  for (const t of threads) {
    if (t.projectId) last.set(t.projectId, Math.max(last.get(t.projectId) ?? 0, t.updatedAt));
  }
  const stamp = (p: P) => last.get(p.id) ?? p.createdAt;
  return out.sort((a, b) => stamp(b) - stamp(a));
}
