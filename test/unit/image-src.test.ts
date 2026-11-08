import { describe, it, expect } from 'vitest';
import { FileSystemAdapter } from 'obsidian';
import { resolveImageSrc, vaultResourceUrl } from '../../src/imageSrc';

const appWith = (adapter: unknown) => ({ vault: { adapter } }) as never;
const fsAdapter = (get: (p: string) => string) => Object.assign(new FileSystemAdapter(), { getResourcePath: get });

describe('resolveImageSrc', () => {
  it('uses the resource URL for a path-backed image on desktop', () => {
    const app = appWith(fsAdapter((p) => `app://vault/${p}`));
    expect(resolveImageSrc(app, { path: 'a/b.png', mediaType: 'image/png' }, undefined)).toBe('app://vault/a/b.png');
  });
  it('falls back to inline base64 when there is no path', () => {
    const app = appWith(fsAdapter((p) => p));
    expect(resolveImageSrc(app, { mediaType: 'image/png' }, 'QUJD')).toBe('data:image/png;base64,QUJD');
  });
  it('falls back to base64 off desktop (plain adapter)', () => {
    expect(resolveImageSrc(appWith({}), { path: 'a.png', mediaType: 'image/jpeg' }, 'WFla')).toBe('data:image/jpeg;base64,WFla');
  });
  it('falls back to base64 when getResourcePath throws', () => {
    const app = appWith(fsAdapter(() => { throw new Error('no'); }));
    expect(resolveImageSrc(app, { path: 'a.png', mediaType: 'image/png' }, 'QQ==')).toBe('data:image/png;base64,QQ==');
  });
  it('vaultResourceUrl returns null when unresolvable', () => {
    expect(vaultResourceUrl(appWith({}), 'x.png')).toBeNull();
  });
});
