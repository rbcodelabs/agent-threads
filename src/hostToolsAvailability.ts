/**
 * Settings, MCP: the "Available on" control of a server that runs on THIS computer and is proxied to a daemon
 * (an OAuth server or a Google Workspace service). One checkbox per daemon, reading and writing that daemon's
 * `hostTools` through `hostToolsChecklist.ts`, the same data the daemon editor's checklist uses.
 */
import type { RemoteDaemonConfig } from './types';
import { isServerOn, setServerAvailable } from './hostToolsChecklist';

export interface AvailabilityHost {
  daemons(): readonly RemoteDaemonConfig[];
  /** Persist and make the daemon registry re-read its configs, as the daemon editor's Save does. */
  save(): Promise<void>;
}

export const PROXIED_SERVER_COPY =
  'Runs on this computer and is proxied to the daemon. This computer must be online with the app open. '
  + 'Anything that changes something still asks for approval here. Applies to new threads.';

/** Renders nothing when there is no daemon to offer it to. Redraws itself after a change. */
export function renderHostToolsAvailability(parent: HTMLElement, host: AvailabilityHost, server: string, opts: { unavailableReason?: string } = {}): void {
  if (host.daemons().length === 0) return;
  const wrap = parent.createDiv({ cls: 'ct-mcp-runson ct-mcp-available', attr: { role: 'group', 'aria-label': `Where ${server} is available` } });
  const draw = (): void => {
    wrap.empty();
    wrap.createSpan({ cls: 'ct-mcp-runson-label', text: 'Available on' });
    wrap.createSpan({ cls: 'ct-mcp-runson-local', text: 'This computer' });
    for (const d of host.daemons()) {
      const on = isServerOn(d.hostTools, server);
      const line = wrap.createDiv({ cls: 'ct-mcp-runson-row' });
      const label = line.createEl('label', { cls: 'ct-mcp-runson-toggle' });
      const box = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': `Make ${server} available on ${d.name}` } });
      box.checked = on;
      // A server that needs to sign in again cannot serve a daemon; a daemon that already has it can still turn it off.
      const blocked = !on && opts.unavailableReason !== undefined;
      box.disabled = blocked;
      if (blocked) label.addClass('is-disabled');
      label.createSpan({ text: d.name });
      const set = (want: boolean): void => {
        void (async () => {
          const next = setServerAvailable(d.hostTools, server, want);
          if (next) d.hostTools = next; else delete d.hostTools;
          await host.save();
          draw();
        })();
      };
      box.addEventListener('change', () => set(box.checked));
      if (blocked) {
        line.createSpan({ cls: 'ct-mcp-available-missing', text: opts.unavailableReason! });
      } else if (!on) {
        line.createSpan({ cls: 'ct-mcp-available-missing', text: `Not available on ${d.name}. Tick to turn on.` });
      } else {
        line.createSpan({ cls: 'ct-mcp-runson-chip ct-mcp-runson-chip--ok', text: 'Available' });
      }
    }
    wrap.createDiv({ cls: 'ct-mcp-runson-reason', text: PROXIED_SERVER_COPY });
  };
  draw();
}
