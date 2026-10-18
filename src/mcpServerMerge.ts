/** Built-in names are reserved so user settings cannot replace trusted tools. */
export function mergeMcpServers<T>(builtIns: Record<string, T>, external: Record<string, T>): Record<string, T> {
  return { ...external, ...builtIns };
}

export function selectCanonicalHarnessTools<T>(
  servers: Record<string, unknown> | undefined,
): T[] | undefined {
  return (servers?.claude_threads as { harnessTools?: T[] } | undefined)?.harnessTools;
}
