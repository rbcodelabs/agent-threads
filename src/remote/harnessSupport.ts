/**
 * Which agent harnesses a remote daemon can host, from the `capabilities` its `welcome` advertised.
 * Pure (no Obsidian, no Node) so the Run-on menu, `dispatchNewThread` and `ThreadManager` agree.
 *
 *   - `harness.claude` / `harness.codex` / `harness.opencode`: the daemon accepts sessions for that harness.
 *   - `harness.fake`: the scripted test stand-in, which ignores `spec.harness`; it accepts any.
 *   - NO `harness.*` capability at all: a daemon older than multi-harness support. It hosts Claude only, so it is
 *     treated as Claude only (backward compatible), never as "anything goes".
 *   - capabilities not known yet (the daemon has not been reached since Geode started): unknown. Nothing is
 *     blocked on a guess; `session.open` reports a clear error if the daemon then refuses.
 *
 * `harness.<kind>.<feature>` entries (what a harness supports once hosted) are not harness names and are ignored here.
 */
import { AGENT_HARNESSES, agentHarnessLabel, type AgentHarness } from '../types';

const HARNESS_CAPABILITY = /^harness\.([a-z]+)$/;

/** The harnesses the daemon accepts, or `undefined` while its capabilities are unknown. */
export function daemonHarnesses(capabilities: readonly string[] | undefined): AgentHarness[] | undefined {
  if (!capabilities) return undefined;
  const advertised = capabilities.map((c) => HARNESS_CAPABILITY.exec(c)?.[1]).filter((n): n is string => !!n);
  if (advertised.length === 0) return ['claude'];
  if (advertised.includes('fake')) return [...AGENT_HARNESSES];
  return AGENT_HARNESSES.filter((h) => advertised.includes(h));
}

export type HarnessGate = { ok: true; known: boolean } | { ok: false; reason: string };

/** Can `daemonName` host `harness`? `known: false` means "not checked: capabilities are not known yet". */
export function gateHarness(harness: AgentHarness, capabilities: readonly string[] | undefined, daemonName: string): HarnessGate {
  const supported = daemonHarnesses(capabilities);
  if (!supported) return { ok: true, known: false };
  if (supported.includes(harness)) return { ok: true, known: true };
  const name = agentHarnessLabel(harness);
  const has = supported.map((h) => agentHarnessLabel(h)).join(', ');
  const old = !capabilities?.some((c) => HARNESS_CAPABILITY.test(c));
  return {
    ok: false,
    reason: old
      ? `${daemonName} is an older daemon that only runs Claude. Update it to run ${name}.`
      : `${daemonName} is not set up for ${name} (it offers: ${has}). Enable it on the daemon (harnesses setting) or pick another harness.`,
  };
}
