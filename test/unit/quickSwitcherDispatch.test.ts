import { describe, it, expect, vi } from 'vitest';
import {
  buildDispatchItems,
  registerDispatchQuickSwitcher,
  type QuickSwitcherProvider,
} from '../../src/quickSwitcherDispatch';

describe('buildDispatchItems', () => {
  it('returns no rows for empty or whitespace queries', () => {
    expect(buildDispatchItems('', vi.fn())).toEqual([]);
    expect(buildDispatchItems('   \n', vi.fn())).toEqual([]);
  });

  it('builds one row with the trimmed text and dispatches it on choose', () => {
    const dispatch = vi.fn();
    const items = buildDispatchItems('  fix the login bug ', dispatch);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Dispatch new conversation: "fix the login bug"');
    expect(items[0].icon).toBe('message-square-plus');
    items[0].onChoose({} as MouseEvent);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('fix the login bug');
  });
});

describe('registerDispatchQuickSwitcher', () => {
  it('is a silent no-op when the host lacks registerQuickSwitcherProvider', () => {
    expect(registerDispatchQuickSwitcher({}, vi.fn())).toBe(false);
    expect(registerDispatchQuickSwitcher(null, vi.fn())).toBe(false);
  });

  it('registers a provider on hosts that support it', () => {
    const host = { registerQuickSwitcherProvider: vi.fn() };
    const dispatch = vi.fn();
    expect(registerDispatchQuickSwitcher(host, dispatch)).toBe(true);
    const provider = host.registerQuickSwitcherProvider.mock.calls[0][0] as QuickSwitcherProvider;
    expect(provider.getItems('')).toEqual([]);
    provider.getItems('hello')[0].onChoose({} as MouseEvent);
    expect(dispatch).toHaveBeenCalledWith('hello');
  });
});
