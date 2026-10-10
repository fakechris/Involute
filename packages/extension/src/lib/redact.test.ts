import { describe, expect, it } from 'vitest';

import { REDACTED, isSensitiveHeader, isSensitiveName, looksSensitiveValue, redactText, redactUrl } from './redact';

// Built at run time so secret scanners do not mistake the fixture for a real key.
const STRIPE_LIKE = ['sk', 'test', 'Fixture00Value11NotAKey'].join('_');
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('sensitive names', () => {
  it('treats authorization and cookie-like headers as sensitive', () => {
    for (const name of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'X-CSRF-Token', 'X-Session-Id']) {
      expect(isSensitiveHeader(name), name).toBe(true);
    }
    expect(isSensitiveHeader('Content-Type')).toBe(false);
    expect(isSensitiveHeader('Accept-Language')).toBe(false);
  });

  it('treats token/key/secret/password/session/auth field names as sensitive', () => {
    for (const name of ['token', 'access_token', 'refreshToken', 'apiKey', 'api-key', 'key', 'client_secret', 'password', 'passwd', 'sessionId', 'session', 'auth', 'oauth_verifier', 'X-Signature']) {
      expect(isSensitiveName(name), name).toBe(true);
    }
    for (const name of ['page', 'q', 'sort', 'locale', 'id', 'status', 'code']) {
      expect(isSensitiveName(name), name).toBe(false);
    }
    // OAuth codes come in the query string.
    expect(isSensitiveName('code', { query: true })).toBe(true);
  });
});

describe('sensitive values', () => {
  it('recognises emails, JWTs, long hex and base64 keys, and sk_/cus_-style ids', () => {
    for (const value of ['jane.doe@example.com', JWT, 'a3f5c9e1b2d4f6a8c0e2b4d6f8a0c2e4', 'dGhpc2lzYXZlcnlsb25nc2VjcmV0a2V5MTIzNDU2Nzg5MA', 'sk_live_51HxYzAbCdEf', 'cus_NffrFeUfNV2Hib', 'ghp_abcdefghijklmnop1234', 'inv_ext_Zm9vYmFyYmF6']) {
      expect(looksSensitiveValue(value), value).toBe(true);
    }
    for (const value of ['settings', 'issue-42', 'INV-1147', '2026-10-10', 'hello world', 'user_profile']) {
      expect(looksSensitiveValue(value), value).toBe(false);
    }
  });
});

describe('redactUrl', () => {
  it('replaces sensitive query values and keeps the rest', () => {
    const url = redactUrl('https://app.example.com/board?token=abc123&page=2&apiKey=zzz&q=hello');
    const params = new URL(url).searchParams;
    expect(params.get('token')).toBe(REDACTED);
    expect(params.get('apiKey')).toBe(REDACTED);
    expect(params.get('page')).toBe('2');
    expect(params.get('q')).toBe('hello');
    expect(url).not.toContain('abc123');
    expect(url).not.toContain('zzz');
  });

  it('redacts values that look like secrets whatever their name, OAuth fragments, credentials and path segments', () => {
    const url = redactUrl(`https://user:hunter2@app.example.com/reset/${JWT}/users/jane@example.com?ref=${'b'.repeat(8)}&u=jane@example.com&code=xyz#access_token=ya29.secretvalue&state=s1`);
    expect(url).not.toContain('hunter2');
    expect(url).not.toContain('user:');
    expect(url).not.toContain(JWT);
    expect(url).not.toContain('jane@example.com');
    expect(url).not.toContain('jane%40example.com');
    expect(url).not.toContain('xyz');
    expect(url).not.toContain('ya29.secretvalue');
    expect(url).toContain(`ref=${'b'.repeat(8)}`);
    expect(url.startsWith('https://app.example.com/reset/')).toBe(true);
  });

  it('redacts text that is not a URL as text', () => {
    expect(redactUrl('not a url jane@example.com')).not.toContain('jane@example.com');
  });
});

describe('redactText', () => {
  it('redacts authorization schemes, named values, and value patterns in console messages', () => {
    const message = [
      'Request failed: Authorization: Bearer abcdef123456',
      'password=hunter2 session: s3ss10n',
      '{"token":"t0k3n","name":"ok"}',
      `user jane@example.com jwt ${JWT}`,
      `charged ${STRIPE_LIKE} for cus_NffrFeUfNV2Hib`,
      'GET https://api.example.com/v1?secret=s3cr3t failed',
    ].join(' | ');
    const out = redactText(message);
    for (const raw of ['abcdef123456', 'hunter2', 's3ss10n', 't0k3n', 'jane@example.com', JWT, STRIPE_LIKE, 'cus_NffrFeUfNV2Hib', 's3cr3t']) {
      expect(out, raw).not.toContain(raw);
    }
    expect(out).toContain('Request failed');
    expect(out).toContain('"name":"ok"');
    expect(out).toContain('https://api.example.com/v1?secret=');
  });

  it('leaves ordinary text alone', () => {
    const text = 'TypeError: Cannot read properties of undefined (reading "title") at Board.tsx:42 — status code: 500';
    expect(redactText(text)).toBe(text);
  });
});
