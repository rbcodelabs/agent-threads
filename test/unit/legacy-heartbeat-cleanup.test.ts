import { describe, expect, it } from 'vitest';
import { stripLegacyOrchestratorHeartbeats } from '../../src/legacyHeartbeats';

describe('stripLegacyOrchestratorHeartbeats', () => {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, prompt: 'p', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true, ...extra }) as never;
  it('removes only orchestrator heartbeat items and reports the count', () => {
    const items = [item('a'), item('hb1', { isOrchestratorHeartbeat: true }), item('w', { origin: 'wakeup' }), item('hb2', { isOrchestratorHeartbeat: true })];
    const out = stripLegacyOrchestratorHeartbeats(items);
    expect(out.removed).toBe(2);
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(['a', 'w']);
  });
  it('is idempotent and returns the same array when nothing to remove', () => {
    const items = [item('a')];
    const out = stripLegacyOrchestratorHeartbeats(items);
    expect(out.removed).toBe(0);
    expect(out.items).toBe(items);
    expect(stripLegacyOrchestratorHeartbeats(out.items).removed).toBe(0);
  });
});
