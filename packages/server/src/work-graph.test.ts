import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { createWorkLink } from './link-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

describe('work graph GraphQL facade', () => {
  let team: Team;
  let viewer: User;
  let ready: WorkflowState;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    viewer = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    ready = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Ready' },
    });
    server = await startServer({
      allowAdminFallback: true,
      prisma,
      authToken: TEST_AUTH_TOKEN,
      port: 0,
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('exposes default work fields and contains links without changing mutation shapes', async () => {
    const createResponse = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              identifier
              kind
              commitmentStatus
              revision
              outcome
              actor: team { key }
            }
          }
        }
      `,
      variables: {
        input: {
          teamId: team.id,
          title: 'Kernel work node',
          stateId: ready.id,
        },
      },
    });

    expectGraphQLSuccess(createResponse);
    expect(createResponse.body.data.issueCreate.success).toBe(true);
    expect(createResponse.body.data.issueCreate.issue).toMatchObject({
      kind: 'ISSUE',
      commitmentStatus: 'COMMITTED',
      revision: 1,
      outcome: null,
    });

    const parentId = createResponse.body.data.issueCreate.issue.identifier as string;
    const parent = await prisma.issue.findUniqueOrThrow({
      where: { identifier: parentId },
    });

    const childCreate = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier revision }
          }
        }
      `,
      variables: {
        input: {
          teamId: team.id,
          title: 'Child work',
          stateId: ready.id,
        },
      },
    });
    expectGraphQLSuccess(childCreate);
    const childId = childCreate.body.data.issueCreate.issue.id as string;

    const updateResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              id
              revision
              parent { id }
              kind
              commitmentStatus
              links(type: CONTAINS) {
                nodes {
                  type
                  from { id }
                  to { id }
                }
              }
            }
          }
        }
      `,
      variables: {
        id: childId,
        input: {
          parentId: parent.id,
        },
      },
    });

    expectGraphQLSuccess(updateResponse);
    expect(updateResponse.body.data.issueUpdate.issue).toMatchObject({
      revision: 2,
      kind: 'ISSUE',
      commitmentStatus: 'COMMITTED',
      parent: { id: parent.id },
      links: {
        nodes: [
          {
            type: 'CONTAINS',
            from: { id: parent.id },
            to: { id: childId },
          },
        ],
      },
    });

    const viewerResponse = await postGraphQL({
      query: `{ viewer { email actorKind globalRole } }`,
    });
    expectGraphQLSuccess(viewerResponse);
    expect(viewerResponse.body.data.viewer).toMatchObject({
      email: viewer.email,
      actorKind: 'HUMAN',
    });

    const audits = await prisma.workAudit.findMany({
      where: { workId: childId },
      orderBy: { revision: 'asc' },
    });
    expect(audits.map((audit) => audit.revision)).toEqual([1, 2]);
    expect(audits[1]?.actorId).toBe(viewer.id);
    expect(audits[1]?.surface).toBe('graphql');
  });

  it('returns workContext and readyWork without requiring IssueFilter composition', async () => {
    const parentCreate = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }
      `,
      variables: { input: { teamId: team.id, title: 'Parent epic', stateId: ready.id } },
    });
    expectGraphQLSuccess(parentCreate);
    const parent = parentCreate.body.data.issueCreate.issue as { id: string; identifier: string };

    const childCreate = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }
      `,
      variables: { input: { teamId: team.id, title: 'Ready child', stateId: ready.id } },
    });
    expectGraphQLSuccess(childCreate);
    const child = childCreate.body.data.issueCreate.issue as { id: string; identifier: string };

    const blockerCreate = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }
      `,
      variables: { input: { teamId: team.id, title: 'Blocker', stateId: ready.id } },
    });
    expectGraphQLSuccess(blockerCreate);

    await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id } }
        }
      `,
      variables: { id: child.id, input: { parentId: parent.id } },
    });

    await createWorkLink(prisma, {
      fromId: blockerCreate.body.data.issueCreate.issue.id,
      toId: child.id,
      type: 'BLOCKS',
    });
    await prisma.issue.updateMany({
      where: {
        id: {
          in: [parent.id, child.id, blockerCreate.body.data.issueCreate.issue.id],
        },
      },
      data: { acceptance: 'ready contract', assigneeId: viewer.id },
    });

    const contextResponse = await postGraphQL({
      query: `
        query WorkContext($id: String!) {
          workContext(id: $id) {
            work { identifier title commitmentStatus revision }
            ancestors { identifier title }
            blockedBy { identifier }
            blocks { identifier }
            audits { revision actorKind surface }
          }
        }
      `,
      variables: { id: child.identifier },
    });
    expectGraphQLSuccess(contextResponse);
    expect(contextResponse.body.data.workContext.work.identifier).toBe(child.identifier);
    expect(contextResponse.body.data.workContext.ancestors).toEqual([
      { identifier: parent.identifier, title: 'Parent epic' },
    ]);
    expect(contextResponse.body.data.workContext.blockedBy).toEqual([
      { identifier: blockerCreate.body.data.issueCreate.issue.identifier },
    ]);

    const readyResponse = await postGraphQL({
      query: `
        query ReadyWork($filter: ReadyWorkFilter) {
          readyWork(filter: $filter) {
            nodes { identifier title }
          }
        }
      `,
    });
    expectGraphQLSuccess(readyResponse);
    const readyIds = readyResponse.body.data.readyWork.nodes.map(
      (issue: { identifier: string }) => issue.identifier,
    );
    expect(readyIds).toContain(parent.identifier);
    expect(readyIds).toContain(blockerCreate.body.data.issueCreate.issue.identifier);
    expect(readyIds).not.toContain(child.identifier);
  });

  it('proposes candidates, commits with a human owner, and lets an agent claim without taking assignee', async () => {
    const propose = await postGraphQL({
      query: `
        mutation Propose($input: WorkProposeInput!) {
          workPropose(input: $input) {
            success
            issue { identifier commitmentStatus revision }
          }
        }
      `,
      variables: {
        input: {
          teamId: team.id,
          title: 'Parser should ignore aborted turns',
          idempotencyKey: 'parser-aborted-turns',
        },
      },
    });
    expectGraphQLSuccess(propose);
    expect(propose.body.data.workPropose.issue.commitmentStatus).toBe('CANDIDATE');
    const identifier = propose.body.data.workPropose.issue.identifier as string;
    const revision = propose.body.data.workPropose.issue.revision as number;

    const replay = await postGraphQL({
      query: `
        mutation Propose($input: WorkProposeInput!) {
          workPropose(input: $input) {
            success
            issue { identifier }
          }
        }
      `,
      variables: {
        input: {
          teamId: team.id,
          title: 'Parser should ignore aborted turns',
          idempotencyKey: 'parser-aborted-turns',
        },
      },
    });
    expectGraphQLSuccess(replay);
    expect(replay.body.data.workPropose.issue.identifier).toBe(identifier);

    const readyBefore = await postGraphQL({
      query: `{ readyWork { nodes { identifier } } }`,
    });
    expectGraphQLSuccess(readyBefore);
    expect(
      readyBefore.body.data.readyWork.nodes.map((issue: { identifier: string }) => issue.identifier),
    ).not.toContain(identifier);

    const commit = await postGraphQL({
      query: `
        mutation Commit($id: String!, $input: WorkCommitInput!) {
          workCommit(id: $id, input: $input) {
            success
            issue { identifier commitmentStatus assignee { id } }
          }
        }
      `,
      variables: {
        id: identifier,
        input: {
          expectedRevision: revision,
          acceptance: 'aborted turns are omitted from extracted issues',
          assigneeId: viewer.id,
        },
      },
    });
    expectGraphQLSuccess(commit);
    expect(commit.body.data.workCommit.issue.commitmentStatus).toBe('COMMITTED');
    expect(commit.body.data.workCommit.issue.assignee.id).toBe(viewer.id);

    const claim = await postGraphQL({
      query: `
        mutation Claim($id: String!) {
          workClaim(id: $id) {
            success
            issue { identifier assignee { id } claim { actor { id } leaseUntil } }
          }
        }
      `,
      variables: { id: identifier },
    });
    expectGraphQLSuccess(claim);
    expect(claim.body.data.workClaim.issue.assignee.id).toBe(viewer.id);
    expect(claim.body.data.workClaim.issue.claim.actor.id).toBe(viewer.id);

    const readyAfter = await postGraphQL({
      query: `{ readyWork { nodes { identifier } } }`,
    });
    expectGraphQLSuccess(readyAfter);
    expect(
      readyAfter.body.data.readyWork.nodes.map((issue: { identifier: string }) => issue.identifier),
    ).not.toContain(identifier);
  });

  it('rejects candidates and lets issues filter by commitmentStatus', async () => {
    const propose = await postGraphQL({
      query: `
        mutation Propose($input: WorkProposeInput!) {
          workPropose(input: $input) {
            success
            issue { identifier commitmentStatus revision }
          }
        }
      `,
      variables: {
        input: {
          teamId: team.id,
          title: 'Speculative parser rewrite',
        },
      },
    });
    expectGraphQLSuccess(propose);
    const identifier = propose.body.data.workPropose.issue.identifier as string;
    const revision = propose.body.data.workPropose.issue.revision as number;

    const candidates = await postGraphQL({
      query: `
        query Candidates($filter: IssueFilter) {
          issues(first: 50, filter: $filter) {
            nodes { identifier commitmentStatus }
          }
        }
      `,
      variables: { filter: { commitmentStatus: 'CANDIDATE' } },
    });
    expectGraphQLSuccess(candidates);
    expect(
      candidates.body.data.issues.nodes.map((issue: { identifier: string }) => issue.identifier),
    ).toContain(identifier);

    const reject = await postGraphQL({
      query: `
        mutation Reject($id: String!, $input: WorkRejectInput!) {
          workReject(id: $id, input: $input) {
            success
            issue { identifier commitmentStatus revision }
          }
        }
      `,
      variables: {
        id: identifier,
        input: {
          expectedRevision: revision,
          reason: 'out of scope for this milestone',
        },
      },
    });
    expectGraphQLSuccess(reject);
    expect(reject.body.data.workReject.issue.commitmentStatus).toBe('REJECTED');

    const afterReject = await postGraphQL({
      query: `
        query Candidates($filter: IssueFilter) {
          issues(first: 50, filter: $filter) {
            nodes { identifier }
          }
        }
      `,
      variables: { filter: { commitmentStatus: 'CANDIDATE' } },
    });
    expectGraphQLSuccess(afterReject);
    expect(
      afterReject.body.data.issues.nodes.map((issue: { identifier: string }) => issue.identifier),
    ).not.toContain(identifier);
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await prismaClient.comment.deleteMany();
  await prismaClient.issue.deleteMany();
  await prismaClient.workflowState.deleteMany();
  await prismaClient.team.deleteMany();
  await prismaClient.issueLabel.deleteMany();
  await prismaClient.user.deleteMany();
  await prismaClient.legacyLinearMapping.deleteMany();
  await seedDatabase(prismaClient);
}

async function postGraphQL({
  query,
  variables,
}: {
  query: string;
  variables?: Record<string, unknown>;
}): Promise<{ body: any; status: number }> {
  const response = await fetch(`${server.url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TEST_AUTH_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  return {
    body: await response.json(),
    status: response.status,
  };
}

function expectGraphQLSuccess(response: { body: any; status: number }): void {
  expect(response.status).toBe(200);
  expect(response.body.errors).toBeUndefined();
}
