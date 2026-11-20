import { test, expect } from '@playwright/test';
import path from 'path';

const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');

test.describe('Settings → Agent per-provider tabs and defaults', () => {
  test('provider tabs inspect and configure each harness independently without changing global Agent harness', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 860 });
    await page.goto(settingsUrl);
    await page.getByLabel('Settings section').selectOption('claude');

    // Shared defaults sit above the provider tabs; Claude Code starts active with Default badge.
    const claudeTab = page.getByRole('tab', { name: /Claude Code/ });
    const codexTab = page.getByRole('tab', { name: /OpenAI Codex/ });
    const opencodeTab = page.getByRole('tab', { name: /OpenCode/ });
    const agyTab = page.getByRole('tab', { name: /Antigravity/ });

    await expect(claudeTab).toHaveAttribute('aria-selected', 'true');
    await expect(claudeTab.locator('.ct-provider-tab-badge')).toHaveText('Default');
    await expect(agyTab.locator('.ct-provider-tab-badge')).toHaveCount(0);

    // Switch to Antigravity tab without changing global Agent harness
    await agyTab.click();
    await expect(agyTab).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => (window as any).__settings.agentHarness)).toBe('claude');
    await expect(claudeTab.locator('.ct-provider-tab-badge')).toHaveText('Default');

    // Configure Antigravity default model and permission mode
    const modelSelect = page.locator('.ct-provider-panel .setting-item', { hasText: 'Default model' }).locator('select');
    const permSelect = page.locator('.ct-provider-panel .setting-item', { hasText: 'Default permission mode' }).locator('select');
    await modelSelect.selectOption('gemini-4-carbon-medium');
    await permSelect.selectOption('bypassPermissions');

    // Switch to Codex tab and set Codex-specific model + permission mode
    await codexTab.click();
    await expect(codexTab).toHaveAttribute('aria-selected', 'true');
    await page.locator('.ct-provider-panel .setting-item', { hasText: 'Default model' }).locator('select').selectOption('gpt-5.6-codex');
    await page.locator('.ct-provider-panel .setting-item', { hasText: 'Default permission mode' }).locator('select').selectOption('default');

    // Switch to OpenCode tab and verify OpenCode binary path + model
    await opencodeTab.click();
    await expect(page.locator('.ct-provider-panel .setting-item', { hasText: 'OpenCode binary path' })).toBeVisible();
    await page.locator('.ct-provider-panel .setting-item', { hasText: 'Default model' }).locator('select').selectOption('anthropic/claude-sonnet-4-5');

    // Verify Claude's defaultModel ('sonnet' from fixture) was NOT overwritten by any other provider
    await claudeTab.click();
    await expect(page.locator('.ct-provider-panel .setting-item', { hasText: 'Default model' }).locator('select')).toHaveValue('sonnet');

    const snapshot = await page.evaluate(() => ({
      agentHarness: (window as any).__settings.agentHarness,
      defaultModel: (window as any).__settings.defaultModel,
      defaultModelByHarness: (window as any).__settings.defaultModelByHarness,
      permissionModeByHarness: (window as any).__settings.permissionModeByHarness,
    }));
    expect(snapshot).toEqual({
      agentHarness: 'claude',
      defaultModel: 'sonnet',
      defaultModelByHarness: {
        antigravity: 'gemini-4-carbon-medium',
        codex: 'gpt-5.6-codex',
        opencode: 'anthropic/claude-sonnet-4-5',
      },
      permissionModeByHarness: {
        antigravity: 'bypassPermissions',
        codex: 'default',
      },
    });
  });

  test('preserves saved model ID before discovery and refreshes catalog via Refresh models button', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(settingsUrl);
    await page.evaluate(() => {
      const host = window as any;
      host.__settings.defaultModelByHarness = { antigravity: 'gemini-4-hydrogen-high' };
      host.__settingsPlugin.discoveredModelsByHarness.antigravity = [];
      host.__mockRefreshModels = async () => [
        { value: 'gemini-4-hydrogen-high', displayName: 'Gemini 4 Hydrogen (High)' },
        { value: 'gemini-4-carbon-medium', displayName: 'Gemini 4 Carbon (Medium)' },
      ];
      host.__settingsTab.display();
    });

    await page.getByLabel('Settings section').selectOption('claude');
    await page.getByRole('tab', { name: /Antigravity/ }).click();

    const modelRow = page.locator('.ct-provider-panel .setting-item', { hasText: 'Default model' });
    const select = modelRow.locator('select');
    await expect(select).toHaveValue('gemini-4-hydrogen-high');
    await expect(select.locator('option[value="gemini-4-hydrogen-high"]')).toHaveText('gemini-4-hydrogen-high (saved)');

    await modelRow.getByRole('button', { name: 'Refresh models' }).click();
    await expect(modelRow.locator('.ct-model-refresh-status')).toContainText('Loaded 2 models from Antigravity.');
    await expect(select).toHaveValue('gemini-4-hydrogen-high');
    await expect(select.locator('option[value="gemini-4-hydrogen-high"]')).toHaveText('Gemini 4 Hydrogen (High)');
    await expect(select.locator('option[value="gemini-4-carbon-medium"]')).toHaveText('Gemini 4 Carbon (Medium)');
  });

  test('supports keyboard arrow navigation on provider tabs and avoids horizontal overflow down to 375px', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    await page.goto(settingsUrl);
    await page.getByLabel('Settings section').selectOption('claude');

    const claudeTab = page.getByRole('tab', { name: /Claude Code/ });
    await claudeTab.focus();
    await claudeTab.press('ArrowRight');
    const codexTab = page.getByRole('tab', { name: /OpenAI Codex/ });
    await expect(codexTab).toBeFocused();
    await expect(codexTab).toHaveAttribute('aria-selected', 'true');

    await codexTab.press('End');
    const agyTab = page.getByRole('tab', { name: /Antigravity/ });
    await expect(agyTab).toBeFocused();
    await expect(agyTab).toHaveAttribute('aria-selected', 'true');

    for (const [width, height] of [[1280, 800], [800, 800], [375, 667]] as const) {
      await page.setViewportSize({ width, height });
      await expect.poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
    }
  });
});
