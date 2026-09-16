/**
 * Is this actor around?
 *
 * Distinct from `AgentRequestPresence`, which is about one request. This is
 * about the actor itself, and it is what someone reading "Mia said X" needs in
 * order to know whether asking Mia again is worth anything.
 *
 * Derived from `lastSeenAt` at read time, never stored. And like every other
 * presence signal in this system it reports an observation — when the actor
 * last authenticated — not a conclusion about whether its host is healthy.
 */
export type ActorPresence = 'active' | 'idle' | 'away' | 'never-seen';

export const ACTIVE_WITHIN_MS = 2 * 60_000;
export const IDLE_WITHIN_MS = 30 * 60_000;

export function actorPresence(
  lastSeenAt: Date | null | undefined,
  now: Date = new Date(),
): ActorPresence {
  if (!lastSeenAt) {
    return 'never-seen';
  }

  const sinceMs = now.getTime() - lastSeenAt.getTime();

  if (sinceMs <= ACTIVE_WITHIN_MS) {
    return 'active';
  }

  if (sinceMs <= IDLE_WITHIN_MS) {
    return 'idle';
  }

  return 'away';
}

export const ACTOR_PRESENCE_COPY: Record<ActorPresence, string> = {
  active: 'Used its credential in the last 2 minutes.',
  idle: 'Last used its credential within the last 30 minutes.',
  away: 'Has not used its credential for over 30 minutes.',
  'never-seen': 'Has never used its credential.',
};
