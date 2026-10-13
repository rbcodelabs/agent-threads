import { describe, it, expect } from 'vitest';
import {
  buildPairingUrl,
  detectPairingScheme,
  formatRoomIdAsCode,
  isValidRelayUrl,
  parsePairingInput,
} from '../../src/mobilePairing';

const ROOM = '0123456789abcdef0123456789abcdef';

describe('detectPairingScheme', () => {
  it('uses obsidian:// when there is no Geode host marker', () => {
    expect(detectPairingScheme({})).toBe('obsidian');
    expect(detectPairingScheme(undefined)).toBe('obsidian');
  });
  it('uses geode:// for the Geode host marker', () => {
    expect(detectPairingScheme({ geode: { host: { name: 'geode', protocolScheme: 'geode' } } })).toBe('geode');
  });
  it('treats an older Geode preload without host as Geode', () => {
    expect(detectPairingScheme({ geode: {} })).toBe('geode');
  });
});

describe('buildPairingUrl', () => {
  it('builds a scheme-specific link with an encoded relay', () => {
    expect(buildPairingUrl('geode', ROOM, 'wss://relay.example.com')).toBe(
      `geode://pair?roomId=${ROOM}&relay=wss%3A%2F%2Frelay.example.com`,
    );
    expect(buildPairingUrl('obsidian', ROOM, 'wss://r')).toMatch(/^obsidian:\/\/pair\?roomId=/);
  });
});

describe('parsePairingInput', () => {
  it('accepts formatted code, raw hex, and mixed case', () => {
    const code = formatRoomIdAsCode(ROOM);
    expect(parsePairingInput(code)).toEqual({ roomId: ROOM });
    expect(parsePairingInput(ROOM.toUpperCase())).toEqual({ roomId: ROOM });
    expect(parsePairingInput(`  ${code}\n`)).toEqual({ roomId: ROOM });
  });
  it('accepts geode:// and obsidian:// links, returning the relay', () => {
    for (const scheme of ['geode', 'obsidian'] as const) {
      expect(parsePairingInput(buildPairingUrl(scheme, ROOM, 'wss://r.example'))).toEqual({
        roomId: ROOM,
        relayUrl: 'wss://r.example',
      });
    }
  });
  it('rejects garbage', () => {
    expect(parsePairingInput('')).toBeNull();
    expect(parsePairingInput('not-a-code')).toBeNull();
    expect(parsePairingInput('geode://pair?roomId=xyz')).toBeNull();
  });
});

describe('isValidRelayUrl', () => {
  it('only allows ws/wss', () => {
    expect(isValidRelayUrl('wss://a.b')).toBe(true);
    expect(isValidRelayUrl('ws://192.168.1.2:8787')).toBe(true);
    expect(isValidRelayUrl('https://a.b')).toBe(false);
    expect(isValidRelayUrl('javascript:alert(1)')).toBe(false);
  });
});
