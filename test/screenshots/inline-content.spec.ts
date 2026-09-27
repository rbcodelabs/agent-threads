import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

async function registerProvider(page: Page, html?: string): Promise<void> {
  await page.evaluate((documentHtml) => {
    const host = window as any;
    host.__contentActions ??= [];
    host.__contentPresentations ??= [];
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#1a3449';
    context.fillRect(0, 0, 640, 180);
    context.fillStyle = '#eeb183';
    context.beginPath();
    context.arc(535, 80, 60, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#ffffff';
    context.font = 'bold 26px sans-serif';
    context.fillText('A fresh perspective.', 24, 125);
    host.__contentRegistration = host.__api.extensions.registerMessageContentProvider(
      { pluginId: 'example-plugin' },
      {
        providerId: 'example.reports',
        present(ref: any, ctx: any) {
          host.__contentPresentations.push({ id: ref.id, threadId: ctx.threadId, messageId: ctx.messageId });
          if (ref.data.kind === 'image') return {
            kind: 'image', title: ref.title, subtitle: 'Studio · Image',
            src: canvas.toDataURL('image/png'), alt: 'Synthetic campaign: sunrise over a navy landscape',
          };
          if (ref.data.kind === 'document') return {
            kind: 'document', title: ref.title, subtitle: 'Analytics · Interactive document', height: 200,
            html: documentHtml ?? '<!doctype html><html><head><style>body{font:15px system-ui;padding:16px;color:#ececf0;background:#232427}button{min-height:44px;padding:8px 16px}p{margin:12px 0}</style></head><body><p>North 82 · West 65 · East 49</p><button id="explore" onclick="document.getElementById(\'result\').textContent=\'North selected\'">Explore North</button><p id="result">Choose a region.</p></body></html>',
          };
          return {
            kind: 'card', title: ref.title, subtitle: 'Reports · Updated just now',
            body: 'Revenue grew 18% this quarter. Three opportunities need a follow-up.',
            actions: [{ id: 'open', label: 'Open report', shortLabel: 'Open report', variant: 'primary', icon: 'file-text' }],
          };
        },
        async invoke(actionId: string, ref: any, ctx: any) {
          host.__contentActions.push({ actionId, id: ref.id, threadId: ctx.threadId, messageId: ctx.messageId });
          return { status: 'ok', message: 'Report opened' };
        },
      },
    );
    if (!host.__contentRegistration.success) throw new Error(JSON.stringify(host.__contentRegistration));
  }, html);
}

async function openFixture(page: Page, width = 1280, height = 800): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.goto(harnessUrl + (width > 500 ? '?document' : '?mobile'));
  await page.waitForSelector('.ct-messages');
  await page.locator('#app').evaluate((el, size) => {
    el.style.width = Math.min(size.width, 980) + 'px';
    el.style.height = size.height + 'px';
  }, { width, height });
  await registerProvider(page);
  await page.evaluate(() => (window as any).__showInlineContent());
  await expect(page.locator('.ct-inline-content')).toHaveCount(4);
  await expect(page.locator('.ct-inline-content-body')).toContainText('Revenue grew 18%');
}

test('peer cards occupy exact transcript positions and invoke captured message actions', async ({ page }) => {
  await openFixture(page);
  const content = page.locator('.ct-message-assistant').filter({ has: page.locator('.ct-inline-content') });
  const text = await content.innerText();
  expect(text.indexOf('The quarterly report is ready.')).toBeLessThan(text.indexOf('Quarterly report'));
  expect(text.indexOf('Revenue grew 18%')).toBeLessThan(text.indexOf('Here is the campaign preview.'));
  await page.getByRole('button', { name: 'Open report', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__contentActions)).toEqual([
    { actionId: 'open', id: 'report', threadId: 'thread-new', messageId: 'inline-assistant' },
  ]);
  await expect(page.locator('.ct-inline-content').last()).toContainText('Research notes');
  await expect(page.locator('.ct-inline-content').last().locator('button')).toHaveCount(0);
  const inner = page.frameLocator('.ct-inline-content-document').frameLocator('iframe');
  await inner.getByRole('button', { name: 'Explore North' }).click();
  await expect(inner.locator('#result')).toHaveText('North selected');
});

