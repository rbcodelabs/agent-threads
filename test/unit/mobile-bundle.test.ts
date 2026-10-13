/**
 * (Node environment on purpose: esbuild's API refuses to run under jsdom.)
 *
 * The slim Geode-mobile bundle (dist/main.mobile.js): scan rules, and an
 * end-to-end load that mimics Geode's mobile loader. The bundle is built
 * in-memory from the same options as the real build, so this needs no dist/.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import esbuild from 'esbuild';
import { resolve } from 'node:path';
import * as obsidianMock from '../__mocks__/obsidian';
import { ALLOWED_REQUIRES, MAX_BUNDLE_BYTES, scanMobileBundle } from '../../scripts/check-mobile-bundle.mts';
// @ts-expect-error plain .mjs build options shared with esbuild.config.mjs
import { mobileBuildOptions, MOBILE_EXTERNALS } from '../../esbuild.mobile.mjs';

let code = '';

beforeAll(async () => {
  const result = await esbuild.build({
    ...mobileBuildOptions,
    logLevel: 'silent',
    write: false,
    outfile: resolve('dist/main.mobile.js'),
  });
  code = result.outputFiles[0].text;
}, 60_000);

describe('scanMobileBundle', () => {
  it('accepts the allow-listed requires', async () => {
    expect(await scanMobileBundle(`var o=require("obsidian");var s=require('@codemirror/state');`)).toEqual([]);
  });
  it('rejects node builtins and other packages', async () => {
    expect(await scanMobileBundle(`require("fs")`)).toEqual(['forbidden require("fs")']);
    expect(await scanMobileBundle(`require("child_process")`)).toHaveLength(1);
    expect(await scanMobileBundle(`require("electron")`)).toHaveLength(1);
    expect(await scanMobileBundle(`require('@anthropic-ai/claude-agent-sdk')`)).toHaveLength(1);
  });
  it('rejects non-literal requires', async () => {
    expect(await scanMobileBundle(`var n="fs";require(n)`)).toEqual(['non-literal require(n)']);
  });
  it('rejects ESM import/export and dynamic import', async () => {
    expect((await scanMobileBundle(`import x from "obsidian";`)).length).toBeGreaterThan(0);
    expect((await scanMobileBundle(`export const a = 1;`)).length).toBeGreaterThan(0);
    expect((await scanMobileBundle(`async function f(){ return import("qrcode"); }`)).join()).toMatch(/dynamic import/);
    expect((await scanMobileBundle(`const u = import.meta.url;`)).join()).toMatch(/import\.meta/);
  });
  it('enforces the size budget', async () => {
    expect((await scanMobileBundle('var a=1;', MAX_BUNDLE_BYTES + 1))[0]).toMatch(/budget/);
  });
  it('keeps the esbuild externals in sync with the scan allow-list', () => {
    for (const m of MOBILE_EXTERNALS as string[]) expect(ALLOWED_REQUIRES).toContain(m);
  });
});

describe('built main.mobile.js', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes the scan and is far below the 2 MiB budget', async () => {
    expect(await scanMobileBundle(code)).toEqual([]);
    expect(Buffer.byteLength(code)).toBeLessThan(MAX_BUNDLE_BYTES);
  });

  it('contains no desktop-only dependencies', () => {
    for (const marker of ['claude-agent-sdk', 'child_process', 'ModelContextProtocol']) {
      expect(code).not.toContain(marker);
    }
  });

  it('loads like Geode\'s mobile loader and exports a Plugin class that onloads', async () => {
    const requested: string[] = [];
    const shim = (id: string): unknown => {
      requested.push(id);
      if (id === 'obsidian') return obsidianMock;
      if (ALLOWED_REQUIRES.includes(id)) return {};
      throw new Error(`Cannot find module '${id}'`);
    };
    const module = { exports: {} as Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('module', 'exports', 'require', 'fetch', code)(module, module.exports, shim, undefined);

    expect(requested.every((id) => ALLOWED_REQUIRES.includes(id))).toBe(true);
    const PluginClass = module.exports.default as new () => InstanceType<typeof obsidianMock.Plugin> & {
      onload(): Promise<void>;
      app: unknown;
    };
    expect(typeof PluginClass).toBe('function');
    const plugin = new PluginClass();
    expect(plugin).toBeInstanceOf(obsidianMock.Plugin);

    const registered: string[] = [];
    plugin.app = {};
    plugin.addRibbonIcon = () => ({}) as HTMLElement; // mock default needs a DOM
    // The obsidian mock's PluginSettingTab touches `document`; this env has none.
    vi.stubGlobal('document', { createElement: () => ({}) });
    plugin.registerView = (type: string) => { registered.push(`view:${type}`); };
    plugin.registerObsidianProtocolHandler = (action: string) => { registered.push(`protocol:${action}`); };
    plugin.addCommand = (cmd: { id: string }) => { registered.push(`command:${cmd.id}`); };
    await plugin.onload();
    expect(registered).toEqual(
      expect.arrayContaining(['view:claude-threads:mobile', 'protocol:pair', 'command:generate-diagnostics-report']),
    );
  });
});
