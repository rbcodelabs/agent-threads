/**
 * "Is it safe to restart?" Idle means: no turn in flight, nothing waiting on a human (permission, question, plan,
 * elicitation), no host-tool call in flight, and nothing has happened for `quietMs`. Anything busy, and any session
 * activity or client command since the last look, restarts the quiet window.
 *
 * Not detected: a client command that is mid-flight asynchronously (for example a long `repos.sync` waiting on git).
 * Most commands are handled synchronously on the event loop, so the check and the shutdown cannot interleave with one.
 */
export interface ActivitySource {
  activity(): { busy: string[]; lastActivityAt: number };
}

export interface IdleVerdict {
  idle: boolean;
  busyThreads: number;
  quietRemainingMs: number;
}

export class IdleGate {
  private lastBusyAt = 0;

  constructor(private readonly source: ActivitySource, private readonly quietMs: number, private readonly now: () => number = Date.now) {}

  evaluate(): IdleVerdict {
    const { busy, lastActivityAt } = this.source.activity();
    const at = this.now();
    if (busy.length > 0) this.lastBusyAt = at;
    const quietFor = at - Math.max(lastActivityAt, this.lastBusyAt);
    const quietRemainingMs = Math.max(0, this.quietMs - quietFor);
    return { idle: busy.length === 0 && quietRemainingMs === 0, busyThreads: busy.length, quietRemainingMs };
  }
}
