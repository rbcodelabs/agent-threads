import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_READ_MAX_BYTES } from '../../src/protocol';
import { readImageFile, sniffImageType } from '../../daemon/fileRead';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')]);
const GIF = Buffer.from('GIF89a-data');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);

let base: string;
let ws: string;
let outside: string;
const policy = () => ({ workspaces: [ws], allowBypass: false });
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'file-read-')));
  ws = join(base, 'ws');
  outside = join(base, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('sniffImageType', () => {
  it('recognises the four allowed formats and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffImageType(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('readImageFile', () => {
  it.each([
    ['a.png', PNG, 'image/png'],
    ['a.JPG', JPEG, 'image/jpeg'],
    ['a.jpeg', JPEG, 'image/jpeg'],
    ['a.gif', GIF, 'image/gif'],
    ['a.webp', WEBP, 'image/webp'],
  ])('returns %s as base64 with its media type', (name, bytes, mediaType) => {
    writeFileSync(join(ws, name), bytes);
    const r = readImageFile(join(ws, name), policy());
    expect(r).toEqual({ base64: bytes.toString('base64'), mediaType, size: bytes.length });
  });

  it('serves read-only workspaces too', () => {
    const ro = join(base, 'ro');
    mkdirSync(ro);
    writeFileSync(join(ro, 'x.png'), PNG);
    expect(readImageFile(join(ro, 'x.png'), { workspaces: [ws], readOnlyWorkspaces: [ro], allowBypass: false }).mediaType).toBe('image/png');
  });

  it('refuses a file outside every workspace', () => {
    writeFileSync(join(outside, 'x.png'), PNG);
    expect(() => readImageFile(join(outside, 'x.png'), policy())).toThrow(/image unavailable/);
  });

  it('refuses .. traversal and a sibling folder sharing the workspace prefix', () => {
    writeFileSync(join(outside, 'x.png'), PNG);
    expect(() => readImageFile(join(ws, '..', 'outside', 'x.png'), policy())).toThrow(/image unavailable/);
    const sibling = `${ws}-evil`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'x.png'), PNG);
    expect(() => readImageFile(join(sibling, 'x.png'), policy())).toThrow(/image unavailable/);
  });

  it('refuses a symlink inside the workspace that leads outside it (file and folder)', () => {
    writeFileSync(join(outside, 'secret.png'), PNG);
    symlinkSync(join(outside, 'secret.png'), join(ws, 'link.png'));
    symlinkSync(outside, join(ws, 'dirlink'));
    expect(() => readImageFile(join(ws, 'link.png'), policy())).toThrow(/image unavailable/);
    expect(() => readImageFile(join(ws, 'dirlink', 'secret.png'), policy())).toThrow(/image unavailable/);
  });

  it('follows a symlink that stays inside the workspace', () => {
    writeFileSync(join(ws, 'real.png'), PNG);
    symlinkSync(join(ws, 'real.png'), join(ws, 'alias.png'));
    expect(readImageFile(join(ws, 'alias.png'), policy()).mediaType).toBe('image/png');
  });

  it('refuses a link whose target is not an image name, even inside the workspace', () => {
    writeFileSync(join(ws, 'notes.txt'), PNG);
    symlinkSync(join(ws, 'notes.txt'), join(ws, 'sneaky.png'));
    expect(() => readImageFile(join(ws, 'sneaky.png'), policy())).toThrow(/image unavailable/);
  });

  it('refuses files under .git and .obsidian', () => {
    for (const d of ['.git', '.obsidian']) {
      mkdirSync(join(ws, d, 'sub'), { recursive: true });
      writeFileSync(join(ws, d, 'sub', 'x.png'), PNG);
      expect(() => readImageFile(join(ws, d, 'sub', 'x.png'), policy())).toThrow(/image unavailable/);
    }
  });

  it('refuses svg, other extensions and extension-less files', () => {
    writeFileSync(join(ws, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(ws, 'a.txt'), PNG);
    writeFileSync(join(ws, 'noext'), PNG);
    for (const f of ['a.svg', 'a.txt', 'noext']) expect(() => readImageFile(join(ws, f), policy())).toThrow(/image unavailable/);
  });

  it('refuses an svg named .png and any magic-byte / extension mismatch', () => {
    writeFileSync(join(ws, 'fake.png'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(ws, 'jpeg-as.png'), JPEG);
    writeFileSync(join(ws, 'png-as.gif'), PNG);
    for (const f of ['fake.png', 'jpeg-as.png', 'png-as.gif']) expect(() => readImageFile(join(ws, f), policy())).toThrow(/image unavailable/);
  });

  it('enforces the size cap', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(200)]);
    writeFileSync(join(ws, 'big.png'), big);
    expect(() => readImageFile(join(ws, 'big.png'), policy(), 100)).toThrow(/image unavailable/);
    expect(readImageFile(join(ws, 'big.png'), policy(), big.length).size).toBe(big.length);
    expect(FILE_READ_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('refuses directories, missing files, empty files, relative and odd paths', () => {
    mkdirSync(join(ws, 'dir.png'));
    writeFileSync(join(ws, 'empty.png'), '');
    for (const p of [join(ws, 'dir.png'), join(ws, 'missing.png'), join(ws, 'empty.png'), 'x.png', `${ws}/a\0.png`, '']) {
      expect(() => readImageFile(p, policy())).toThrow(/image unavailable/);
    }
    expect(() => readImageFile(undefined as unknown as string, policy())).toThrow(/image unavailable/);
  });

  it('reports every refusal as not_found so the command cannot probe the disk', () => {
    try { readImageFile(join(outside, 'x.png'), policy()); } catch (e) { expect((e as { code: string }).code).toBe('not_found'); return; }
    throw new Error('expected a throw');
  });
});
