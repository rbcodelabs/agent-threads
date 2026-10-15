/**
 * Per-IP authentication failure throttle (design section 3.1). After
 * `maxFailures` bad credentials inside `windowMs`, that address is refused
 * until its oldest failure ages out.
 *
 * Note: behind `tailscale serve` or Caddy every client arrives from 127.0.0.1,
 * so the throttle is effectively global there. That errs on the safe side;
 * trusting X-Forwarded-For would let a client choose its own bucket.
 */
export class FailureThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private recent(ip: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.failures.set(ip, kept);
    else this.failures.delete(ip);
    return kept;
  }

  isBlocked(ip: string): boolean {
    return this.recent(ip).length >= this.maxFailures;
  }

  recordFailure(ip: string): void {
    const kept = this.recent(ip);
    kept.push(this.now());
    this.failures.set(ip, kept);
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}
