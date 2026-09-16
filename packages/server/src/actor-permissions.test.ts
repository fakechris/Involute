import { describe, expect, it } from 'vitest';

import { assertActorCan } from './claim-service.ts';
import { writeActorFromViewer } from './work-service.ts';

/**
 * The human gates (INV-573).
 *
 * These existed as "throw if the actor is an AGENT", which granted commit,
 * reject and accept to every other actor kind — including SERVICE, which is
 * exactly what `writeActorFromViewer` produces for a null viewer. An actor the
 * system could not identify was more privileged than a registered agent.
 */
describe('actor permissions', () => {
  const HUMAN_GATED = ['commit', 'reject', 'accept'] as const;
  const UNGATED = ['propose', 'claim', 'update'] as const;

  it('lets humans through every gate', () => {
    for (const permission of [...HUMAN_GATED, ...UNGATED]) {
      expect(() => assertActorCan('HUMAN', permission)).not.toThrow();
    }
  });

  it('denies the human gates to agents', () => {
    expect(() => assertActorCan('AGENT', 'commit')).toThrow(/commit/i);
    expect(() => assertActorCan('AGENT', 'reject')).toThrow(/reject/i);
    expect(() => assertActorCan('AGENT', 'accept')).toThrow(/accept/i);
  });

  it('denies the human gates to SERVICE actors', () => {
    // Regression: SERVICE used to pass every gate. Internal automation must not
    // be able to commit its own proposals.
    expect(() => assertActorCan('SERVICE', 'commit')).toThrow(/commit/i);
    expect(() => assertActorCan('SERVICE', 'reject')).toThrow(/reject/i);
    expect(() => assertActorCan('SERVICE', 'accept')).toThrow(/accept/i);
  });

  it('denies the human gates to an unknown actor kind', () => {
    for (const actorKind of [null, undefined] as const) {
      expect(() => assertActorCan(actorKind, 'commit')).toThrow(/commit/i);
      expect(() => assertActorCan(actorKind, 'reject')).toThrow(/reject/i);
      expect(() => assertActorCan(actorKind, 'accept')).toThrow(/accept/i);
    }
  });

  it('leaves the ungated permissions open to every actor kind', () => {
    for (const actorKind of ['HUMAN', 'AGENT', 'SERVICE', null, undefined] as const) {
      for (const permission of UNGATED) {
        expect(() => assertActorCan(actorKind, permission)).not.toThrow();
      }
    }
  });

  it('a null viewer cannot commit, because it resolves to SERVICE', () => {
    // This is the concrete hole: an unidentified caller became SERVICE and
    // SERVICE passed every gate.
    const actor = writeActorFromViewer(null, 'mcp');

    expect(actor.actorKind).toBe('SERVICE');
    expect(actor.actorId).toBeNull();
    expect(() => assertActorCan(actor.actorKind, 'commit')).toThrow(/commit/i);
  });
});
