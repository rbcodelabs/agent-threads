import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleWorkspaceMcp } from '../../src/GoogleWorkspaceMcp';

const instances: GoogleWorkspaceMcp[] = [];
afterEach(() => instances.forEach(instance => instance.close()));

function setup() {
  const tokens = { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3600000 };
  const plugin = { settings: { authProxyUrl: 'https://auth.example.com' }, tokenStore: {
    supportsConnectionGuard: true, get: () => tokens, getValidAccessToken: vi.fn(async () => tokens.accessToken),
  } };
  const proxy = new GoogleWorkspaceMcp(() => plugin);
  instances.push(proxy);
  return proxy;
}

describe('Google Workspace MCP origin change notification', () => {
  it('calls onOriginChange with the new origin when the proxy starts listening', async () => {
    const proxy = setup();
    const seen: string[] = [];
    proxy.onOriginChange = (origin) => seen.push(origin);
    await proxy.configure({ docs: true });
    const url = proxy.serversForThread('thread')['google-docs'].url;
    expect(seen).toEqual([new URL(url).origin]);
  });

  it('does not re-notify when configure() runs again on the same listening server', async () => {
    const proxy = setup();
    const onOriginChange = vi.fn();
    proxy.onOriginChange = onOriginChange;
    await proxy.configure({ docs: true });
    await proxy.configure({ docs: true, drive: true });
    expect(onOriginChange).toHaveBeenCalledTimes(1);
  });
});
