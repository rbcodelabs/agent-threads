/**
 * Per-thread tool denylist (`Thread.disallowedTools`) — restriction-only.
 *
 * A prompt-level "don't use the shell" rule is not reliable, so threads that
 * must not run Bash (the Chief of Staff home thread) carry an enforced
 * denylist. Every operation here is a union: an entry can be added, never
 * removed, and an absent list means "no change". Inheritance is keyed by the
 * creating thread's id — never by a thread or item name, which anyone can
 * choose.
 *
 * No dependencies.
 */

/** De-duplicated union of denylists, in first-seen order. Absent lists are ignored. */
export function mergeDisallowedTools(...lists: Array<readonly string[] | undefined>): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const tool of list ?? []) if (!merged.includes(tool)) merged.push(tool);
  }
  return merged;
}

/** Whether the shell is denied (Claude's `Bash`; Codex command execution; OpenCode `bash`). */
export function isShellDenied(disallowedTools: readonly string[] | undefined): boolean {
  return (disallowedTools ?? []).includes('Bash');
}

/**
 * Adds the creating thread's denylist to something that creator is making —
 * a scheduled item or a child thread — and records the creator's id. Returns
 * the input unchanged when the creator has no denylist.
 */
export function withCreatorToolRestrictions<T extends object>(
  params: T,
  creator: { id: string; disallowedTools?: readonly string[] } | undefined,
): T & { disallowedTools?: string[]; createdByThreadId?: string } {
  if (!creator?.disallowedTools?.length) return params;
  const existing = (params as { disallowedTools?: string[] }).disallowedTools;
  return {
    ...params,
    disallowedTools: mergeDisallowedTools(existing, creator.disallowedTools),
    createdByThreadId: creator.id,
  };
}
