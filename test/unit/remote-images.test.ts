// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_UNAVAILABLE_TEXT,
  RemoteImageCache,
  createRemoteImageLoader,
  hydrateRemoteImages,
  remoteImagePathFromSrc,
  type LazyObserver,
} from '../../src/remote/remoteImages';
import { DaemonCommandError, fetchRemoteImage, type DaemonClient } from '../../src/remote/DaemonClient';

const html = (inner: string): HTMLElement => { const d = document.createElement('div'); d.innerHTML = inner; return d; };
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const immediate = () => undefined; // no observer: load at once

describe('remoteImagePathFromSrc', () => {
  it('accepts absolute image paths and decodes marked percent-encoding', () => {
    expect(remoteImagePathFromSrc('/home/u/chart.png')).toBe('/home/u/chart.png');
    expect(remoteImagePathFromSrc('/tmp/my%20pic.JPEG')).toBe('/tmp/my pic.JPEG');
  });
  it.each(['https://x/a.png', 'http://x/a.png', 'data:image/png;base64,AAAA', 'blob:abc', 'a/b.png', '//host/a.png', '/a.svg', '/a.txt', '/a.png?x=1', '/a.png#f', '', null, undefined, 'C:\\a.png'])(
    'leaves %s alone',
    (src) => { expect(remoteImagePathFromSrc(src as string)).toBeUndefined(); },
  );
});

