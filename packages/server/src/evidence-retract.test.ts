import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  EVIDENCE_ALREADY_RETRACTED_MESSAGE,
  EVIDENCE_RETRACT_HUMAN_ONLY_MESSAGE,
  EVIDENCE_RETRACT_REASON_REQUIRED_MESSAGE,
  retractEvidence,
} from './evidence-retract.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

/**
 * INV-598. Wrong evidence (Involute PRs attached to a lumen-learn ticket)
 * must be corrected without deleting anything: the mistake, who fixed it,
 * when, why and where it belonged all stay on record.
 */
describe('evidence retraction (INV-598)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });

  it('marks the row, keeps it, audits and emits; names the work it belonged to', async () => {
    const { admin, evidence, right } = await fixture(prisma);

    const updated = await retractEvidence(prisma, {
      correctWorkId: right.id, evidenceId: evidence.id, reason: 'attached to the wrong ticket',
    }, { actorId: admin.id, actorKind: 'HUMAN', surface: 'test' });

    expect(updated.retractedAt).not.toBeNull();
    expect(updated.retractedById).toBe(admin.id);
    expect(updated.retractReason).toBe('attached to the wrong ticket');
    expect(updated.supersededByWorkId).toBe(right.id);
    await expect(prisma.workEvidence.count({ where: { id: evidence.id } })).resolves.toBe(1);

    const audit = await prisma.workAudit.findFirstOrThrow({ where: { surface: 'evidence.retract', sourceMessageId: evidence.id } });
    expect(audit.actorId).toBe(admin.id);
    expect(audit.reason).toContain('attached to the wrong ticket');
    await expect(prisma.eventOutbox.count({ where: { type: 'evidence.retracted' } })).resolves.toBe(1);
  });

  it('requires a person and a reason; refuses a second retraction', async () => {
    const { admin, evidence, mia } = await fixture(prisma);

    await expect(retractEvidence(prisma, { evidenceId: evidence.id, reason: 'x' }, { actorId: mia.id, actorKind: 'AGENT', surface: 'test' }))
      .rejects.toThrow(EVIDENCE_RETRACT_HUMAN_ONLY_MESSAGE);
    await expect(retractEvidence(prisma, { evidenceId: evidence.id, reason: '  ' }, { actorId: admin.id, actorKind: 'HUMAN', surface: 'test' }))
      .rejects.toThrow(EVIDENCE_RETRACT_REASON_REQUIRED_MESSAGE);

    await retractEvidence(prisma, { evidenceId: evidence.id, reason: 'once' }, { actorId: admin.id, actorKind: 'HUMAN', surface: 'test' });
    await expect(retractEvidence(prisma, { evidenceId: evidence.id, reason: 'twice' }, { actorId: admin.id, actorKind: 'HUMAN', surface: 'test' }))
      .rejects.toThrow(EVIDENCE_ALREADY_RETRACTED_MESSAGE);
  });
});

async function fixture(client: PrismaClient): Promise<{ admin: User; evidence: { id: string }; mia: User; right: Issue; wrong: Issue }> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
  const team = await client.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const state = await client.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: team.id } });
  const wrong = await client.issue.create({ data: { identifier: 'INV-980', stateId: state.id, teamId: team.id, title: 'Wrong ticket' } });
  const right = await client.issue.create({ data: { identifier: 'INV-981', stateId: state.id, teamId: team.id, title: 'Right ticket' } });
  const mia = await client.user.create({ data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia', ownerId: admin.id } });
  const evidence = await client.workEvidence.create({ data: { kind: 'PR', url: 'https://github.com/example/repo/pull/1', workId: wrong.id } });
  return { admin, evidence, mia, right, wrong };
}
