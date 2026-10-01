/**
 * Owns every agent browser guest, and is the only thing allowed to create or
 * destroy one.
 *
 * Funnelling creation through a single `admit()` is the design's load-bearing
 * choice. The problem this feature exists to fix was not that browsers are hard
 * to drive — it was that nothing counted them, nothing reclaimed them, and
 * nothing refused to start one more when the machine was already out of
 * headroom. A second creation path would quietly reintroduce all three.
 */

import {
  CRASH_BREAKER_COOLDOWN_MS,
  CRASH_BREAKER_THRESHOLD,
  CRASH_BREAKER_WINDOW_MS,
  HARD_TTL_MS,
  IDLE_REAP_MS,
  MAX_CREATES_PER_MINUTE,
  MIN_CREATE_INTERVAL_MS,
  REAPER_TICK_MS,
  clampMaxGuests,
  type UrlPolicyOptions,
} from './agentBrowserPolicy';
import { AgentBrowserError } from './agentBrowserErrors';
import { AgentBrowserHost } from './agentBrowserHost';
import {
  AgentBrowserGuest,
  type GuestEndReason,
  type GuestFacts,
} from './AgentBrowserGuest';
import { createFdGate, type FdGate } from './fdGate';

/**
 * The partition agent guests run in.
 *
 * Deliberately NOT `persist:webviewer`. Geode force-injects its bridge preload
 * (`window.__geode.postEvent`) into every guest in that partition, so putting an
 * agent-driven, attacker-navigable page there would hand a hostile site the
 * host's event bridge. It is also the jar the user's imported Chrome cookies
 * land in. Sharing that session is a real feature request, but it needs a
 * main-process scoped cookie copy, not a partition swap — see gap G5.
 */
export const AGENT_BROWSER_PARTITION = 'persist:agent-browser';

export interface AgentBrowserPoolOptions {
  doc: Document;
  /** Source of `geode.getFdPressure`. Usually `window`. */
  hostWindow: unknown;
  getMaxGuests: () => number;
  getUrlPolicy: () => UrlPolicyOptions;
  /** User-visible message for refusals the agent cannot explain on its own. */
  notify?: (message: string) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  now?: () => number;
  partition?: string;
}

export interface PoolStatus {
  inUse: number;
  max: number;
  fdBlocked: boolean;
  fdAvailable: boolean;
  guests: GuestFacts[];
}

/**
 * Which per-thread map a guest belongs to. The MCP tool surface (`peek()`/
 * `acquire()`) only ever sees `'primary'`; `'login'` is the ADR-0014
 * take-control guest, UI-only, with no MCP visibility at all.
 */
type GuestRole = 'primary' | 'login';

/** One lifecycle transition, for the status UI and leak audits. */
export interface PoolEvent {
  at: number;
  kind: 'create' | 'destroy' | 'died';
  threadId: string;
  reason?: GuestEndReason;
  code?: string;
}

/**
 * Lifecycle history is bounded, matching how Geode bounds its own guest
 * diagnostics. The point of the ring is to make "creates and destroys balance"
 * checkable at a glance; keeping it unbounded would make a leak-detection aid
 * into its own slow leak.
 */
const MAX_EVENTS = 50;

interface CrashRecord {
  /** Timestamps of recent deaths, pruned to the breaker window. */
  at: number[];
  cooldownUntil: number;
}

export class AgentBrowserPool {
  private readonly doc: Document;
  private readonly host: AgentBrowserHost;
  private readonly fdGate: FdGate;
  private readonly getMaxGuests: () => number;
  private readonly getUrlPolicy: () => UrlPolicyOptions;
  private readonly notify: (message: string) => void;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly partition: string;

  private readonly guests = new Map<string, AgentBrowserGuest>();
  /**
   * The login-handoff role (ADR-0014): at most one per thread, created only in
   * response to a user accepting a denied `window.open()` popup. Kept as a
   * second map rather than folded into `guests` so `peek()`/`acquire()` — the
   * MCP tool surface — can never see or return one; the login guest has no MCP
   * surface at all, it is UI-only.
   */
  private readonly loginGuests = new Map<string, AgentBrowserGuest>();
  private readonly crashes = new Map<string, CrashRecord>();
  private readonly events: PoolEvent[] = [];
  /** Creation timestamps, pruned to one minute, for the rate limiter. */
  private createTimes: number[] = [];
  private lastCreateAt = 0;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  /** In-flight creations, so two concurrent calls cannot both pass the cap. */
  private readonly creating = new Map<string, Promise<AgentBrowserGuest>>();
  /** In-flight login-guest creations, mirroring `creating` for the login role. */
  private readonly creatingLogin = new Map<string, Promise<AgentBrowserGuest>>();

