import { test, expect } from '@playwright/test';
import { openCodexNetworkSettings, networkRow, chooseNetworkAccess } from '../harness/codex-network-access';
import { shot } from './helpers';

for (const [width, height] of [[1280, 800], [390, 844], [375, 667]]) {
  test(`Codex network access choices at ${width}px`, async ({ page }) => {
    await openCodexNetworkSettings(page, width, height);
    await expect(networkRow(page)).toContainText('Off');
    await networkRow(page).click();
    await shot(page, `codex-network-access-off-${width}.png`);
    await chooseNetworkAccess(page, true);
    await shot(page, `codex-network-access-on-${width}.png`);
  });
}
