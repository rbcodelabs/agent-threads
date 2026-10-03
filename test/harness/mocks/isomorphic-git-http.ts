/**
 * Stub for `isomorphic-git/http/node` in the Playwright browser harness.
 *
 * gitClient.ts require()s it lazily, but esbuild still resolves the specifier
 * (and its Node-only deps: https, url, querystring) for the browser-platform
 * bundle. The harness never clones or fetches, so any call here is a bug.
 */
export const request = (): never => {
  throw new Error('git over HTTP is unavailable in the screenshot harness');
};
export default { request };
