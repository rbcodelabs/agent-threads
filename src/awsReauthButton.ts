import { Notice } from 'obsidian';
import type { PluginSettings } from './types';
import { reauthenticateAws } from './awsReauth';

const LABEL = '🔑 Re-authenticate AWS SSO';

/**
 * The one-click "Re-authenticate AWS SSO" button shared by the dashboard,
 * kanban and thread error card. Signs in, verifies, and reports via Notice.
 */
export function renderAwsReauthButton(
  parent: HTMLElement,
  settings: Pick<PluginSettings, 'extraEnv' | 'provider'>,
  errorText: string | undefined,
  opts: { stopPropagation?: boolean } = {},
): HTMLButtonElement {
  const btn = parent.createEl('button', { cls: 'ct-aws-reauth-btn', text: LABEL });
  btn.addEventListener('click', async (e) => {
    if (opts.stopPropagation) e.stopPropagation();
    btn.setText('Authenticating…');
    btn.disabled = true;
    const result = await reauthenticateAws(settings, errorText, {
      onProgress: (text) => btn.setText(text),
    }).catch((err): { ok: false; error: string } => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (result.ok) {
      new Notice('AWS SSO login successful — retry your request');
      btn.setText('✓ Done — retry your request');
    } else {
      new Notice(`AWS SSO login failed: ${result.error}`);
      btn.setText(LABEL);
      btn.disabled = false;
    }
  });
  return btn;
}
