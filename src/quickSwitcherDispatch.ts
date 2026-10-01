// Quick-switcher "Dispatch new conversation" row. Pure (no Obsidian imports) so
// it is unit-testable and safe in every bundle.
//
// `Plugin.registerQuickSwitcherProvider` exists only in Geode. These local
// interfaces mirror its shape so we carry no types dependency on Geode.

export interface QuickSwitcherPluginItem {
  title: string;
  subtitle?: string;
  /** Lucide icon id. */
  icon?: string;
  onChoose(evt: KeyboardEvent | MouseEvent): void;
}

export interface QuickSwitcherProvider {
  id?: string;
  getItems(query: string): QuickSwitcherPluginItem[];
}

/** Builds the dispatch row for a typed query; empty/whitespace yields no rows. */
export function buildDispatchItems(
  query: string,
  dispatch: (text: string) => void,
): QuickSwitcherPluginItem[] {
  const text = query.trim();
  if (!text) return [];
  return [
    {
      title: `Dispatch new conversation: "${text}"`,
      subtitle: 'Agent Threads',
      icon: 'message-square-plus',
      onChoose: () => dispatch(text),
    },
  ];
}

/**
 * Registers the provider when the host supports it (Geode). On real Obsidian the
 * method is absent and this is a silent no-op. Returns whether it registered.
 */
export function registerDispatchQuickSwitcher(
  host: unknown,
  dispatch: (text: string) => void,
): boolean {
  const register = (host as { registerQuickSwitcherProvider?: unknown } | null)
    ?.registerQuickSwitcherProvider;
  if (typeof register !== 'function') return false;
  const provider: QuickSwitcherProvider = {
    id: 'agent-threads-dispatch',
    getItems: (query) => buildDispatchItems(query, dispatch),
  };
  register.call(host, provider);
  return true;
}
