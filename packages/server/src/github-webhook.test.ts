import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, User, Issue } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { commitWork, proposeWork } from './claim-service.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import {
  DEFAULT_REPO_ROUTES,
  extractIssueIdentifiers,
  findRepoRoute,
  resolveIssueIdentifierFromPr,
  resolveRepoRoute,
  setCustomRepoRoutes,
} from './github-repo-routes.ts';
import {
  applyMonotonicForward,
  applyProvenanceRollback,
} from './github-webhook-state-machine.ts';
import {
  handleGitHubWebhook,
  processGitHubCreateEvent,
  processGitHubPrEvent,
} from './github-webhook-handler.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('GitHub Webhook & Dual-Track CAS State Machine (Phase 2)', () => {
  let team: Team;
  let human: User;

  beforeAll(async () => {
    await prisma.$connect();
    await seedDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.webhookEventLog.deleteMany();
    await prisma.workEvidence.deleteMany();
    await prisma.workClaim.deleteMany();
    await prisma.workAudit.deleteMany();
    await prisma.issue.deleteMany();

    let currentTeam = await prisma.team.findUnique({ where: { key: DEFAULT_TEAM_KEY } });
    if (!currentTeam) {
      await seedDatabase(prisma);
      currentTeam = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    }
    team = currentTeam;
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  async function createTestIssue(title: string): Promise<Issue> {
    const candidate = await proposeWork(
      prisma,
      { teamId: team.id, title },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    return commitWork(
      prisma,
      candidate.id,
      {
        acceptance: 'acceptance criteria',
        assigneeId: human.id,
        expectedRevision: candidate.revision,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
  }

  describe('Subsystem 2: Repo Routing & Identifier Extraction', () => {
    it('resolves default repo routes for Involute and lumenbox', () => {
      const invRoute = findRepoRoute('fakechris/Involute');
      expect(invRoute).toBeDefined();
      expect(invRoute?.teamKey).toBe('INV');

      const lumRoute = findRepoRoute('fakechris/lumenbox');
      expect(lumRoute).toBeDefined();
      expect(lumRoute?.teamKey).toBe('LUM');

      const unknownRoute = findRepoRoute('unknown/repo');
      expect(unknownRoute).toBeUndefined();
    });

    it('extracts issue identifiers respecting team key and word boundaries', () => {
      const route = DEFAULT_REPO_ROUTES[0]; // INV

      // Valid branch and title patterns
      expect(extractIssueIdentifiers('feat/INV-123-slug', route)).toEqual(['INV-123']);
      expect(extractIssueIdentifiers('fix: [inv-456] bugfix', route)).toEqual(['INV-456']);
      expect(extractIssueIdentifiers('random text without ref', route)).toEqual([]);

      // Boundary safety: SPINV-123 should NOT match INV
      expect(extractIssueIdentifiers('SPINV-123 hack', route)).toEqual([]);
    });

    it('enforces Branch-First convention (Branch > Title)', () => {
      const route = DEFAULT_REPO_ROUTES[0];

      const resolved = resolveIssueIdentifierFromPr({
        branch: 'feat/INV-10-branch-feature',
        title: 'fix: [INV-20] title mismatch',
        route,
      });

      // Branch must win over Title
      expect(resolved).toBe('INV-10');

      // Title fallback when branch has no identifier
      const fallback = resolveIssueIdentifierFromPr({
        branch: 'patch-1',
        title: 'fix: [INV-30] title only',
        route,
      });
      expect(fallback).toBe('INV-30');
    });
  });

  describe('Subsystem 3: Dual-Track CAS State Machine', () => {
    it('Channel A: Monotonic Forward CAS moves UNSTARTED → REVIEW on PR opened', async () => {
      const issue = await createTestIssue('Test monotonic forward');
      const prId = '1001';
      const eventTimestamp = '2026-09-09T10:00:00.000Z';

      const result = await prisma.$transaction(async (tx) => {
        return applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: team.id,
          targetStateType: 'REVIEW',
          eventSourceKey: `github_pr_${prId}_opened_${eventTimestamp}`,
          eventType: 'pull_request.opened',
          sourcePrId: prId,
          eventTimestamp,
        });
      });

      expect(result.applied).toBe(true);
      expect(result.newStateType).toBe('REVIEW');

      const updated = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(updated.state.type).toBe('REVIEW');
      expect(updated.stateSourcePrId).toBe(prId);
      expect(updated.lastAppliedEventTime).toBeDefined();

      // Physical idempotency check: re-running identical event should be skipped
      const duplicateResult = await prisma.$transaction(async (tx) => {
        return applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: team.id,
          targetStateType: 'REVIEW',
          eventSourceKey: `github_pr_${prId}_opened_${eventTimestamp}`,
          eventType: 'pull_request.opened',
          sourcePrId: prId,
          eventTimestamp,
        });
      });
      expect(duplicateResult.applied).toBe(false);
      expect(duplicateResult.reason).toContain('already processed');
    });

    it('Channel A: PR merged advances to COMPLETED and clears stateSourcePrId', async () => {
      const issue = await createTestIssue('Test PR merged');
      const prId = '1002';
      const eventTimestamp = '2026-09-09T11:00:00.000Z';

      const result = await prisma.$transaction(async (tx) => {
        return applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: team.id,
          targetStateType: 'COMPLETED',
          eventSourceKey: `github_pr_${prId}_merged_${eventTimestamp}`,
          eventType: 'pull_request.merged',
          eventTimestamp,
        });
      });

      expect(result.applied).toBe(true);
      expect(result.newStateType).toBe('COMPLETED');

      const updated = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(updated.state.type).toBe('COMPLETED');
      expect(updated.stateSourcePrId).toBeNull();
    });

    it('Absorbing Terminal State: COMPLETED cannot be regressed by opened or reopened', async () => {
      const issue = await createTestIssue('Terminal state defense');

      // First move to COMPLETED
      await prisma.$transaction(async (tx) => {
        return applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: team.id,
          targetStateType: 'COMPLETED',
          eventSourceKey: 'pr_merged_first',
          eventType: 'pull_request.merged',
          eventTimestamp: '2026-09-09T12:00:00.000Z',
        });
      });

      // Stale opened event arrives later
      const staleResult = await prisma.$transaction(async (tx) => {
        return applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: team.id,
          targetStateType: 'REVIEW',
          eventSourceKey: 'stale_pr_opened_later',
          eventType: 'pull_request.opened',
          sourcePrId: '1003',
          eventTimestamp: '2026-09-09T12:05:00.000Z',
        });
      });

      expect(staleResult.applied).toBe(false);
      expect(staleResult.reason).toContain('absorbing terminal state: COMPLETED');

      const current = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(current.state.type).toBe('COMPLETED');
    });

    it('Out-of-order defense: rejects events with timestamp strictly older than lastAppliedEventTime', async () => {
      const issue = await createTestIssue('Out-of-order test');

      // First event at T = 12:00
      await prisma.$transaction(async (tx) => {
        return applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: team.id,
          targetStateType: 'STARTED',
          eventSourceKey: 'event_t2',
          eventType: 'create.branch',
          eventTimestamp: '2026-09-09T12:00:00.000Z',
        });
      });

      // Older event arrives with T = 11:00
      const oldResult = await prisma.$transaction(async (tx) => {
        return applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: team.id,
          targetStateType: 'REVIEW',
          eventSourceKey: 'event_t1_delayed',
          eventType: 'pull_request.opened',
          sourcePrId: '1004',
          eventTimestamp: '2026-09-09T11:00:00.000Z',
        });
      });

      expect(oldResult.applied).toBe(false);
      expect(oldResult.reason).toContain('Out-of-order event');
    });

    it('Channel B: Restricted Provenance Rollback only rolls back if stateSourcePrId matches', async () => {
      const issue = await createTestIssue('Provenance rollback test');
      const originatingPrId = '2001';
      const roguePrId = '9999';

      // Advance issue to REVIEW via originating PR 2001
      await prisma.$transaction(async (tx) => {
        return applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: team.id,
          targetStateType: 'REVIEW',
          eventSourceKey: 'pr_2001_opened',
          eventType: 'pull_request.opened',
          sourcePrId: originatingPrId,
          eventTimestamp: '2026-09-09T13:00:00.000Z',
        });
      });

      // Test 1: Rogue non-source PR 9999 is closed unmerged -> MUST BE REJECTED
      const rogueResult = await prisma.$transaction(async (tx) => {
        return applyProvenanceRollback(tx, {
          issueId: issue.id,
          teamId: team.id,
          prId: roguePrId,
          eventSourceKey: 'pr_9999_closed_unmerged',
          eventType: 'pull_request.closed_unmerged',
          eventTimestamp: '2026-09-09T13:10:00.000Z',
        });
      });

      expect(rogueResult.applied).toBe(false);
      expect(rogueResult.reason).toContain('Provenance mismatch');

      let current = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(current.state.type).toBe('REVIEW');
      expect(current.stateSourcePrId).toBe(originatingPrId);

      // Test 2: Originating PR 2001 is closed unmerged -> MUST SUCCEED (rollback to STARTED)
      const validRollbackResult = await prisma.$transaction(async (tx) => {
        return applyProvenanceRollback(tx, {
          issueId: issue.id,
          teamId: team.id,
          prId: originatingPrId,
          eventSourceKey: 'pr_2001_closed_unmerged',
          eventType: 'pull_request.closed_unmerged',
          eventTimestamp: '2026-09-09T13:20:00.000Z',
        });
      });

      expect(validRollbackResult.applied).toBe(true);
      expect(validRollbackResult.newStateType).toBe('STARTED');

      current = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(current.state.type).toBe('STARTED');
      expect(current.stateSourcePrId).toBeNull();
    });
  });

  describe('Full Event Pipeline & Evidence Attachment', () => {
    it('attaches PR evidence on open and updates summary on merge', async () => {
      const issue = await createTestIssue('PR evidence attachment test');

      const prPayload = {
        action: 'opened',
        pull_request: {
          id: 5001,
          number: 42,
          title: 'Add great feature',
          html_url: 'https://github.com/fakechris/Involute/pull/42',
          merged: false,
          head: {
            ref: `feat/${issue.identifier}-feature`,
          },
          updated_at: '2026-09-09T14:00:00.000Z',
        },
        repository: {
          full_name: 'fakechris/Involute',
        },
      };

      // Process opened event
      await processGitHubPrEvent(prisma, prPayload);

      let issueInDb = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true, evidence: true },
      });
      expect(issueInDb.state.type).toBe('REVIEW');
      expect(issueInDb.evidence).toHaveLength(1);
      expect(issueInDb.evidence[0].url).toBe('https://github.com/fakechris/Involute/pull/42');
      expect(issueInDb.evidence[0].kind).toBe('PR');

      // Now simulate PR merged
      const mergePayload = {
        ...prPayload,
        action: 'closed',
        pull_request: {
          ...prPayload.pull_request,
          merged: true,
          merge_commit_sha: 'abcdef1234567890',
          updated_at: '2026-09-09T14:30:00.000Z',
        },
      };

      await processGitHubPrEvent(prisma, mergePayload);

      issueInDb = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true, evidence: true },
      });
      expect(issueInDb.state.type).toBe('COMPLETED');
      expect(issueInDb.evidence[0].summary).toContain('Merged in abcdef1');
    });

    it('Branch creation event advances UNSTARTED to STARTED', async () => {
      const issue = await createTestIssue('Branch create test');

      await processGitHubCreateEvent(prisma, {
        ref: `feat/${issue.identifier}-agent-branch`,
        ref_type: 'branch',
        repository: {
          full_name: 'fakechris/Involute',
        },
      });

      const updated = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(updated.state.type).toBe('STARTED');
    });
  });

  describe('HTTP Webhook Endpoint (HMAC & Fast 200)', () => {
    const testSecret = 'whsec_test_secret_123';

    function createMockRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
      const req = new EventEmitter() as unknown as IncomingMessage;
      req.method = 'POST';
      req.url = '/api/webhooks/github';
      req.headers = { ...headers };

      process.nextTick(() => {
        req.emit('data', Buffer.from(body));
        req.emit('end');
      });

      return req;
    }

    function createMockResponse(): { res: ServerResponse; getOutput: () => { status: number; body: string } } {
      let statusCode = 200;
      let body = '';
      const res = {
        get statusCode() { return statusCode; },
        set statusCode(code: number) { statusCode = code; },
        setHeader: () => {},
        end: (chunk: string) => { body = chunk; },
        headersSent: false,
      } as unknown as ServerResponse;

      return {
        res,
        getOutput: () => ({ status: statusCode, body }),
      };
    }

    it('rejects missing or invalid HMAC signatures with 401', async () => {
      const body = JSON.stringify({ hello: 'world' });

      // Test 1: Missing signature
      const { res: res1, getOutput: getOutput1 } = createMockResponse();
      const req1 = createMockRequest(body, {});
      await handleGitHubWebhook({ prisma, webhookSecret: testSecret }, req1, res1);
      expect(getOutput1().status).toBe(401);

      // Test 2: Invalid signature
      const { res: res2, getOutput: getOutput2 } = createMockResponse();
      const req2 = createMockRequest(body, { 'x-hub-signature-256': 'sha256=invalid_hash' });
      await handleGitHubWebhook({ prisma, webhookSecret: testSecret }, req2, res2);
      expect(getOutput2().status).toBe(401);
    });

    it('does not acknowledge signed malformed JSON as a successful delivery', async () => {
      const body = '{invalid';
      const signature = 'sha256=' + createHmac('sha256', testSecret).update(body).digest('hex');
      const { res, getOutput } = createMockResponse();
      const req = createMockRequest(body, {
        'x-hub-signature-256': signature,
        'x-github-event': 'create',
        'x-github-delivery': 'invalid-json-delivery',
      });
      await handleGitHubWebhook({ prisma, webhookSecret: testSecret }, req, res);
      expect(getOutput().status).toBe(400);
    });

    it('accepts valid HMAC signature with fast 200 OK', async () => {
      const body = JSON.stringify({
        action: 'opened',
        repository: { full_name: 'fakechris/Involute' },
      });
      const validSig = 'sha256=' + createHmac('sha256', testSecret).update(Buffer.from(body)).digest('hex');

      const { res, getOutput } = createMockResponse();
      const req = createMockRequest(body, {
        'x-hub-signature-256': validSig,
        'x-github-event': 'ping',
      });

      const handled = await handleGitHubWebhook({ prisma, webhookSecret: testSecret }, req, res);
      expect(handled).toBe(true);
      expect(getOutput().status).toBe(200);
      expect(JSON.parse(getOutput().body)).toEqual({ ok: true });
    });
  });

  describe('P1 Concurrency Hardening & Isolation (Reviewer Defense Matrix)', () => {
    it('Atomic CAS ensures concurrent opened + merged always settles in COMPLETED', async () => {
      const issue = await createTestIssue('Concurrency CAS battle');

      const openedTimestamp = '2026-09-09T12:00:00.000Z';
      const mergedTimestamp = '2026-09-09T12:30:00.000Z';

      // Fire concurrent transactions simulating out-of-order / interleaving deliveries
      const [openedResult, mergedResult] = await Promise.all([
        prisma.$transaction((tx) =>
          applyMonotonicForward(tx, {
            issueId: issue.id,
            teamId: team.id,
            targetStateType: 'REVIEW',
            eventSourceKey: 'concurrent_opened_key',
            eventType: 'pull_request.opened',
            sourcePrId: '9001',
            eventTimestamp: openedTimestamp,
          }),
        ),
        prisma.$transaction((tx) =>
          applyMonotonicForward(tx, {
            issueId: issue.id,
            teamId: team.id,
            targetStateType: 'COMPLETED',
            eventSourceKey: 'concurrent_merged_key',
            eventType: 'pull_request.merged',
            eventTimestamp: mergedTimestamp,
          }),
        ),
      ]);

      // At least merged must have applied
      expect(mergedResult.applied).toBe(true);

      const finalState = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });

      // INVARIANT: Final state MUST be COMPLETED — never regressed back to REVIEW!
      expect(finalState.state.type).toBe('COMPLETED');
      expect(finalState.lastAppliedEventTime?.toISOString()).toBe(mergedTimestamp);
    });

    it('Cross-repo teamKey mismatch is safely rejected (lumenbox cannot mutate INV issues)', async () => {
      const issue = await createTestIssue('Cross-repo isolation test');

      // PR coming from fakechris/lumenbox (teamKey LUM) referencing INV-xxx
      const roguePayload = {
        action: 'opened',
        pull_request: {
          id: 7777,
          number: 1,
          title: `fix: [${issue.identifier}] rogue change`,
          html_url: 'https://github.com/fakechris/lumenbox/pull/1',
          merged: false,
          head: { ref: 'patch-1' },
          updated_at: '2026-09-09T15:00:00.000Z',
        },
        repository: {
          full_name: 'fakechris/lumenbox',
        },
      };

      await processGitHubPrEvent(prisma, roguePayload);

      const untouched = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });

      // State must remain UNSTARTED — cross-repo pollution blocked!
      expect(untouched.state.type).toBe('UNSTARTED');
    });

    it('Cross-repo teamKey mismatch guard blocks processing when issue team differs from route teamKey', async () => {
      const issue = await createTestIssue('Route team mismatch test');
      // Configure route where repo pattern matches INV-xxx, but route.teamKey is 'OTHER'
      setCustomRepoRoutes([
        {
          repository: 'fakechris/Involute',
          teamKey: 'OTHER',
          identifierPattern: /(?:^|[^A-Za-z])((?:INV|inv)-[0-9]+)/,
        },
      ]);
      try {
        await processGitHubPrEvent(prisma, {
          action: 'opened',
          pull_request: {
            id: 8888,
            number: 88,
            title: `feat: [${issue.identifier}] mismatch test`,
            html_url: 'https://github.com/fakechris/Involute/pull/88',
            merged: false,
            head: { ref: `feat/${issue.identifier}-mismatch` },
            updated_at: '2026-09-09T16:00:00.000Z',
          },
          repository: { full_name: 'fakechris/Involute' },
        });

        const untouched = await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          include: { state: true },
        });
        expect(untouched.state.type).toBe('UNSTARTED');
      } finally {
        setCustomRepoRoutes(null);
      }
    });

    it('Duplicate PR opened delivery is a clean no-op without exceptions', async () => {
      const issue = await createTestIssue('Duplicate delivery test');
      const payload = {
        action: 'opened' as const,
        pull_request: {
          id: 9901,
          number: 99,
          title: 'feat: dup test',
          html_url: 'https://github.com/fakechris/Involute/pull/99',
          merged: false,
          head: { ref: `feat/${issue.identifier}-dup-test` },
          updated_at: '2026-09-09T12:00:00.000Z',
        },
        repository: { full_name: 'fakechris/Involute' },
      };

      const errors: unknown[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => errors.push(args);

      try {
        await processGitHubPrEvent(prisma, payload);
        // Second identical delivery (redelivery)
        await processGitHubPrEvent(prisma, payload);
      } finally {
        console.error = origError;
      }

      // No console.error / 25P02 transaction aborts
      expect(errors).toEqual([]);

      const evidenceCount = await prisma.workEvidence.count({
        where: { workId: issue.id },
      });
      expect(evidenceCount).toBe(1);

      const logCount = await prisma.webhookEventLog.count({
        where: { issueId: issue.id },
      });
      expect(logCount).toBe(1);
    });
  });

  describe('Traceability Guard: unverified reference ops alerts (INV-449)', () => {
    const ALERT_TYPE = 'ops.github.pr_unverified_reference';

    beforeEach(async () => {
      await prisma.notification.deleteMany();
    });

    function buildPrPayload(overrides: {
      action?: string;
      number?: number;
      title?: string;
      branch?: string;
      updatedAt?: string;
    }) {
      const number = overrides.number ?? 500;
      return {
        action: overrides.action ?? 'opened',
        pull_request: {
          id: 20000 + number,
          number,
          title: overrides.title ?? 'feat: something',
          html_url: `https://github.com/fakechris/Involute/pull/${number}`,
          merged: false,
          head: { ref: overrides.branch ?? 'feat/no-ref-here' },
          updated_at: overrides.updatedAt ?? '2026-09-10T10:00:00.000Z',
        },
        repository: { full_name: 'fakechris/Involute' },
        sender: { login: 'fake-agent' },
      };
    }

    async function findAlerts(userId?: string) {
      // emitOpsAlert fans out to every HUMAN ADMIN; the shared test DB holds
      // several, so positive assertions scope to the seeded admin.
      return prisma.notification.findMany({
        where: { type: ALERT_TYPE, ...(userId ? { userId } : {}) },
      });
    }

    it('alerts admins with unknown-identifier when the referenced issue does not exist', async () => {
      await processGitHubPrEvent(
        prisma,
        buildPrPayload({ branch: 'feat/INV-9999-ghost', title: 'feat: [INV-9999] ghost ref' }),
      );

      const alerts = await findAlerts(human.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.userId).toBe(human.id);
      const details = alerts[0]?.payload as Record<string, unknown>;
      expect(details).toMatchObject({
        repository: 'fakechris/Involute',
        prNumber: 500,
        branch: 'feat/INV-9999-ghost',
        identifier: 'INV-9999',
        reason: 'unknown-identifier',
        sender: 'fake-agent',
      });
    });

    it('alerts with team-mismatch when the issue belongs to another team than the route', async () => {
      const issue = await createTestIssue('Mismatch alert target');
      setCustomRepoRoutes([
        {
          repository: 'fakechris/Involute',
          teamKey: 'OTHER',
          identifierPattern: /(?:^|[^A-Za-z])((?:INV|inv)-[0-9]+)/,
        },
      ]);
      try {
        await processGitHubPrEvent(
          prisma,
          buildPrPayload({ branch: `feat/${issue.identifier}-x`, title: `feat: [${issue.identifier}] x` }),
        );
      } finally {
        setCustomRepoRoutes(null);
      }

      const alerts = await findAlerts(human.id);
      expect(alerts).toHaveLength(1);
      const details = alerts[0]?.payload as Record<string, unknown>;
      expect(details).toMatchObject({
        identifier: issue.identifier,
        reason: 'team-mismatch',
      });

      // Processing skipped as before: no state transition happened.
      const untouched = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(untouched.state.type).toBe('UNSTARTED');
    });

    it('alerts with terminal-issue-reference but still records the event and continues processing', async () => {
      const issue = await createTestIssue('Terminal reference target');

      // Move the issue to COMPLETED first
      await prisma.$transaction((tx) =>
        applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: team.id,
          targetStateType: 'COMPLETED',
          eventSourceKey: 'terminal_target_merged',
          eventType: 'pull_request.merged',
          eventTimestamp: '2026-09-10T09:00:00.000Z',
        }),
      );

      await processGitHubPrEvent(
        prisma,
        buildPrPayload({ branch: `feat/${issue.identifier}-rework`, title: `fix: [${issue.identifier}] rework` }),
      );

      const alerts = await findAlerts(human.id);
      expect(alerts).toHaveLength(1);
      const details = alerts[0]?.payload as Record<string, unknown>;
      expect(details).toMatchObject({
        identifier: issue.identifier,
        reason: 'terminal-issue-reference',
      });

      // Behavior unchanged: the absorbing-state CAS no-ops, but the opened
      // event is still recorded in the webhook event log (2 rows: the merge
      // above plus this opened).
      const logCount = await prisma.webhookEventLog.count({ where: { issueId: issue.id } });
      expect(logCount).toBe(2);
      const current = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(current.state.type).toBe('COMPLETED');
    });

    it('produces no alert for a valid reference', async () => {
      const issue = await createTestIssue('Valid reference target');
      await processGitHubPrEvent(
        prisma,
        buildPrPayload({ branch: `feat/${issue.identifier}-ok`, title: `feat: [${issue.identifier}] ok` }),
      );

      expect(await findAlerts()).toHaveLength(0);
    });

    it('alerts on edited but not on synchronize for the same bad reference', async () => {
      await processGitHubPrEvent(
        prisma,
        buildPrPayload({ action: 'edited', branch: 'feat/INV-9998-ghost', title: 'fix: [INV-9998] typo fix' }),
      );
      expect(await findAlerts(human.id)).toHaveLength(1);

      await processGitHubPrEvent(
        prisma,
        buildPrPayload({ action: 'synchronize', branch: 'feat/INV-9998-ghost', title: 'fix: [INV-9998] typo fix' }),
      );
      expect(await findAlerts(human.id)).toHaveLength(1);
    });

    it('alerts on branch create with unknown-identifier', async () => {
      await processGitHubCreateEvent(prisma, {
        ref: 'feat/INV-9997-ghost-branch',
        ref_type: 'branch',
        repository: { full_name: 'fakechris/Involute' },
        sender: { login: 'fake-agent' },
      });

      const alerts = await findAlerts(human.id);
      expect(alerts).toHaveLength(1);
      const details = alerts[0]?.payload as Record<string, unknown>;
      expect(details).toMatchObject({
        branch: 'feat/INV-9997-ghost-branch',
        identifier: 'INV-9997',
        reason: 'unknown-identifier',
        prNumber: null,
        sender: 'fake-agent',
      });
    });
  });

  describe('Project Alias Routing (INV-459)', () => {
    const LUMENBOX_REPO = 'fakechris/lumenbox';
    const ALERT_TYPE = 'ops.github.pr_unverified_reference';

    beforeEach(async () => {
      await prisma.notification.deleteMany();
    });

    async function createLumenboxProject(): Promise<Issue> {
      const project = await createIssue(prisma, {
        kind: 'PROJECT',
        repository: LUMENBOX_REPO,
        teamId: team.id,
        title: 'lumenbox project',
      });
      return updateIssue(prisma, project.id, { alias: 'LUM' });
    }

    function aliasRefFor(issue: Issue): string {
      return `LUM-${issue.identifier.split('-')[1]}`;
    }

    async function processLumenboxPrOpened(issue: Issue, prId: number): Promise<void> {
      await processGitHubPrEvent(prisma, {
        action: 'opened',
        pull_request: {
          id: prId,
          number: prId,
          title: `feat: [${aliasRefFor(issue)}] aliased change`,
          html_url: `https://github.com/fakechris/lumenbox/pull/${prId}`,
          merged: false,
          head: { ref: `feat/${aliasRefFor(issue)}-x` },
          updated_at: '2026-09-11T10:00:00.000Z',
        },
        repository: { full_name: LUMENBOX_REPO },
        sender: { login: 'fake-agent' },
      });
    }

    it('derives the route from the PROJECT node and falls back to static routes', async () => {
      const project = await createLumenboxProject();

      const route = await resolveRepoRoute(prisma, LUMENBOX_REPO);
      expect(route).not.toBeNull();
      expect(route?.teamKey).toBe('INV');
      expect(route?.alias).toBe('LUM');
      expect(route?.projectId).toBe(project.id);
      expect(extractIssueIdentifiers('INV-1', route!)).toEqual(['INV-1']);
      expect(extractIssueIdentifiers('LUM-1', route!)).toEqual(['LUM-1']);

      // No PROJECT node owns fakechris/Involute here → static fallback.
      const fallback = await resolveRepoRoute(prisma, 'fakechris/Involute');
      expect(fallback?.teamKey).toBe('INV');
      expect(fallback?.alias).toBeUndefined();

      expect(await resolveRepoRoute(prisma, 'unknown/repo')).toBeNull();
    });

    it('drives the canonical issue through the state machine for an alias reference with matching membership', async () => {
      await createLumenboxProject();
      const issue = await createTestIssue('Alias routed work');
      await updateIssue(prisma, issue.id, { repository: LUMENBOX_REPO });

      await processLumenboxPrOpened(issue, 31001);

      const updated = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(updated.state.type).toBe('REVIEW');
      expect(
        await prisma.notification.count({ where: { type: ALERT_TYPE } }),
      ).toBe(0);
    });

    it('alerts project-mismatch and skips when the alias membership claim is wrong', async () => {
      await createLumenboxProject();
      // Issue belongs to no project (repository null): the LUM- alias asserts
      // lumenbox membership, which is false.
      const issue = await createTestIssue('Wrong-project alias target');

      await processLumenboxPrOpened(issue, 31002);

      const untouched = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(untouched.state.type).toBe('UNSTARTED');

      const alerts = await prisma.notification.findMany({
        where: { type: ALERT_TYPE, userId: human.id },
      });
      expect(alerts).toHaveLength(1);
      const details = alerts[0]?.payload as Record<string, unknown>;
      expect(details).toMatchObject({
        repository: LUMENBOX_REPO,
        identifier: issue.identifier,
        reason: 'project-mismatch',
      });
    });

    it('processes INV-prefixed references on an alias-routed repo normally (no membership assertion)', async () => {
      await createLumenboxProject();
      const issue = await createTestIssue('Direct reference on lumenbox');

      await processGitHubPrEvent(prisma, {
        action: 'opened',
        pull_request: {
          id: 31003,
          number: 31003,
          title: `feat: [${issue.identifier}] direct ref`,
          html_url: 'https://github.com/fakechris/lumenbox/pull/31003',
          merged: false,
          head: { ref: `feat/${issue.identifier}-direct` },
          updated_at: '2026-09-11T11:00:00.000Z',
        },
        repository: { full_name: LUMENBOX_REPO },
        sender: { login: 'fake-agent' },
      });

      const updated = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        include: { state: true },
      });
      expect(updated.state.type).toBe('REVIEW');
      expect(
        await prisma.notification.count({ where: { type: ALERT_TYPE } }),
      ).toBe(0);
    });
  });
});
