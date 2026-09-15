import type { AgentRequest } from '@prisma/client';

/**
 * Linear's "tell the truth" presence, alongside (not inside) the A2A state.
 *
 * The A2A state says what the *request* is doing. Presence says whether anyone
 * appears to be working on it. They are different questions, and folding
 * presence into the state machine would mean inventing states A2A does not
 * have — so this is derived at read time and never stored.
 *
 * What a person actually wants to know when they ask an agent something is
 * "is it going to answer me": docs/54 §C.
 */
export type AgentRequestPresence = 'waiting' | 'live' | 'unresponsive' | 'stale' | 'settled';

/** No activity within this window after a claim and nobody is visibly working. */
export const UNRESPONSIVE_AFTER_MS = 10_000;
/** No further activity for this long: the claim is cold but recoverable. */
export const STALE_AFTER_MS = 30 * 60_000;

type PresenceInput = Pick<
  AgentRequest,
  'claimedAt' | 'claimExpiresAt' | 'claimedBy' | 'state' | 'updatedAt'
>;

/**
 * - `settled`   — terminal; nothing is expected to happen.
 * - `waiting`   — nobody has claimed it yet.
 * - `live`      — claimed and active within the last 10s.
 * - `unresponsive` — claimed but silent for over 10s. **Not** a claim that the
 *   consumer is down: it may be thinking, busy, or on a slow host.
 * - `stale`     — silent for over 30 minutes. Recoverable: the holder can renew
 *   its claim, or the lease lapses and another consumer takes over.
 */
export function agentRequestPresence(
  request: PresenceInput,
  now: Date = new Date(),
): AgentRequestPresence {
  if (request.state === 'COMPLETED' || request.state === 'FAILED' || request.state === 'CANCELED') {
    return 'settled';
  }

  if (!request.claimedBy || !request.claimedAt) {
    return 'waiting';
  }

  const silentForMs = now.getTime() - request.updatedAt.getTime();

  if (silentForMs >= STALE_AFTER_MS) {
    return 'stale';
  }

  if (silentForMs >= UNRESPONSIVE_AFTER_MS) {
    return 'unresponsive';
  }

  return 'live';
}

/**
 * Display copy for each presence, in the register docs/54 §D3 requires: say
 * what is observed, never infer why. "Has not replied yet" is observed;
 * "is not running" is a guess the server is not entitled to make.
 */
export const PRESENCE_COPY: Record<AgentRequestPresence, string> = {
  settled: 'Closed.',
  waiting: 'Not picked up yet.',
  live: 'Working on it.',
  unresponsive: 'Picked up, but no activity in the last 10 seconds.',
  stale: 'Picked up, but no activity for over 30 minutes.',
};
