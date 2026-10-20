/**
 * Pure logic behind the daemon editor's "Secrets to send to this daemon" checklist: which secret NAMES the app can
 * offer, how they merge with what is already saved, and the "Add by name" validation. Names only: nothing here ever
 * sees a value, so a value cannot reach the UI through it.
 *
 * An allowlist entry is `NAME` (any project) or `<projectId>/NAME` (one project), the syntax `filterAllowlisted` reads.
 */
import { forwardableEnv } from '../credsDelivery';
import { PUSHED_SECRET_ENTRY } from './daemonConfig';

export interface PushableSecretSources {
  /** Names of Extra environment variables that have a value. */
  envNames: readonly string[];
  /** Keychain secrets that have a value; `projectIds` is the scope list (empty = every project). */
  keychain: ReadonlyArray<{ name: string; projectIds: readonly string[] }>;
  /** Display name for a project id; undefined when unknown. */
  projectName?(projectId: string): string | undefined;
}

export interface PickerRow {
  /** The allowlist entry this row toggles. */
  entry: string;
  /** What the user reads next to the checkbox. */
  label: string;
  /** Secondary line: where it comes from, or why it is shown. */
  hint: string;
  /** False for a saved entry that nothing currently resolves. */
  found: boolean;
}

/** Whether `forwardableEnv` would ever forward a variable of this name. */
export function isForwardableName(name: string): boolean {
  return Object.keys(forwardableEnv({ [name]: 'x' })).length === 1;
}

const byLabel = (a: PickerRow, b: PickerRow): number =>
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.entry.localeCompare(b.entry);

/** Every entry the app could send right now, ordered by label. A scoped keychain secret is offered per project only. */
export function buildPickerRows(sources: PushableSecretSources): PickerRow[] {
  const rows = new Map<string, PickerRow>();
  for (const name of sources.envNames) {
    if (!isForwardableName(name)) continue;
    rows.set(name, { entry: name, label: name, hint: 'Extra environment variable', found: true });
  }
  for (const { name, projectIds } of sources.keychain) {
    if (!isForwardableName(name)) continue;
    if (projectIds.length === 0) {
      const also = rows.has(name);
      rows.set(name, { entry: name, label: name, hint: also ? 'Keychain secret, also an Extra environment variable' : 'Keychain secret', found: true });
      continue;
    }
    for (const id of projectIds) {
      const entry = `${id}/${name}`;
      if (!PUSHED_SECRET_ENTRY.test(entry)) continue;
      const project = sources.projectName?.(id) ?? id;
      rows.set(entry, { entry, label: `${project} / ${name}`, hint: `Keychain secret, only for the project ${project}`, found: true });
    }
  }
  return [...rows.values()].sort(byLabel);
}

/** Available rows, then any saved entry nothing resolves (kept, flagged, so it can be unticked and is never dropped). */
export function mergeSavedEntries(available: readonly PickerRow[], saved: readonly string[]): PickerRow[] {
  const known = new Set(available.map((r) => r.entry));
  const missing: PickerRow[] = [];
  for (const entry of saved) {
    if (known.has(entry)) continue;
    known.add(entry);
    missing.push({ entry, label: entry, hint: 'Not found: nothing currently provides this name. Untick to stop sending it.', found: false });
  }
  return [...available, ...missing.sort(byLabel)];
}

export type AddByNameResult = { ok: true; entry: string } | { ok: false; reason: string };

/** Validates the "Add by name" box. The reason never echoes the input: the user may have pasted a value. */
export function checkAddByName(input: string): AddByNameResult {
  const entry = input.trim();
  if (!entry) return { ok: false, reason: 'Enter a variable name to add.' };
  if (!PUSHED_SECRET_ENTRY.test(entry)) {
    return { ok: false, reason: 'Enter a variable name only (letters, digits and _, optionally project/NAME), never the secret itself.' };
  }
  return { ok: true, entry };
}

/** Adds a typed name as a ticked row (or just ticks the row it duplicates). Pure: returns the new rows and selection. */
export function addNamedRow(rows: readonly PickerRow[], selected: ReadonlySet<string>, entry: string): { rows: PickerRow[]; selected: Set<string> } {
  const nextSelected = new Set(selected).add(entry);
  if (rows.some((r) => r.entry === entry)) return { rows: [...rows], selected: nextSelected };
  const row: PickerRow = { entry, label: entry, hint: 'Added by name. Nothing provides it yet; it is sent once something does.', found: false };
  return { rows: [...rows, row], selected: nextSelected };
}

/** The allowlist to save: ticked rows in display order. Empty = nothing is sent. */
export function selectedEntries(rows: readonly PickerRow[], selected: ReadonlySet<string>): string[] {
  return rows.filter((r) => selected.has(r.entry)).map((r) => r.entry);
}
