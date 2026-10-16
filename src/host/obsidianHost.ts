/**
 * Plugin-side implementations of the `src/host/` seams, backed by Obsidian
 * (and Geode's Obsidian-compatible shim). This is the only file under
 * `src/host/` allowed to import `obsidian`; it is deliberately outside the core
 * closure (see scripts/core-closure.mts).
 */
import { parseYaml, requestUrl } from 'obsidian';
import type { HttpFetch } from './HttpFetch';
import type { YamlParser } from './YamlParser';

export const obsidianYamlParser: YamlParser = {
  parse: (text) => parseYaml(text),
};

export const obsidianHttpFetch: HttpFetch = {
  get: (url, options) =>
    requestUrl({
      url,
      method: 'GET',
      ...(options?.throw === undefined ? {} : { throw: options.throw }),
    }),
};
