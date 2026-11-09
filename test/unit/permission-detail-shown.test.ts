/**
 * permission-detail-shown.test.ts
 *
 * isFullyShownDetail: does the one-line summary show EVERYTHING the user would be approving? A request is only
 * approvable inline from a small surface when it does; otherwise it is reviewed in the thread. (Length is not the only
 * way to hide something: a JSON detail with a primary key summarises to that field's value alone.)
 */
import { describe, it, expect } from 'vitest';
import { isFullyShownDetail } from '../../src/permissionDetail';

const json = (o: unknown) => JSON.stringify(o);

describe('isFullyShownDetail', () => {
  it('a single short field is fully shown (primary key or not)', () => {
    expect(isFullyShownDetail(json({ command: 'ls -la' }))).toBe(true);
    expect(isFullyShownDetail(json({ file_path: '/r/a.ts' }))).toBe(true);
    expect(isFullyShownDetail(json({ foo: 'bar' }))).toBe(true); // summary reads "foo: bar"
  });

  it('a second field hides something: command + dangerouslyDisableSandbox', () => {
    expect(isFullyShownDetail(json({ command: 'ls', dangerouslyDisableSandbox: true }))).toBe(false);
  });

  it('a Write with file_path + content hides the content', () => {
    expect(isFullyShownDetail(json({ file_path: '/r/a.ts', content: 'export const x = 1' }))).toBe(false);
  });

  it('multi-field detail with no primary key is only approvable when nothing is cut (but still two fields: not approvable)', () => {
    expect(isFullyShownDetail(json({ a: 1, b: 2 }))).toBe(false);
  });

  it('a single field longer than the summary cap is truncated: not fully shown', () => {
    expect(isFullyShownDetail(json({ command: `echo ${'x'.repeat(200)}` }))).toBe(false);
  });

  it('non-JSON text: fully shown when short, not when cut, multi-line text is compared on its flattened form', () => {
    expect(isFullyShownDetail('npm run deploy --prod')).toBe(true);
    expect(isFullyShownDetail('x'.repeat(300))).toBe(false);
    expect(isFullyShownDetail('line one\nline two')).toBe(true);
    expect(isFullyShownDetail(`line one\n${'y'.repeat(300)}`)).toBe(false);
  });

  it('empty or {} has nothing to hide', () => {
    expect(isFullyShownDetail('')).toBe(true);
    expect(isFullyShownDetail('{}')).toBe(true);
  });

  it('host_exec for a remote thread: command only is fully shown; any extra field is not', () => {
    expect(isFullyShownDetail(`Run host_exec for a remote thread: ${json({ command: 'git status' })}`)).toBe(true);
    expect(isFullyShownDetail(`Run host_exec for a remote thread: ${json({ command: 'git status', cwd: '/etc' })}`)).toBe(false);
    expect(isFullyShownDetail(`Run host_exec for a remote thread: ${json({ command: `echo ${'z'.repeat(200)}` })}`)).toBe(false);
  });

  it('an array / scalar JSON is plain text', () => {
    expect(isFullyShownDetail('[1,2,3]')).toBe(true);
  });
});
