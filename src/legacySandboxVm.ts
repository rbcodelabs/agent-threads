/**
 * legacySandboxVm.ts — tolerates data written while per-thread sandbox VMs
 * existed.
 *
 * The plugin used to run threads (and the agent's `enter_vm`/`vm_exec` tools) in
 * a per-thread Apple `container` VM. That feature is gone; the managed local
 * daemon is the only container the plugin runs. Old `data.json` settings and
 * persisted threads still carry the fields that configured it. They are inert,
 * and this module deletes them on load so they leave `data.json` on the next
 * save. A thread that was VM-routed simply runs on the host from now on.
 *
 * Pure and dependency-free (no Node built-ins), so it is safe in the mobile
 * bundle and the daemon-checked core closure.
 */

/** Keys of `PluginSettings` that only configured the removed sandbox VMs. */
export const LEGACY_SANDBOX_SETTING_KEYS: readonly string[] = [
  'vmImage',
  'vmDefaultNetwork',
  'harnessVmMode',
  'harnessVmImage',
  'sandboxVmMemory',
  'sandboxVmCpus',
  'sandboxSetupPromptDismissed',
];

/** Keys of a persisted `Thread` that only selected the removed per-thread VM mode. */
export const LEGACY_SANDBOX_THREAD_KEYS: readonly string[] = ['harnessVmMode'];

function stripKeys(target: unknown, keys: readonly string[]): boolean {
  if (!target || typeof target !== 'object') return false;
  const record = target as Record<string, unknown>;
  let changed = false;
  for (const key of keys) {
    if (key in record) {
      delete record[key];
      changed = true;
    }
  }
  return changed;
}

/** Deletes the removed sandbox-VM settings from a settings object, in place. Returns true if anything was removed. */
export function stripLegacySandboxSettings(settings: unknown): boolean {
  return stripKeys(settings, LEGACY_SANDBOX_SETTING_KEYS);
}

/** Deletes the removed per-thread VM mode from a persisted thread, in place. Returns true if anything was removed. */
export function stripLegacySandboxThreadFields(thread: unknown): boolean {
  return stripKeys(thread, LEGACY_SANDBOX_THREAD_KEYS);
}
