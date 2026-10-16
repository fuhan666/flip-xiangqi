import { describe, expect, it } from 'vitest';
import { formatAddress, parseServerAddress, toHttpUrl, toWebSocketUrl } from '../address';

describe('parseServerAddress', () => {
  it('accepts bare IPv4 host:port and trims surrounding whitespace', () => {
    const parsed = parseServerAddress('  192.168.1.5:8080  ');
    expect(parsed).toEqual({ ok: true, value: { host: '192.168.1.5', port: 8080 } });
  });

  it('tolerates http/https/ws prefixes and trailing paths', () => {
    expect(parseServerAddress('http://192.168.1.5:8080')).toEqual({ ok: true, value: { host: '192.168.1.5', port: 8080 } });
    expect(parseServerAddress('https://192.168.1.5:8080/join')).toEqual({ ok: true, value: { host: '192.168.1.5', port: 8080 } });
    expect(parseServerAddress('ws://127.0.0.1:4173/ws')).toEqual({ ok: true, value: { host: '127.0.0.1', port: 4173 } });
  });

  it('accepts localhost and rejects unknown host forms', () => {
    expect(parseServerAddress('localhost:8080')).toEqual({ ok: true, value: { host: 'localhost', port: 8080 } });
    expect(parseServerAddress('192.168.1.999:8080').ok).toBe(false);
    expect(parseServerAddress('not a host:8080').ok).toBe(false);
  });

  it('reports missing or invalid ports with actionable text', () => {
    const missing = parseServerAddress('192.168.1.5');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.message).toContain('端口');
    }

    expect(parseServerAddress('192.168.1.5:0').ok).toBe(false);
    expect(parseServerAddress('192.168.1.5:70000').ok).toBe(false);
    expect(parseServerAddress('192.168.1.5:abc').ok).toBe(false);
  });

  it('rejects empty input with a hint', () => {
    const empty = parseServerAddress('   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.message).toContain('192.168.1.5:8080');
    }
  });

  it('normalizes display and transport urls', () => {
    const parsed = parseServerAddress(' http://192.168.1.5:8080 ');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(formatAddress(parsed.value)).toBe('192.168.1.5:8080');
      expect(toWebSocketUrl(parsed.value)).toBe('ws://192.168.1.5:8080/ws');
      expect(toHttpUrl(parsed.value)).toBe('http://192.168.1.5:8080/');
    }
  });
});
