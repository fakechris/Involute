import { describe, expect, it } from 'vitest';

import { decideConnect, isLive, normalizeOrigin, originPattern, recorderPatterns } from './connect';

const message = {
  type: 'involute.connect',
  token: 'inv_ext_abc',
  server: 'https://involute.lumenopen.com',
  person: { id: 'u1', name: 'Jane', email: 'jane@example.com' },
  expiresAt: '2027-01-01T00:00:00.000Z',
};

describe('decideConnect', () => {
  it('accepts the token only from the configured server origin', () => {
    const decision = decideConnect(message, 'https://involute.lumenopen.com', 'https://involute.lumenopen.com/');
    expect(decision).toEqual({ accept: true, connection: { token: 'inv_ext_abc', server: 'https://involute.lumenopen.com', person: message.person, expiresAt: message.expiresAt } });
  });

  it('refuses any other sender origin, even one externally_connectable lets through', () => {
    for (const origin of ['http://127.0.0.1:4301', 'https://evil.example.com', 'https://involute.lumenopen.com.evil.com', 'http://involute.lumenopen.com', undefined]) {
      expect(decideConnect(message, origin, 'https://involute.lumenopen.com').accept, String(origin)).toBe(false);
    }
  });

  it('refuses other messages and malformed tokens', () => {
    const server = 'http://127.0.0.1:4301';
    const local = { ...message, server };
    expect(decideConnect(local, server, server).accept).toBe(true);
    expect(decideConnect({ ...local, type: 'involute.other' }, server, server).accept).toBe(false);
    expect(decideConnect({ ...local, token: 'inv_agent_abc' }, server, server).accept).toBe(false);
    expect(decideConnect({ ...local, server: 'https://elsewhere.example.com' }, server, server).accept).toBe(false);
    expect(decideConnect({ ...local, person: null }, server, server).accept).toBe(false);
    expect(decideConnect({ ...local, expiresAt: 'soon' }, server, server).accept).toBe(false);
    expect(decideConnect('involute.connect', server, server).accept).toBe(false);
    expect(decideConnect(local, server, 'not a url').accept).toBe(false);
  });
});

describe('origins', () => {
  it('normalizes http(s) origins only', () => {
    expect(normalizeOrigin('https://Involute.example.com/path?x')).toBe('https://involute.example.com');
    expect(normalizeOrigin('http://127.0.0.1:4301/')).toBe('http://127.0.0.1:4301');
    expect(normalizeOrigin('ftp://x')).toBeNull();
    expect(normalizeOrigin('nonsense')).toBeNull();
  });

  it('builds per-origin match patterns, port included', () => {
    expect(originPattern('http://127.0.0.1:4301')).toBe('http://127.0.0.1:4301/*');
    expect(originPattern('https://app.example.com')).toBe('https://app.example.com/*');
    expect(recorderPatterns(['https://a.example.com', 'https://a.example.com', 'http://localhost:3000'])).toEqual(['https://a.example.com/*', 'http://localhost:3000/*']);
  });

  it('treats an expired connection as absent', () => {
    expect(isLive({ ...message, server: message.server, expiresAt: '2000-01-01T00:00:00Z' })).toBe(false);
    expect(isLive({ ...message, server: message.server }, Date.parse('2026-10-10'))).toBe(true);
    expect(isLive(null)).toBe(false);
  });
});
