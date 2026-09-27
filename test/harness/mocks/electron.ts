/** Stub for the Electron module in the Playwright browser harness. */
export const shell = {
  openExternal: (_url: string): void => {},
  openPath: (_path: string): Promise<string> => Promise.resolve(''),
};

/**
 * Controllable stand-in for `electron`'s `ipcRenderer`, scoped to the two
 * channels `AgentBrowserLoginBridge` listens on
 * (`agent-browser-window-close`/`-focus`, see ADR-0014). Real Electron calls
 * `on()` listeners as `(event, ...args)`; `emit()` mirrors that shape so a
 * harness page can fire the same channel a real popup-close/focus would,
 * without needing an actual Electron host.
 */
type IpcListener = (...args: unknown[]) => void;
const ipcListeners = new Map<string, Set<IpcListener>>();

export const ipcRenderer = {
  on(channel: string, listener: IpcListener): void {
    let set = ipcListeners.get(channel);
    if (!set) {
      set = new Set();
      ipcListeners.set(channel, set);
    }
    set.add(listener);
  },
  removeListener(channel: string, listener: IpcListener): void {
    ipcListeners.get(channel)?.delete(listener);
  },
  /** Test-only: fire a channel as Electron's main process would. */
  emit(channel: string, ...args: unknown[]): void {
    for (const listener of ipcListeners.get(channel) ?? []) listener({}, ...args);
  },
};
