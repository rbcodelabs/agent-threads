/**
 * @vitest-environment jsdom
 */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import { renderLocalDaemonPanel, type LocalDaemonPanelDeps } from '../../src/localDaemon/localDaemonPanel';
import type { LocalDaemonSnapshot } from '../../src/localDaemon/controller';
import { snap } from '../helpers/localDaemonSnap';

const flush = () => new Promise((r) => setTimeout(r, 0));
const mount = () => { const el = document.createElement('div'); document.body.appendChild(el); return el; };
const labels = (root: HTMLElement) => [...root.querySelectorAll('button')].map((b) => b.textContent);
const btn = (root: HTMLElement, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const status = (root: HTMLElement) => root.querySelector('.ct-local-daemon-status')?.textContent ?? '';

function make(over: Partial<LocalDaemonPanelDeps>) {
  return {
    isMobile: false,
    pluginVersion: '0.65.0',
    snapshot: vi.fn(async () => snap()),
    subscribe: vi.fn(() => () => undefined),
    confirm: vi.fn(async () => true),
    run: vi.fn(async () => undefined),
    signIn: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(),
    ...over,
  } as unknown as LocalDaemonPanelDeps & { run: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> };
}

describe('panel recovery states', () => {
  it('shows status and Stop / Restart / Kill while the snapshot is still loading', async () => {
    const parent = mount();
    renderLocalDaemonPanel(parent, make({ snapshot: () => new Promise<LocalDaemonSnapshot>(() => undefined) }));
    await flush();
    expect(status(parent)).toContain('Checking');
    expect(labels(parent)).toEqual(['Stop', 'Restart', 'Kill']);
  });

  it('renders the quick snapshot before the full one resolves', async () => {
    const parent = mount();
    renderLocalDaemonPanel(parent, make({
      snapshotQuick: async () => snap({ health: 'down' }),
      snapshot: () => new Promise<LocalDaemonSnapshot>(() => undefined),
    }));
    await flush();
    expect(status(parent)).not.toContain('Checking');
    expect(labels(parent)).toContain('Restart');
    expect(labels(parent)).toContain('Kill');
  });

  it('shows "Can\'t reach the daemon" with the buttons when the snapshot throws', async () => {
    const parent = mount();
    renderLocalDaemonPanel(parent, make({ snapshot: async () => { throw new Error('boom'); } }));
    await flush();
    expect(status(parent)).toContain('Can’t reach the daemon');
    expect(parent.querySelector('.ct-local-daemon-error')?.textContent).toContain('boom');
    expect(labels(parent)).toEqual(['Stop', 'Restart', 'Kill']);
  });

  it('gives up on a snapshot that never resolves and shows the buttons', async () => {
    const parent = mount();
    renderLocalDaemonPanel(parent, make({ snapshotTimeoutMs: 20, snapshot: () => new Promise<LocalDaemonSnapshot>(() => undefined) }));
    await new Promise((r) => setTimeout(r, 60));
    expect(status(parent)).toContain('Can’t reach the daemon');
    expect(parent.querySelector('.ct-local-daemon-error')?.textContent).toContain('did not answer');
    expect(labels(parent)).toEqual(['Stop', 'Restart', 'Kill']);
  });

  it('keeps the quick view and notes it when only the full snapshot fails', async () => {
    const parent = mount();
    renderLocalDaemonPanel(parent, make({ snapshotQuick: async () => snap(), snapshot: async () => { throw new Error('slow probe'); } }));
    await flush();
    await flush();
    expect(status(parent)).toContain('Running');
    expect(parent.querySelector('.ct-local-daemon-error')?.textContent).toContain('slow probe');
  });

  it('Restart and Kill from the unknown state confirm, then run', async () => {
    const parent = mount();
    const d = make({ snapshot: async () => { throw new Error('boom'); } });
    renderLocalDaemonPanel(parent, d);
    await flush();
    btn(parent, 'Restart').click();
    await flush();
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledWith('restart', expect.anything());
    btn(parent, 'Kill').click();
    await flush();
    expect(d.confirm).toHaveBeenCalledTimes(2);
    expect(d.run).toHaveBeenCalledWith('kill', expect.anything());
  });

  it('Stop from the unknown state runs without a confirmation', async () => {
    const parent = mount();
    const d = make({ snapshot: async () => { throw new Error('boom'); } });
    renderLocalDaemonPanel(parent, d);
    await flush();
    btn(parent, 'Stop').click();
    await flush();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.run).toHaveBeenCalledWith('stop', expect.anything());
  });

  it('a degraded (health-down) snapshot offers Restart, Stop and Kill', async () => {
    const parent = mount();
    renderLocalDaemonPanel(parent, make({ snapshot: async () => snap({ health: 'down' }) }));
    await flush();
    expect(labels(parent)).toEqual(expect.arrayContaining(['Restart', 'Stop', 'Kill']));
  });
});
