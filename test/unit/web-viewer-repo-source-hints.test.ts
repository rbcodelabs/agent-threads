import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findRepoSourceHints,
  isUtilityCssClass,
} from '../../src/webViewerFeedback/repoSourceHints';
import { makeValidSelection } from './helpers/webViewerFeedbackFixtures';

const createdDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function writeRepoFile(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

afterEach(() => {
  vi.restoreAllMocks();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe('findRepoSourceHints', () => {
  it('immediately returns [] without touching fs when isRemoteThread is true or cwd is empty', async () => {
    const realpathSpy = vi.spyOn(fs.promises, 'realpath');

    const remoteHints = await findRepoSourceHints({
      cwd: '/remote/daemon/workspace',
      isRemoteThread: true,
      selection: makeValidSelection(),
    });
    expect(remoteHints).toEqual([]);
    expect(realpathSpy).not.toHaveBeenCalled();

    const emptyCwdHints = await findRepoSourceHints({
      cwd: '',
      isRemoteThread: false,
      selection: makeValidSelection(),
    });
    expect(emptyCwdHints).toEqual([]);
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('respects an aborted AbortSignal immediately', async () => {
    const repo = createTempDir('wv-hints-abort-');
    writeRepoFile(
      repo,
      'src/components/PayButton.tsx',
      'export const PayButton = () => <button id="pay-invoice-btn">Pay invoice</button>;\n',
    );
    const controller = new AbortController();
    controller.abort();

    const hints = await findRepoSourceHints({
      cwd: repo,
      isRemoteThread: false,
      selection: makeValidSelection(),
      signal: controller.signal,
    });
    expect(hints).toEqual([]);
  });

  it('locates Next.js route + React component by data-testid, #id, and text while down-ranking test/story files', async () => {
    const repo = createTempDir('wv-hints-nextjs-');

    // Real Next.js App Router page on line 6
    writeRepoFile(
      repo,
      'src/app/billing/invoices/page.tsx',
      [
        "import { InvoicePayButton } from '@/components/InvoicePayButton';",
        '',
        'export default function InvoicesPage() {',
        '  return (',
        '    <main className="billing-shell">',
        '      <button id="pay-invoice-btn" data-testid="pay-btn" className="flex px-4 py-2 invoice-pay">Pay invoice</button>',
        '    </main>',
        '  );',
        '}',
      ].join('\n'),
    );

    // Reusable component matching data-testid on line 4
    writeRepoFile(
      repo,
      'src/components/InvoicePayButton.tsx',
      [
        'export function InvoicePayButton() {',
        '  return (',
        '    <div className="actions-row">',
        '      <button data-testid="pay-btn" className="invoice-pay">Pay invoice</button>',
        '    </div>',
        '  );',
        '}',
      ].join('\n'),
    );

    // Matching unit test + story files that must be down-ranked below real implementation files
    writeRepoFile(
      repo,
      'src/components/InvoicePayButton.test.tsx',
      'const html = \'<button id="pay-invoice-btn" data-testid="pay-btn">Pay invoice</button>\';\n',
    );
    writeRepoFile(
      repo,
      'src/components/__tests__/invoices.spec.tsx',
      'const html = \'<button id="pay-invoice-btn" data-testid="pay-btn">Pay invoice</button>\';\n',
    );

    // Ignored directories that must never be returned
    writeRepoFile(
      repo,
      'node_modules/pkg/index.js',
      '<button id="pay-invoice-btn" data-testid="pay-btn">Pay invoice</button>',
    );
    writeRepoFile(
      repo,
      '.next/server/app/billing/invoices/page.js',
      '<button id="pay-invoice-btn" data-testid="pay-btn">Pay invoice</button>',
    );

    const hints = await findRepoSourceHints({
      cwd: repo,
      isRemoteThread: false,
      selection: makeValidSelection(),
      maxWallMs: 2000,
    });

    expect(hints.length).toBeGreaterThanOrEqual(2);
    expect(hints.length).toBeLessThanOrEqual(3);

    // Top hit should be the route + id + data-testid page at line 6
    expect(hints[0]).toMatchObject({
      relativePath: 'src/app/billing/invoices/page.tsx',
      line: 6,
      confidence: 'high',
    });

    // Second hit should be the real component at line 4, ahead of .test.tsx and __tests__
    expect(hints[1]).toMatchObject({
      relativePath: 'src/components/InvoicePayButton.tsx',
      line: 4,
      confidence: 'high',
    });

    for (const h of hints) {
      expect(path.isAbsolute(h.relativePath)).toBe(false);
      expect(h.relativePath).not.toContain('\\');
      expect(h.relativePath).not.toContain('node_modules');
      expect(h.relativePath).not.toContain('.next');
      // Reason must never echo raw Origin-G page literals
      expect(h.reason).not.toContain('pay-invoice-btn');
      expect(h.reason).not.toContain('Pay invoice');
    }
  });

  it('skips symlinks pointing outside the repository root and binary files with NUL bytes', async () => {
    const repo = createTempDir('wv-hints-inside-');
    const outside = createTempDir('wv-hints-outside-');

    writeRepoFile(
      outside,
      'SecretComponent.tsx',
      '<button id="pay-invoice-btn" data-testid="pay-btn">Pay invoice</button>\n',
    );
    writeRepoFile(
      repo,
      'src/components/SafeButton.tsx',
      '<button id="pay-invoice-btn">Pay invoice</button>\n',
    );

    // Symlinked file and symlinked dir escaping realRoot
    fs.symlinkSync(
      path.join(outside, 'SecretComponent.tsx'),
      path.join(repo, 'src/components/EscapedFile.tsx'),
    );
    fs.symlinkSync(outside, path.join(repo, 'src/escaped-dir'));

    // Binary file disguised with .tsx extension containing NUL byte
    const binPath = path.join(repo, 'src/components/Binary.tsx');
    fs.writeFileSync(
      binPath,
      Buffer.from('const x = "<button data-testid=\\"pay-btn\\">";\0binary', 'utf8'),
    );

    const hints = await findRepoSourceHints({
      cwd: repo,
      isRemoteThread: false,
      selection: makeValidSelection(),
      maxWallMs: 2000,
    });

    expect(hints).toHaveLength(1);
    expect(hints[0].relativePath).toBe('src/components/SafeButton.tsx');
    expect(hints[0].line).toBe(1);
  });

  it('filters common Tailwind utility classes while retaining semantic CSS classes', () => {
    expect(isUtilityCssClass('flex')).toBe(true);
    expect(isUtilityCssClass('items-center')).toBe(true);
    expect(isUtilityCssClass('justify-between')).toBe(true);
    expect(isUtilityCssClass('px-4')).toBe(true);
    expect(isUtilityCssClass('sm:grid-cols-2')).toBe(true);
    expect(isUtilityCssClass('dark:hover:bg-slate-800')).toBe(true);
    expect(isUtilityCssClass('rounded-lg')).toBe(true);

    expect(isUtilityCssClass('invoice-card')).toBe(false);
    expect(isUtilityCssClass('BillingHeader')).toBe(false);
    expect(isUtilityCssClass('hero-cta-primary')).toBe(false);
  });
});