for (const [width, height] of [[1280, 800], [390, 844], [375, 667]]) {
  test('inline content layout at ' + width + 'px', async ({ page }) => {
    await openFixture(page, width, height);
    const cards = page.locator('.ct-inline-content');
    for (let index = 0; index < 4; index++) {
      const card = cards.nth(index);
      await card.scrollIntoViewIfNeeded();
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      const bounds = (await card.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    const action = page.getByRole('button', { name: 'Open report', exact: true });
    await action.scrollIntoViewIfNeeded();
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot(cards.first(), 'inline-card-' + width + '.png');
    await cards.nth(1).scrollIntoViewIfNeeded();
    await shot(cards.nth(1), 'inline-image-' + width + '.png');
    await cards.nth(2).scrollIntoViewIfNeeded();
    await shot(cards.nth(2), 'inline-document-' + width + '.png');
    await cards.last().scrollIntoViewIfNeeded();
    await shot(cards.last(), 'inline-unavailable-' + width + '.png');
  });
}

test('provider disposal removes actions and registering again restores persisted references', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => (window as any).__contentRegistration.dispose());
  await expect(page.locator('.ct-inline-content-document')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open report', exact: true })).toHaveCount(0);
  await expect(page.locator('.ct-inline-content').first()).toContainText('Quarterly report');
  await registerProvider(page);
  await expect(page.getByRole('button', { name: 'Open report', exact: true })).toHaveCount(1);
  await page.evaluate(async () => {
    const host = window as any;
    const messages = JSON.parse(JSON.stringify(host.__manager.getThread('thread-new').messages));
    await host.__view.focusThread('thread-visualize');
    host.__manager.getThread('thread-new').messages = messages;
    await host.__view.focusThread('thread-new');
  });
  await expect(page.locator('.ct-inline-content')).toHaveCount(4);
  await expect(page.locator('.ct-inline-content-document')).toHaveCount(1);
});

test('streaming references stay inert until the assistant message settles', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(async () => {
    const host = window as any;
    const thread = host.__manager.getThread('thread-new');
    thread.messages = [];
    await host.__view.renderMessages();
    host.__contentPresentations = [];
    const marker = host.__api.messageContent.formatReference({
      providerId: 'example.reports', id: 'streamed', schemaVersion: 1,
      title: 'Streamed report', data: { kind: 'card' },
    });
    host.__streamedMarker = marker;
    host.__emitEvent(thread.id, { type: 'token', text: 'A report is being prepared.\n\n' + marker });
  });
  await expect(page.locator('.ct-inline-content')).toHaveCount(1);
  await expect(page.locator('.ct-inline-content button')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__contentPresentations)).toEqual([]);
  await page.evaluate(() => {
    const host = window as any;
    const message = { id: 'streamed-assistant', role: 'assistant', content: 'A report is ready.\n\n' + host.__streamedMarker, timestamp: Date.now() };
    host.__manager.getThread('thread-new').messages.push(message);
    host.__emitEvent('thread-new', { type: 'message', message });
  });
  await expect(page.getByRole('button', { name: 'Open report', exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__contentPresentations)).toEqual([
    { id: 'streamed', threadId: 'thread-new', messageId: 'streamed-assistant' },
  ]);
});

test('user messages and assistant code examples do not activate a provider', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(async () => {
    const host = window as any;
    const marker = host.__api.messageContent.formatReference({
      providerId: 'example.reports', id: 'quoted', schemaVersion: 1, title: 'Quoted report', data: {},
    });
    host.__manager.getThread('thread-new').messages = [
      { id: 'user-example', role: 'user', content: marker, timestamp: Date.now() },
      { id: 'assistant-example', role: 'assistant', content: 'Example:\n\n~~~text\n' + marker + '\n~~~', timestamp: Date.now() },
    ];
    host.__contentPresentations = [];
    await host.__view.renderMessages();
  });
  await expect(page.locator('.ct-inline-content')).toHaveCount(0);
  await expect(page.locator('code')).toContainText('agent-content');
  expect(await page.evaluate(() => (window as any).__contentPresentations)).toEqual([]);
});

test('inline document scripts work while navigation, fetch and parent access are blocked', async ({ page }) => {
  await openFixture(page);
  const requests: string[] = [];
  await page.route('https://example.test/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.evaluate(() => (window as any).__contentRegistration.dispose());
  await registerProvider(page, '<!doctype html><body><img src="https://example.test/initial-image"><button id="probe">Run probe</button><button id="navigate">Try navigation</button><p id="result"></p><script>document.getElementById("probe").onclick=()=>{let blocked=false;try{parent.document.body.innerHTML="escaped"}catch{blocked=true}document.getElementById("result").textContent=blocked?"Parent blocked":"Parent accessed";fetch("https://example.test/fetch").catch(()=>{});const i=new Image();i.src="https://example.test/image";document.body.append(i);};document.getElementById("navigate").onclick=()=>{location.href="https://example.test/navigation";};</script></body>');
  const inner = page.frameLocator('.ct-inline-content-document').frameLocator('iframe');
  await inner.getByRole('button', { name: 'Run probe' }).click();
  await expect(inner.locator('#result')).toHaveText('Parent blocked');
  await inner.getByRole('button', { name: 'Try navigation' }).click();
  // Observe the immediate navigation and zero-delay refresh attempts.
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
  await expect(page.locator('.ct-messages')).toBeVisible();
  await expect(page.locator('.ct-inline-content-document')).toHaveAttribute('sandbox', 'allow-scripts');
});

for (const attempt of ['link', 'refresh']) {
  test('inline document blocks external ' + attempt, async ({ page }) => {
    await openFixture(page);
    const requests: string[] = [];
    await page.route('https://example.test/**', route => { requests.push(route.request().url()); return route.abort(); });
    await page.evaluate(() => (window as any).__contentRegistration.dispose());
    const script = attempt === 'link'
      ? 'const a=document.createElement("a");a.href="https://example.test/link";document.body.append(a);a.click();'
      : 'const m=document.createElement("meta");m.httpEquiv="refresh";m.content="0;url=https://example.test/refresh";document.head.append(m);';
    await registerProvider(page, '<!doctype html><body><button id="try">Try navigation</button><script>document.getElementById("try").onclick=()=>{' + script + '};</script></body>');
    await page.frameLocator('.ct-inline-content-document').frameLocator('iframe').getByRole('button', { name: 'Try navigation' }).click();
    await page.waitForTimeout(300);
    expect(requests).toEqual([]);
    await expect(page.locator('.ct-messages')).toBeVisible();
  });
}

for (const [width, height] of [[390, 844], [375, 667]]) {
  test('mobile relay retains inert inline references at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.goto('file://' + path.resolve('test/harness/mobile.html') + '?view=mobile-inline-content&width=' + width + '&height=' + height);
    await expect(page.locator('.ct-inline-content')).toHaveCount(4);
    await expect(page.locator('.ct-inline-content button')).toHaveCount(0);
    await expect(page.locator('.ct-inline-content iframe')).toHaveCount(0);
    await expect(page.locator('.ct-inline-content').first()).toContainText('Quarterly report');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.ct-inline-content').first().scrollIntoViewIfNeeded();
    await shot(page.locator('#app'), 'inline-mobile-relay-' + width + '.png');
  });
}