  constructor(options: AgentBrowserPoolOptions) {
    this.doc = options.doc;
    this.getMaxGuests = options.getMaxGuests;
    this.getUrlPolicy = options.getUrlPolicy;
    this.notify = options.notify ?? (() => {});
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.partition = options.partition ?? AGENT_BROWSER_PARTITION;
    // Share the pool's clock so the gate's cache expires on the same timeline
    // the reaper and TTLs use, rather than drifting against wall time.
    this.fdGate = createFdGate(options.hostWindow, this.now);
    this.host = new AgentBrowserHost(options.doc, {
      onDetached: () => this.handleHostDetached(),
    });
  }

  /** True when the host can support guests at all (Geode desktop with diagnostics). */
  get capable(): boolean {
    return this.fdGate.available;
  }

  start(): void {
    if (this.destroyed || this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      void this.tick();
    }, REAPER_TICK_MS);
  }

  status(): PoolStatus {
    return {
      inUse: this.guests.size,
      max: clampMaxGuests(this.getMaxGuests()),
      fdBlocked: this.fdGate.isBlocked,
      fdAvailable: this.fdGate.available,
      guests: [...this.guests.values()].map((guest) => guest.facts()),
    };
  }

  /** The live guest for a thread, or null. Never creates. */
  peek(threadId: string): AgentBrowserGuest | null {
    return this.guests.get(threadId) ?? null;
  }

  /** The live login-handoff guest for a thread, or null. Never creates. UI-only — no MCP tool sees this. */
  peekLoginGuest(threadId: string): AgentBrowserGuest | null {
    return this.loginGuests.get(threadId) ?? null;
  }

  /**
   * Resolve a denied `window.open()`'s `guestId` (a `getWebContentsId()` value)
   * back to the thread whose *primary* guest requested it.
   *
   * Only ever scans `guests` — a login guest can never itself open a further
   * popup as far as this lookup is concerned (ADR-0014's one-hop assumption).
   */
  findPrimaryByWebContentsId(webContentsId: number): string | null {
    for (const [threadId, guest] of this.guests) {
      const el = guest.element;
      if (!el) continue;
      try {
        if (el.getWebContentsId() === webContentsId) return threadId;
      } catch {
        continue; // guest is mid-teardown; not a match
      }
    }
    return null;
  }

  /** Resolve an `agent-browser-window-close`/`-focus` `guestId` to its owning thread's login guest. */
  findLoginByWebContentsId(webContentsId: number): string | null {
    for (const [threadId, guest] of this.loginGuests) {
      const el = guest.element;
      if (!el) continue;
      try {
        if (el.getWebContentsId() === webContentsId) return threadId;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * The guest that was used most recently.
   *
   * The preview pane shows one guest at a time, and "the one that just did
   * something" is almost always the one worth watching — an agent working a page
   * produces a steady stream of operations, so this follows the active session
   * without the user having to pick a thread.
   */
  mostRecentlyUsed(): AgentBrowserGuest | null {
    let best: AgentBrowserGuest | null = null;
    for (const guest of this.guests.values()) {
      if (!guest.isAlive()) continue;
      if (!best || guest.idleMs < best.idleMs) best = guest;
    }
    return best;
  }

  /** Most recent lifecycle transitions, oldest first. */
  recentEvents(): readonly PoolEvent[] {
    return this.events;
  }

  private record(event: PoolEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  // ── Acquisition ────────────────────────────────────────────────────────────

  /**
   * Return this thread's guest, creating one if needed.
   *
   * Re-creation after a death is lazy by design. Geode's Web Viewer eagerly
   * reloads a crashed guest because a user is staring at a blank pane; here
   * nobody is watching, and eagerly respawning against a page that reliably kills
   * its renderer is how a crash becomes a spawn loop.
   */
  async acquire(threadId: string): Promise<AgentBrowserGuest> {
    if (this.destroyed) {
      throw new AgentBrowserError({
        code: 'capability_unavailable',
        message: 'The agent browser has been shut down.',
        retryable: false,
      });
    }

    const existing = this.guests.get(threadId);
    if (existing) {
      if (existing.isAlive() && !existing.budgetExhausted()) return existing;
      // Dead, detached, or spent: reclaim before considering a replacement, so
      // the slot is free when admission runs.
      const reason: GuestEndReason = existing.budgetExhausted() ? 'budget' : 'crash';
      this.retire(threadId, reason);
    }

    const inFlight = this.creating.get(threadId);
    if (inFlight) return inFlight;

    const creation = this.create(threadId).finally(() => {
      this.creating.delete(threadId);
    });
    this.creating.set(threadId, creation);
    return creation;
  }

  /**
   * Acquire this thread's login-handoff guest, creating it and navigating it to
   * `url` if needed.
   *
   * Routes through the exact same `admit()` gate as `acquire()` (ADR-0014 §3) —
   * this is a second *role*, not a second creation path. Never touches
   * `guests`: `peek()`/`acquire()` (the MCP tool surface) cannot see or return
   * what this method produces.
   *
   * Reusing a live login guest re-navigates it to `url` rather than creating a
   * second one — the design assumes at most one login guest per thread at a
   * time (ADR-0014's Limitations: one hop from opener to login guest).
   */
  async acquireLoginGuest(threadId: string, url: string): Promise<AgentBrowserGuest> {
    if (this.destroyed) {
      throw new AgentBrowserError({
        code: 'capability_unavailable',
        message: 'The agent browser has been shut down.',
        retryable: false,
      });
    }

    const existing = this.loginGuests.get(threadId);
    if (existing && existing.isAlive()) {
      await existing.navigate(url);
      return existing;
    }
    if (existing) this.retireLogin(threadId, 'crash');

    const inFlight = this.creatingLogin.get(threadId);
    if (inFlight) return inFlight;

    const creation = this.createLoginGuest(threadId, url).finally(() => {
      this.creatingLogin.delete(threadId);
    });
    this.creatingLogin.set(threadId, creation);
    return creation;
  }

  /** Reclaim a thread's login-handoff guest. Safe to call when none exists. */
  releaseLoginGuest(threadId: string, reason: GuestEndReason = 'login-complete'): void {
    this.retireLogin(threadId, reason);
  }

  private async createLoginGuest(threadId: string, url: string): Promise<AgentBrowserGuest> {
    const guest = await this.createGuest(threadId, 'login');
    try {
      // Same evaluateUrl() every other navigation goes through (via
      // AgentBrowserGuest.navigate), applied against this thread's own
      // urlPolicy — a second, independent check beyond whatever reason Geode's
      // own scheme/host rules already denied the popup for.
      await guest.navigate(url);
    } catch (error) {
      this.retireLogin(threadId, 'crash');
      throw error;
    }
    return guest;
  }

  private create(threadId: string): Promise<AgentBrowserGuest> {
    return this.createGuest(threadId, 'primary');
  }

  /**
   * Build and register a guest under either role.
   *
   * The one thing this must never do is duplicate `admit()` — both roles pass
   * through the identical gate (crash cooldown, create rate limit, cap, FD
   * pressure), just against a role-specific map for bookkeeping.
   */
  private async createGuest(threadId: string, role: GuestRole): Promise<AgentBrowserGuest> {
    await this.admit(threadId);

    const map = this.mapFor(role);
    const container = this.host.ensure();
    const guest = new AgentBrowserGuest({
      threadId,
      container,
      doc: this.doc,
      partition: this.partition,
      urlPolicy: this.getUrlPolicy(),
      now: this.now,
      onDied: (reason, error) => this.handleGuestDied(threadId, role, reason, error),
      // Screenshots need the container composited, which it is not while parked
      // off-screen. Routed through the host so overlapping captures from
      // different guests reference-count rather than fight over the style.
      captureSurface: {
        begin: () => this.host.beginCapture(),
        end: () => this.host.endCapture(),
      },
    });

    // Record the attempt before awaiting: a guest that dies during start still
    // consumed a process slot and must count against the rate limiter.
    const at = this.now();
    this.createTimes.push(at);
    this.lastCreateAt = at;
    map.set(threadId, guest);
    this.log(`agent-browser: create${role === 'login' ? ' (login)' : ''}`, {
      threadId,
      inUse: this.guests.size,
      loginInUse: this.loginGuests.size,
    });
    this.record({ at, kind: 'create', threadId });

    try {
      await guest.start();
    } catch (error) {
      map.delete(threadId);
      throw error;
    }
    return guest;
  }

  private mapFor(role: GuestRole): Map<string, AgentBrowserGuest> {
    return role === 'login' ? this.loginGuests : this.guests;
  }

  /**
   * The single gate every guest passes through.
   *
   * Order matters: cheap local checks first, and the FD probe last, because it is
   * the only one that costs an IPC round trip.
   */
  private async admit(threadId: string): Promise<void> {
    if (!this.fdGate.available) {
      throw new AgentBrowserError({
        code: 'capability_unavailable',
        message:
          'The agent browser needs a host that reports process diagnostics. ' +
          'It is available on Geode desktop only.',
        retryable: false,
      });
    }

    const now = this.now();

    const crash = this.crashes.get(threadId);
    if (crash && crash.cooldownUntil > now) {
      const seconds = Math.ceil((crash.cooldownUntil - now) / 1000);
      throw new AgentBrowserError({
        code: 'crash_cooldown',
        message:
          `This page has repeatedly crashed the browser process. Browser ` +
          `automation for this thread is paused for another ${seconds}s.`,
        retryable: false,
      });
    }

    if (now - this.lastCreateAt < MIN_CREATE_INTERVAL_MS) {
      throw new AgentBrowserError({
        code: 'create_rate_limited',
        message: 'Browser sessions are being created too quickly. Wait a moment and retry.',
        retryable: true,
      });
    }
    this.createTimes = this.createTimes.filter((t) => now - t < 60_000);
    if (this.createTimes.length >= MAX_CREATES_PER_MINUTE) {
      throw new AgentBrowserError({
        code: 'create_rate_limited',
        message:
          `More than ${MAX_CREATES_PER_MINUTE} browser sessions were started in the ` +
          `last minute. Creation is paused briefly to avoid exhausting system resources.`,
        retryable: true,
      });
    }

    const max = clampMaxGuests(this.getMaxGuests());
    // A login guest counts against the same shared ceiling as a primary guest
    // (ADR-0014 §3): it is rare, human-paced, and short-lived, so in practice
    // it is essentially never refused — but under genuine resource pressure it
    // is refused exactly like any other guest creation, not given a bypass.
    if (this.guests.size + this.loginGuests.size >= max) {
      // Try to make room from genuinely idle guests before refusing.
      this.reapIdle();
      if (this.guests.size + this.loginGuests.size >= max) {
        const holders = [...this.guests.keys()];
        throw new AgentBrowserError({
          code: 'admission_denied_cap',
          message:
            `All ${max} browser sessions are in use (threads: ${holders.join(', ')}).`,
          retryable: true,
          hint: 'Close a browser session with browser_close, or wait for one to be released.',
        });
      }
    }

    const verdict = await this.fdGate.evaluate();
    if (verdict.kind === 'deny-exhausted') {
      // Descriptors are gone. The agent's browser is discretionary; the user's
      // editor and Web Viewer are not, so the discretionary processes go first.
      this.destroyAll('fd');
      this.notify('Agent browser stopped: the app is out of file handles.');
      throw new AgentBrowserError({
        code: 'admission_denied_fd_pressure',
        message: verdict.reason,
        retryable: false,
      });
    }
    if (verdict.kind === 'deny-pressure') {
      this.reapIdle();
      this.notify('Agent browser paused: the app is low on file handles.');
      throw new AgentBrowserError({
        code: 'admission_denied_fd_pressure',
        message: verdict.reason,
        retryable: true,
      });
    }
  }

  // ── Reclamation ────────────────────────────────────────────────────────────

  /** Remove a primary guest from the registry and destroy it. Safe to call repeatedly. */
  private retire(threadId: string, reason: GuestEndReason): void {
    this.retireFrom(this.guests, threadId, reason, 'primary');
  }

  /** Remove a login-handoff guest from the registry and destroy it. Safe to call repeatedly. */
  private retireLogin(threadId: string, reason: GuestEndReason): void {
    this.retireFrom(this.loginGuests, threadId, reason, 'login');
  }

  private retireFrom(
    map: Map<string, AgentBrowserGuest>,
    threadId: string,
    reason: GuestEndReason,
    role: GuestRole,
  ): void {
    const guest = map.get(threadId);
    if (!guest) return;
    map.delete(threadId);
    guest.destroy(reason);
    this.log(`agent-browser: destroy${role === 'login' ? ' (login)' : ''}`, {
      threadId,
      reason,
      inUse: this.guests.size,
      loginInUse: this.loginGuests.size,
    });
    this.record({ at: this.now(), kind: 'destroy', threadId, reason });
  }

  /** Public reclaim for one thread's primary guest — delete, archive, or an explicit close. */
  destroyForThread(threadId: string, reason: GuestEndReason = 'tool'): void {
    this.retire(threadId, reason);
  }

  /**
   * Reclaim everything, in both roles.
   *
   * Synchronous, because it runs from plugin unload, which is not awaited, and
   * from `pagehide`, where there is no later.
   */
  destroyAll(reason: GuestEndReason): void {
    for (const threadId of [...this.guests.keys()]) this.retire(threadId, reason);
    for (const threadId of [...this.loginGuests.keys()]) this.retireLogin(threadId, reason);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    this.destroyAll('unload');
    this.host.destroy();
  }

  private reapIdle(): void {
    this.reapIdleFrom(this.guests, (threadId) => this.retire(threadId, 'reap'));
    this.reapIdleFrom(this.loginGuests, (threadId) => this.retireLogin(threadId, 'reap'));
  }

  private reapIdleFrom(map: Map<string, AgentBrowserGuest>, retireFn: (threadId: string) => void): void {
    for (const [threadId, guest] of [...map]) {
      if (guest.currentState === 'busy') continue;
      if (guest.idleMs >= IDLE_REAP_MS) retireFn(threadId);
    }
  }

  /**
   * Periodic sweep: idle reap, hard TTL, budget recycle, dead-guest collection,
   * and a background FD reading so pressure is noticed before the next request
   * rather than at it. Applies identically to both roles — an abandoned login
   * handoff is reclaimed on the same schedule as any other guest, rather than
   * needing its own timeout logic (ADR-0014's Risks).
   */
  private async tick(): Promise<void> {
    if (this.destroyed) return;

    this.sweep(this.guests, (threadId, reason) => this.retire(threadId, reason));
    this.sweep(this.loginGuests, (threadId, reason) => this.retireLogin(threadId, reason));

    if (this.guests.size === 0 && this.loginGuests.size === 0) return;

    const verdict = await this.fdGate.evaluate();
    if (verdict.kind === 'deny-exhausted') {
      this.destroyAll('fd');
      this.notify('Agent browser stopped: the app is out of file handles.');
    } else if (verdict.kind === 'deny-pressure') {
      this.reapIdle();
    }
  }

  private sweep(
    map: Map<string, AgentBrowserGuest>,
    retireFn: (threadId: string, reason: GuestEndReason) => void,
  ): void {
    for (const [threadId, guest] of [...map]) {
      if (!guest.isAlive() && guest.currentState !== 'busy') {
        retireFn(threadId, 'crash');
        continue;
      }
      if (guest.currentState === 'busy') continue;
      // A person is mid-sign-in: never reap, expire or budget-retire under them.
      if (guest.handoffActive) continue;
      if (guest.idleMs >= IDLE_REAP_MS) {
        retireFn(threadId, 'reap');
      } else if (guest.ageMs >= HARD_TTL_MS) {
        retireFn(threadId, 'ttl');
      } else if (guest.budgetExhausted()) {
        retireFn(threadId, 'budget');
      }
    }
  }

  /**
   * A guest died on its own. Record it for the circuit breaker and drop it.
   *
   * The breaker exists because the alternative to bounding repeated crashes is a
   * process-spawn loop: the agent retries, the page kills the renderer again, and
   * the machine loses ground on every cycle. Keyed by `threadId` alone, so a
   * page that crashes a login guest counts against the same cooldown as one
   * that crashes the primary guest — either way, this thread's page is what
   * keeps killing the renderer.
   */
  private handleGuestDied(threadId: string, role: GuestRole, reason: GuestEndReason, error: AgentBrowserError): void {
    this.mapFor(role).delete(threadId);
    this.log('agent-browser: died', { threadId, role, reason, code: error.code });
    this.record({ at: this.now(), kind: 'died', threadId, reason, code: error.code });

    if (reason !== 'crash' && reason !== 'hang') return;

    const now = this.now();
    const record = this.crashes.get(threadId) ?? { at: [], cooldownUntil: 0 };
    record.at = record.at.filter((t) => now - t < CRASH_BREAKER_WINDOW_MS);
    record.at.push(now);
    if (record.at.length >= CRASH_BREAKER_THRESHOLD) {
      record.cooldownUntil = now + CRASH_BREAKER_COOLDOWN_MS;
      record.at = [];
      this.log('agent-browser: circuit-breaker', { threadId, cooldownMs: CRASH_BREAKER_COOLDOWN_MS });
    }
    this.crashes.set(threadId, record);
  }

  /**
   * The host container vanished. Every guest inside it lost its WebContents when
   * it detached, so the registry now describes processes that no longer exist and
   * must be cleared rather than handed out.
   */
  private handleHostDetached(): void {
    this.log('agent-browser: host container detached', { inUse: this.guests.size, loginInUse: this.loginGuests.size });
    this.destroyAll('detach');
  }
}
