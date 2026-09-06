import type { PrismaClient } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { getServerEnvironment } from './environment.ts';
import {
  getRateLimitOptions,
  requestIdentityKey,
  TokenBucketRateLimiter,
} from './rate-limit.ts';
import { startServer, type StartedServer } from './index.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor() as PrismaClient;

let server: StartedServer | undefined;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

describe('rate limiting', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
    await seedDatabase(prisma);
  });

  it('returns 429 with retry-after when an identity exhausts its bucket', async () => {
    server = await startServer({
      allowAdminFallback: true,
      authToken: 'rl-token',
      port: 0,
      prisma,
      rateLimit: { enabled: true, burst: 3, refillPerMinute: 0 },
    });

    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: { authorization: 'Bearer rl-token', 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).toBeTruthy();
      }
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('keys buckets per identity and leaves other identities unaffected', async () => {
    server = await startServer({
      allowAdminFallback: true,
      authToken: 'rl-token',
      port: 0,
      prisma,
      rateLimit: { enabled: true, burst: 1, refillPerMinute: 0 },
    });

    const first = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { authorization: 'Bearer rl-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    const second = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { authorization: 'Bearer rl-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    const otherIdentity = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { authorization: 'Bearer another-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(otherIdentity.status).toBe(200);
  });

  it('can be disabled explicitly', async () => {
    server = await startServer({
      allowAdminFallback: true,
      authToken: 'rl-token',
      port: 0,
      prisma,
      rateLimit: { enabled: false, burst: 1, refillPerMinute: 0 },
    });

    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: { authorization: 'Bearer rl-token', 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      expect(response.status).toBe(200);
    }
  });

});

describe('rate limit configuration', () => {
  it('computes defaults and identity keys', () => {
    const options = getRateLimitOptions({ RATE_LIMIT_BURST: '42', RATE_LIMIT_REFILL_PER_MINUTE: '7' });
    expect(options).toEqual({ burst: 42, enabled: true, refillPerMinute: 7 });
    expect(getRateLimitOptions({ RATE_LIMIT_ENABLED: 'false' }).enabled).toBe(false);
    expect(getRateLimitOptions({}).burst).toBe(300);

    const fakeRequest = {
      headers: { authorization: 'Bearer secret-token' },
      socket: { remoteAddress: '10.0.0.1' },
    } as never;
    const key = requestIdentityKey(fakeRequest);
    expect(key).toMatch(/^tok:[0-9a-f]{32}$/);
    expect(key).not.toContain('secret-token');
  });
});

describe('admin fallback guard', () => {
  it('refuses ALLOW_ADMIN_FALLBACK outside development and test', () => {
    expect(() =>
      getServerEnvironment({
        ALLOW_ADMIN_FALLBACK: 'true',
        NODE_ENV: 'production',
      }),
    ).toThrow('ALLOW_ADMIN_FALLBACK=true is only supported in development or test environments.');
  });

  it('does not mint a fallback viewer for trusted tokens when fallback is off', async () => {
    server = await startServer({
      // Explicitly off, as in production defaults.
      allowAdminFallback: false,
      authToken: 'prod-like-token',
      port: 0,
      prisma,
      rateLimit: { enabled: false, burst: 10, refillPerMinute: 10 },
    });

    const response = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { authorization: 'Bearer prod-like-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { email globalRole } }' }),
    });
    const body = (await response.json()) as { data?: { viewer?: unknown } };
    expect(body.data?.viewer ?? null).toBeNull();
  });
});
