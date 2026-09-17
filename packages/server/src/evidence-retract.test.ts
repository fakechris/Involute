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

describe('evidence retraction — concurrency, verifier, and target authorization', () => {
  beforeEach(async () => { await resetAndSeed(prisma); });

  it('two concurrent retractions: exactly one succeeds, one audit, one event', async () => {
    const { admin, evidence } = await fixture(prisma);
    const by = { actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'test' };
    const results = await Promise.allSettled([
      retractEvidence(prisma, { evidenceId: evidence.id, reason: 'first' }, by),
      retractEvidence(prisma, { evidenceId: evidence.id, reason: 'second' }, by),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(prisma.workAudit.count({ where: { surface: 'evidence.retract', sourceMessageId: evidence.id } })).resolves.toBe(1);
    await expect(prisma.eventOutbox.count({ where: { type: 'evidence.retracted' } })).resolves.toBe(1);
  });

  it('the verifier refuses retracted evidence and appends no observation', async () => {
    const { verifyEvidence } = await import('./evidence-verification.ts');
    const { admin, evidence } = await fixture(prisma);
    await prisma.workEvidence.update({ where: { id: evidence.id }, data: { verificationNextAt: new Date() } });
    await retractEvidence(prisma, { evidenceId: evidence.id, reason: 'wrong' }, { actorId: admin.id, actorKind: 'HUMAN', surface: 'test' });

    await expect(verifyEvidence(prisma, evidence.id)).rejects.toThrow('EVIDENCE_RETRACTED');
    await expect(prisma.evidenceVerification.count({ where: { evidenceId: evidence.id } })).resolves.toBe(0);
  });

  it('GraphQL: pointing evidence at a work item the caller cannot write is refused; a non-reader gets no superseding work', async () => {
    const { startServer } = await import('./index.ts');
    const { SESSION_COOKIE_NAME, createSession } = await import('./session.ts');
    const { admin, evidence, wrong } = await fixture(prisma);
    const server = await startServer({ allowAdminFallback: true, authToken: 'test-auth-token', port: 0, prisma });
    try {
      // An editor of the evidence's team who cannot write the target (a private team B item).
      const teamB = await prisma.team.create({ data: { key: 'TMB', name: 'B', visibility: 'PRIVATE' } });
      const stateB = await prisma.workflowState.create({ data: { name: 'Ready', position: 0, teamId: teamB.id, type: 'UNSTARTED' } });
      const privateB = await prisma.issue.create({ data: { identifier: 'TMB-1', stateId: stateB.id, teamId: teamB.id, title: 'B secret' } });
      const teamA = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      const editorA = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'editor-a@humans.test.local', name: 'Editor A' } });
      await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: teamA.id, userId: editorA.id } });
      const cookieA = `${SESSION_COOKIE_NAME}=${(await createSession(prisma, editorA.id)).token}`;

      const gql = async (cookie: string, query: string, variables: unknown) => {
        const response = await fetch(`${server.url}/graphql`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ query, variables }),
        });
        return response.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>;
      };
      const refused = await gql(cookieA, 'mutation($i: EvidenceRetractInput!) { evidenceRetract(input: $i) { success } }',
        { i: { correctWorkId: privateB.id, evidenceId: evidence.id, reason: 'probe' } });
      expect(refused.data?.evidenceRetract?.success ?? false).toBe(false);
      await expect(prisma.workEvidence.findUniqueOrThrow({ where: { id: evidence.id } })).resolves.toMatchObject({ retractedAt: null });

      // The admin retracts it, pointing at a private B item; editor A reads the evidence but not B.
      await retractEvidence(prisma, { correctWorkId: privateB.id, evidenceId: evidence.id, reason: 'belongs to B' },
        { actorId: admin.id, actorKind: 'HUMAN', surface: 'test' });
      const seen = await gql(cookieA, 'query($id: String!) { workContext(id: $id) { evidence { id supersededByWork { identifier } } } }', { id: wrong.id });
      const rows = (seen.data?.workContext?.evidence ?? []) as Array<{ id: string; supersededByWork: { identifier: string } | null }>;
      const mine = rows.find((r) => r.id === evidence.id);
      expect(mine?.supersededByWork ?? null).toBeNull();
    } finally {
      await server.stop();
    }
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
