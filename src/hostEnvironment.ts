export type ClaudeThreadsHostName = 'Geode' | 'Obsidian';

/** Geode exposes a compatibility marker on its host window. */
export function detectHostName(hostWindow: { geode?: unknown }): ClaudeThreadsHostName {
  return hostWindow.geode ? 'Geode' : 'Obsidian';
}

/** URL scheme for deep links that Geode or Obsidian will route to registerObsidianProtocolHandler. */
export function deepLinkScheme(hostWindow: { geode?: unknown }): 'geode' | 'obsidian' {
  return detectHostName(hostWindow) === 'Geode' ? 'geode' : 'obsidian';
}
