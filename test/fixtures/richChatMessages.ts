/**
 * Rich ChatMessage fixture set shared by the message-rendering golden tests.
 *
 * It deliberately touches every feature the conversation renderers handle so a
 * refactor that moves rendering code can be checked against recorded output:
 * GFM (table, code, lists, task list, quote), wikilinks, vault markdown links,
 * absolute vault paths, bridge paths, local and remote images, a visualize
 * marker, a contributed message-content marker, grouped and ungrouped tool
 * calls, tool-result images, notice rows, a compact divider, consecutive
 * assistant messages and a user message with URLs and image thumbnails.
 *
 * Paths use a synthetic vault root so the goldens never contain private data.
 */
import type { ChatMessage } from '../../src/types';
import { formatMessageContentReference } from '../../src/MessageContent';

export const FIXTURE_VAULT_ROOT = '/Users/test/Vault';
export const FIXTURE_BRIDGE_REPO = '/Users/test/repo';
/** Vault files that exist in the fixture vault (everything else is "missing"). */
export const FIXTURE_VAULT_FILES = [
  'Project Plan.md',
  'folder/Deep Note.md',
  'docs/design.md',
  'Notes/abs.md',
  'Bridge/src/index.ts',
];

export const CONTENT_REF = { providerId: 'example.cards', id: 'card-1', schemaVersion: 1, title: 'Reference card', data: {} } as const;

export const RICH_MARKDOWN = [
  '# Status report',
  '',
  'Intro with **bold**, _emphasis_ and `inline code`, a [[Project Plan]] wikilink and an [[folder/Deep Note|Aliased note]].',
  '',
  '| Column A | Column B |',
  '| --- | --- |',
  '| 1 | two |',
  '| 3 | four |',
  '',
  '- bullet one',
  '- [x] finished task',
  '- [ ] open task',
  '',
  '1. first',
  '2. second',
  '',
  '```ts',
  'const url = "https://in-code.example.com/block";',
  '```',
  '',
  '> quoted line',
  '',
  'Links: [design](docs/design.md#Overview), [abs](/Users/test/Vault/Notes/abs.md#Heading%20One), [outside](/Users/elsewhere/secret.txt), [site](https://example.com/page), [mail](mailto:a@b.co), [anchor](#top).',
  '',
  `Bridge path ${FIXTURE_BRIDGE_REPO}/src/index.ts exists, ${FIXTURE_BRIDGE_REPO}/src/missing.ts does not. Bare https://bare.example.com/x and \`https://code.example.com/inline\`.`,
  '',
  '![remote image](https://example.com/pic.png)',
  '![local image](/Users/test/pic.png)',
  '',
  'visualize{"path":"/tmp/viz/chart.html","title":"Chart"}',
  '',
  formatMessageContentReference(CONTENT_REF),
].join('\n');

const PNG = 'iVBORw0KGgo=';

export const RICH_MESSAGES: ChatMessage[] = [
  {
    id: 'u1', role: 'user', timestamp: 1_700_000_000_000,
    content: 'Please review https://user.example.com/page?x=1 and the notes.',
    images: [{ name: 'shot.png', mediaType: 'image/png', base64: PNG }],
  },
  {
    id: 'a1', role: 'assistant', timestamp: 1_700_000_001_000, cost: 0.0123,
    content: RICH_MARKDOWN,
    toolCalls: [
      { name: 'Read', summary: 'Read: /Users/test/Vault/Notes/a.md', timestamp: 1_700_000_000_500, toolUseId: 't1', status: 'success', durationMs: 120 },
      { name: 'Read', summary: 'Read: /Users/test/Vault/Notes/b.md', timestamp: 1_700_000_000_600, toolUseId: 't2', status: 'success', durationMs: 90 },
      { name: 'Grep', summary: 'Grep: TODO', timestamp: 1_700_000_000_700, toolUseId: 't3', status: 'error', durationMs: 30 },
    ],
  },
  {
    id: 'a2', role: 'assistant', timestamp: 1_700_000_002_000, content: '',
    toolCalls: [{ name: 'Bash', summary: 'Bash: npm test', timestamp: 1_700_000_001_900, toolUseId: 't4', status: 'success', durationMs: 4000 }],
    toolResultImages: [{ mediaType: 'image/png', data: PNG }],
  },
  { id: 'a3', role: 'assistant', timestamp: 1_700_000_003_000, content: 'Follow-up assistant message with a [[Project Plan]] link.' },
  { id: 'c1', role: 'compact', timestamp: 1_700_000_004_000, content: '', compactTrigger: 'auto', preTokens: 123_456 },
  { id: 'n1', role: 'notice', timestamp: 1_700_000_005_000, content: 'Background task "build" completed', noticeStatus: 'completed' },
  { id: 'n2', role: 'notice', timestamp: 1_700_000_006_000, content: 'Background task "lint" failed', noticeStatus: 'failed' },
];

/** A partial, still-streaming assistant turn: open table, an unfinished marker and bold. */
export const STREAMING_PARTIAL = [
  'Partial **bold** with a [[Project Plan]] link and a table so far',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  'visualize{"pa',
].join('\n');
