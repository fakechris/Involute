import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface RateLimitOptions {
  enabled: boolean;
  /** Bucket size: requests an identity can make with no refill. */
  burst: number;
  /** Tokens refilled per minute, per identity. */
  refillPerMinute: number;
}

export function getRateLimitOptions(env: NodeJS.ProcessEnv = process.env): RateLimitOptions {
  const enabled = env.RATE_LIMIT_ENABLED !== 'false';
  const burst = Number(env.RATE_LIMIT_BURST ?? 300);
  const refillPerMinute = Number(env.RATE_LIMIT_REFILL_PER_MINUTE ?? 120);
  return {
    enabled,
    burst: Number.isFinite(burst) && burst > 0 ? Math.trunc(burst) : 300,
    refillPerMinute:
      Number.isFinite(refillPerMinute) && refillPerMinute >= 0 ? Math.trunc(refillPerMinute) : 120,
  };
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * In-memory token bucket, one bucket per caller identity. Identity is keyed
 * on the bearer token or session cookie (hashed), falling back to the remote
 * address so unauthenticated probes are still bounded. Deliberately
 * process-local: a single-container deployment needs no shared state, and
 * multi-replica deployments each enforcing N rps still bound the aggregate.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(private readonly options: RateLimitOptions) {}

  take(key: string, cost = 1, now = Date.now()): RateLimitDecision {
    const { burst, refillPerMinute } = this.options;
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: burst, updatedAt: now };
      this.buckets.set(key, bucket);
    }

    const elapsedMinutes = Math.max(0, now - bucket.updatedAt) / 60_000;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedMinutes * refillPerMinute);
    bucket.updatedAt = now;

    if (bucket.tokens < cost) {
      const deficit = cost - bucket.tokens;
      const retryAfterSeconds =
        refillPerMinute > 0 ? Math.ceil((deficit / refillPerMinute) * 60) : 60;
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    bucket.tokens -= cost;
    this.evictStale(now);
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  // Bounded memory: identities that stayed idle past two full refills cannot
  // matter to any future decision.
  private evictStale(now: number): void {
    if (this.buckets.size < 10_000) {
      return;
    }
    const staleCutoff = now - 2 * 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < staleCutoff) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Hashed identity key for rate limiting: bearer token or session cookie when
 * present, remote address otherwise. Hashing keeps raw credentials out of
 * memory dumps.
 */
export function requestIdentityKey(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (authorization) {
    return `tok:${createHash('sha256').update(authorization).digest('hex').slice(0, 32)}`;
  }

  const cookie = request.headers.cookie;
  if (cookie && /(?:^|;\s*)involute_session=/.test(cookie)) {
    return `sess:${createHash('sha256').update(cookie).digest('hex').slice(0, 32)}`;
  }

  return `ip:${request.socket.remoteAddress ?? 'unknown'}`;
}

/**
 * A short, non-secret label for a rate-limit identity in logs: its kind and the
 * first 8 hex of its hash (INV-2312), enough to tell one session's burst from
 * another's without writing a credential or the full key.
 */
export function identityLogLabel(key: string): string {
  const [kind, rest = ''] = key.split(':', 2);
  return kind === 'ip' ? 'ip' : `${kind}:${rest.slice(0, 8)}`;
}

/** Logs at most one line per identity per minute when its bucket runs dry. */
export class RateLimitLogger {
  private readonly lastLogged = new Map<string, number>();

  constructor(private readonly log: (line: string) => void = (line) => console.warn(line)) {}

  exceeded(key: string, path: string, retryAfterSeconds: number, now = Date.now()): void {
    const last = this.lastLogged.get(key);
    if (last !== undefined && now - last < 60_000) return;
    if (this.lastLogged.size >= 1_000) this.lastLogged.clear();
    this.lastLogged.set(key, now);
    this.log(`[rate-limit] ${identityLogLabel(key)} ran out of requests on ${path}; retry after ${retryAfterSeconds}s`);
  }
}