describe('hydrateRemoteImages', () => {
  it('takes over only remote-path images, clearing src so nothing fetches the path', () => {
    const root = html('<img src="/srv/a.png" alt="a"><img src="https://x/b.png"><img src="data:image/png;base64,AA">');
    const load = vi.fn(() => new Promise<string | undefined>(() => {}));
    expect(hydrateRemoteImages(root, { load, signal: new AbortController().signal, observerFactory: immediate })).toBe(1);
    const imgs = root.querySelectorAll('img');
    expect(imgs[0].hasAttribute('src')).toBe(false);
    expect(imgs[0].classList.contains('is-loading')).toBe(true);
    expect(imgs[1].getAttribute('src')).toBe('https://x/b.png');
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith('/srv/a.png');
  });

  it('sets the data URL when the image loads', async () => {
    const root = html('<img src="/srv/a.png">');
    hydrateRemoteImages(root, { load: async () => 'data:image/png;base64,AAAA', signal: new AbortController().signal, observerFactory: immediate });
    await flush();
    const img = root.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(img.classList.contains('is-loading')).toBe(false);
  });

  it.each([['refused', async () => undefined], ['failed', async () => { throw new Error('offline'); }]])(
    'shows the placeholder when the load is %s',
    async (_n, load) => {
      const root = html('<p><img src="/srv/a.png" alt="the chart"></p>');
      hydrateRemoteImages(root, { load, signal: new AbortController().signal, observerFactory: immediate });
      await flush();
      expect(root.querySelector('img')).toBeNull();
      const note = root.querySelector('.ct-remote-img-unavailable')!;
      expect(note.textContent).toBe(IMAGE_UNAVAILABLE_TEXT);
      expect(note.getAttribute('title')).toBe('the chart');
    },
  );

  it('does not load, or touch the DOM, once aborted', async () => {
    const ac = new AbortController();
    const root = html('<img src="/srv/a.png">');
    let resolve!: (v: string) => void;
    const load = vi.fn(() => new Promise<string | undefined>((r) => { resolve = r; }));
    hydrateRemoteImages(root, { load, signal: ac.signal, observerFactory: immediate });
    ac.abort();
    resolve('data:image/png;base64,AAAA');
    await flush();
    expect(root.querySelector('img')!.hasAttribute('src')).toBe(false);

    const root2 = html('<img src="/srv/b.png">');
    const load2 = vi.fn(async () => 'x');
    hydrateRemoteImages(root2, { load: load2, signal: ac.signal, observerFactory: immediate });
    expect(load2).not.toHaveBeenCalled();
  });

  it('loads lazily: only when the observer reports the image visible, and disconnects on abort', async () => {
    const ac = new AbortController();
    const root = html('<img src="/srv/a.png"><img src="/srv/b.png">');
    let visible!: (el: Element) => void;
    const observer: LazyObserver = { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
    const load = vi.fn(async (p: string) => `data:image/png;base64,${p.length}`);
    hydrateRemoteImages(root, { load, signal: ac.signal, observerFactory: (cb) => { visible = cb; return observer; } });
    expect(load).not.toHaveBeenCalled();
    expect(observer.observe).toHaveBeenCalledTimes(2);
    visible(root.querySelectorAll('img')[1]);
    visible(root.querySelectorAll('img')[1]); // a repeat report loads once
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('/srv/b.png');
    ac.abort();
    expect(observer.disconnect).toHaveBeenCalled();
  });
});

describe('RemoteImageCache', () => {
  it('dedupes concurrent loads, caches hits, and does not cache refusals or failures', async () => {
    const cache = new RemoteImageCache();
    const fetcher = vi.fn(async () => 'data:1');
    const [a, b] = await Promise.all([cache.load('k', fetcher), cache.load('k', fetcher)]);
    expect([a, b]).toEqual(['data:1', 'data:1']);
    await cache.load('k', fetcher);
    expect(fetcher).toHaveBeenCalledOnce();

    const none = vi.fn(async () => undefined);
    await cache.load('n', none);
    await cache.load('n', none);
    expect(none).toHaveBeenCalledTimes(2);

    const boom = vi.fn(async () => { throw new Error('x'); });
    await expect(cache.load('e', boom)).rejects.toThrow('x');
    await expect(cache.load('e', boom)).rejects.toThrow('x');
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used entry past its size budget', async () => {
    const cache = new RemoteImageCache(12);
    await cache.load('a', async () => '123456');
    await cache.load('b', async () => '1234');
    expect(cache.get('a')).toBe('123456'); // a is now most recent
    await cache.load('c', async () => '12345');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('123456');
  });
});

function fakeClient(caps: string[] | undefined, command: (type: string, payload: unknown) => Promise<unknown>): DaemonClient {
  return { daemonInfo: caps ? { capabilities: caps } : undefined, command } as unknown as DaemonClient;
}

describe('createRemoteImageLoader / fetchRemoteImage', () => {
  const reply = { base64: 'AAAA', mediaType: 'image/png', size: 3 };

  it('asks the thread\'s daemon and returns a data URL, cached across calls', async () => {
    const command = vi.fn(async () => reply);
    const clients = { clientFor: (id: string) => (id === 'd1' ? fakeClient(['file.read'], command) : undefined) };
    const cache = new RemoteImageCache();
    const load = createRemoteImageLoader(clients, cache, 'd1');
    expect(await load('/srv/a.png')).toBe('data:image/png;base64,AAAA');
    expect(await load('/srv/a.png')).toBe('data:image/png;base64,AAAA');
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith('file.read', { path: '/srv/a.png' }, expect.anything());
    expect(await createRemoteImageLoader(clients, cache, 'gone')('/srv/a.png')).toBeUndefined();
  });

  it('degrades without a round trip when the daemon does not advertise file.read', async () => {
    const command = vi.fn();
    const load = createRemoteImageLoader({ clientFor: () => fakeClient(['path.list'], command) }, new RemoteImageCache(), 'd');
    expect(await load('/srv/a.png')).toBeUndefined();
    expect(command).not.toHaveBeenCalled();
  });

  it('degrades when an older daemon answers unknown_command, or refuses the file; connection errors reject', async () => {
    const err = (code: string) => new DaemonCommandError(code as never, 'x');
    expect(await fetchRemoteImage(fakeClient(undefined, async () => { throw err('unknown_command'); }), '/a.png')).toBeUndefined();
    expect(await fetchRemoteImage(fakeClient(undefined, async () => { throw err('not_found'); }), '/a.png')).toBeUndefined();
    await expect(fetchRemoteImage(fakeClient(undefined, async () => { throw err('internal'); }), '/a.png')).rejects.toBeInstanceOf(DaemonCommandError);
  });
});
