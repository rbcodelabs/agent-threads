import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  WEB_VIEWER_FEEDBACK_CONTRACT_VERSIONS,
  WEB_VIEWER_FEEDBACK_SUBMIT_TIMEOUT_MS,
  WEB_VIEWER_FEEDBACK_THREADS_TIMEOUT_MS,
  WEB_VIEWER_NEW_THREAD_ID,
} from '../../src/webViewerFeedback/contract';

const LOCAL_CONTRACT_PATH = path.resolve(__dirname, '../../src/webViewerFeedback/contract.ts');

function resolveGeodeContractPath(): string | null {
  const candidates = [
    process.env.GEODE_CONTRACT_PATH,
    path.resolve(__dirname, '../../../geode/src/web-viewer/feedback-contract.ts'),
    path.join(
      os.homedir(),
      '.geode/worktrees/geode/feat-webviewer-viewport-picker/src/web-viewer/feedback-contract.ts',
    ),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function sha256File(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('webViewerFeedback contract', () => {
  it('exports expected contract v1 constants', () => {
    expect(WEB_VIEWER_FEEDBACK_CONTRACT_VERSIONS).toEqual([1]);
    expect(WEB_VIEWER_FEEDBACK_SUBMIT_TIMEOUT_MS).toBe(15_000);
    expect(WEB_VIEWER_FEEDBACK_THREADS_TIMEOUT_MS).toBe(5_000);
    expect(WEB_VIEWER_NEW_THREAD_ID).toBe('__new__');
  });

  it('contains zero imports so it remains standalone and mobile-safe', () => {
    const source = fs.readFileSync(LOCAL_CONTRACT_PATH, 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it('matches Geode feedback-contract.ts byte-for-byte via SHA-256 when sibling checkout exists', () => {
    expect(fs.existsSync(LOCAL_CONTRACT_PATH)).toBe(true);
    const geodeContractPath = resolveGeodeContractPath();
    if (!geodeContractPath) {
      return;
    }
    expect(sha256File(LOCAL_CONTRACT_PATH)).toBe(sha256File(geodeContractPath));
  });
});
