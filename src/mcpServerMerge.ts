/** Built-in names are reserved so user settings cannot replace trusted tools. */
export function mergeMcpServers<T>(builtIns: Record<string, T>, external: Record<string, T>): Record<string, T> {
  return { ...external, ...builtIns };
}

function sameStringRecord(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => typeof a[key] === 'string' && a[key] === b[key]);
}

function sameHostLoopbackConfig(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return a.type === 'http' && b.type === 'http' && a.url === b.url && sameStringRecord(a.headers, b.headers);
}

/**
 * Replace only host-loopback configs that actually survived ordinary roster
 * precedence. A same-name built-in, Google, or external server is left intact.
 */
export function overlayMatchingMcpServers<T>(
  ordinary: Record<string, T>,
  expectedHostConfigs: Record<string, T>,
  overlays: Record<string, T>,
): Record<string, T> {
  const result = { ...ordinary };
  for (const [name, overlay] of Object.entries(overlays)) {
    if (sameHostLoopbackConfig(result[name], expectedHostConfigs[name])) result[name] = overlay;
  }
  return result;
}

export function selectCanonicalHarnessTools<T>(
  servers: Record<string, unknown> | undefined,
): T[] | undefined {
  return (servers?.claude_threads as { harnessTools?: T[] } | undefined)?.harnessTools;
}
