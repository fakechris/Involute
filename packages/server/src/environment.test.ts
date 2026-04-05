import { describe, expect, it } from 'vitest';

import { getServerEnvironment } from './environment.js';

describe('server environment', () => {
  it('prefers ADMIN_EMAIL_ALLOWLIST over the legacy Google-specific allowlist', () => {
    const environment = getServerEnvironment({
      ADMIN_EMAIL_ALLOWLIST: 'admin@example.com, owner@example.com ',
      GOOGLE_OAUTH_ADMIN_EMAILS: 'legacy@example.com',
    });

    expect(environment.adminEmailAllowlist).toEqual([
      'admin@example.com',
      'owner@example.com',
    ]);
  });

  it('falls back to GOOGLE_OAUTH_ADMIN_EMAILS for backward compatibility', () => {
    const environment = getServerEnvironment({
      GOOGLE_OAUTH_ADMIN_EMAILS: 'legacy@example.com',
    });

    expect(environment.adminEmailAllowlist).toEqual(['legacy@example.com']);
  });

  it('normalizes email addresses to lowercase', () => {
    const environment = getServerEnvironment({
      ADMIN_EMAIL_ALLOWLIST: 'Admin@Example.COM',
    });

    expect(environment.adminEmailAllowlist).toEqual(['admin@example.com']);
  });
});
