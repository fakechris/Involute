import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { createIssue } from './issue-service.ts';
import { createWorkLink } from './link-service.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

// Fixture identifiers must never collide within a run (the column is unique).
let identifierSeq = 0;
const nextIdentifierSuffix = () => String((identifierSeq += 1)).padStart(4, '0');

// Direct creation needs a parent (INV-744): the repository's project, made on first use.
async function projectId(teamId: string, repository = 'fakechris/Involute'): Promise<string> {
  const existing = await prisma.issue.findFirst({ where: { teamId, kind: 'PROJECT', repository }, select: { id: true } });
  return existing?.id ?? (await createIssue(prisma, { teamId, kind: 'PROJECT', title: repository, repository })).id;
}

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
          parentId: await projectId(team.id),
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

    await prisma.issue.update({ where: { id: parent.id }, data: { kind: 'MILESTONE', repository: 'fakechris/Involute' } });

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
          title: 'Child work', repository: 'fakechris/Involute',
          stateId: ready.id,
          parentId: await projectId(team.id),
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

  it('creates project issues and manages CONTAINS links via workLink and workLinkDelete', async () => {
    const projectCreate = await postGraphQL({
      query: `
        mutation CreateProjectIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              identifier
              kind
              title
              assignee { id name }
            }
          }
        }
      `,
      variables: {
        input: {
          teamId: team.id,
          title: 'Infrastructure Project', repository: 'fakechris/Involute',
          kind: 'PROJECT',
          assigneeId: viewer.id,
          stateId: ready.id,
        },
      },
    });

    expectGraphQLSuccess(projectCreate);
    expect(projectCreate.body.data.issueCreate.success).toBe(true);
    const project = projectCreate.body.data.issueCreate.issue;
    expect(project.kind).toBe('PROJECT');
    expect(project.assignee.id).toBe(viewer.id);

    const taskCreate = await postGraphQL({
      query: `
        mutation CreateTask($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier kind }
          }
        }
      `,
      variables: {
        input: {
          teamId: team.id,
          title: 'Child milestone', kind: 'MILESTONE', repository: 'fakechris/Involute',
          stateId: ready.id,
          parentId: project.id,
        },
      },
    });
    const task = taskCreate.body.data.issueCreate.issue;
    // Created in place (INV-744); unlink it to exercise workLink below.
    const placed = await prisma.workLink.findFirstOrThrow({ where: { fromId: project.id, toId: task.id, type: 'CONTAINS' } });
    expectGraphQLSuccess(
      await postGraphQL({ query: `mutation($id: String!) { workLinkDelete(id: $id) { success } }`, variables: { id: placed.id } }),
    );

    const linkCreate = await postGraphQL({
      query: `
        mutation LinkWork($fromId: String!, $toId: String!, $type: WorkLinkType!) {
          workLink(fromId: $fromId, toId: $toId, type: $type) {
            success
            link { id type }
          }
        }
      `,
      variables: {
        fromId: project.id,
        toId: task.id,
        type: 'CONTAINS',
      },
    });

    expectGraphQLSuccess(linkCreate);
    expect(linkCreate.body.data.workLink.success).toBe(true);
    const linkId = linkCreate.body.data.workLink.link.id;

    const taskCheck = await prisma.issue.findUniqueOrThrow({
      where: { id: task.id },
      select: { parentId: true },
    });
    expect(taskCheck.parentId).toBe(project.id);

    const linkDelete = await postGraphQL({
      query: `
        mutation DeleteWorkLink($id: String!) {
          workLinkDelete(id: $id) {
            success
            id
          }
        }
      `,
      variables: { id: linkId },
    });
    expectGraphQLSuccess(linkDelete);
    expect(linkDelete.body.data.workLinkDelete.success).toBe(true);

    const taskAfterDelete = await prisma.issue.findUniqueOrThrow({
      where: { id: task.id },
      select: { parentId: true },
    });
    expect(taskAfterDelete.parentId).toBeNull();
    const deleteAudit = await prisma.workAudit.findFirstOrThrow({ where: { workId: task.id }, orderBy: { createdAt: 'desc' } });
    expect(deleteAudit).toMatchObject({ actorId: viewer.id, actorKind: 'HUMAN' });
  });

  it('returns workContext and readyWork without requiring IssueFilter composition', async () => {
    const parentCreate = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }
      `,
      variables: { input: { teamId: team.id, title: 'Parent milestone', kind: 'MILESTONE', repository: 'fakechris/Involute', stateId: ready.id, parentId: await projectId(team.id) } },
    });
    expectGraphQLSuccess(parentCreate);
    const parent = parentCreate.body.data.issueCreate.issue as { id: string; identifier: string };

    const childCreate = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }
      `,
      variables: { input: { teamId: team.id, title: 'Ready child', repository: 'fakechris/Involute', stateId: ready.id, parentId: await projectId(team.id) } },
    });
    expectGraphQLSuccess(childCreate);
    const child = childCreate.body.data.issueCreate.issue as { id: string; identifier: string };

    const blockerCreate = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }
      `,
      variables: { input: { teamId: team.id, title: 'Blocker', stateId: ready.id, parentId: await projectId(team.id) } },
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
      { identifier: 'INV-1', title: 'fakechris/Involute' },
      { identifier: parent.identifier, title: 'Parent milestone' },
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

  it('lists only still-open committed blockers as openBlockers, in list and single reads alike', async () => {
    const done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'COMPLETED' } });
    const make = (title: string, extra: Record<string, unknown> = {}) =>
      prisma.issue.create({
        data: {
          identifier: `INV-9${nextIdentifierSuffix()}`,
          title,
          teamId: team.id,
          stateId: ready.id,
          ...extra,
        },
      });
    const blocked = await make('Blocked work');
    const openBlocker = await make('Open blocker');
    const doneBlocker = await make('Done blocker', { stateId: done.id });
    const candidateBlocker = await make('Candidate blocker', { commitmentStatus: 'CANDIDATE' });
    const related = await make('Related only');
    for (const from of [openBlocker, doneBlocker, candidateBlocker]) {
      await createWorkLink(prisma, { fromId: from.id, toId: blocked.id, type: 'BLOCKS' });
    }
    await createWorkLink(prisma, { fromId: related.id, toId: blocked.id, type: 'RELATED_TO' });

    const listResponse = await postGraphQL({
      query: `
        query Issues($first: Int!) {
          issues(first: $first) { nodes { id openBlockers { id identifier } } }
        }
      `,
      variables: { first: 50 },
    });
    expectGraphQLSuccess(listResponse);
    const nodes = listResponse.body.data.issues.nodes as Array<{ id: string; openBlockers: Array<{ id: string }> }>;
    expect(nodes.find((node) => node.id === blocked.id)?.openBlockers).toEqual([
      { id: openBlocker.id, identifier: openBlocker.identifier },
    ]);
    expect(nodes.find((node) => node.id === openBlocker.id)?.openBlockers).toEqual([]);

    const singleResponse = await postGraphQL({
      query: `query Issue($id: String!) { issue(id: $id) { openBlockers { id } } }`,
      variables: { id: blocked.id },
    });
    expectGraphQLSuccess(singleResponse);
    expect(singleResponse.body.data.issue.openBlockers).toEqual([{ id: openBlocker.id }]);

    await prisma.issue.update({ where: { id: openBlocker.id }, data: { stateId: done.id } });
    const afterDone = await postGraphQL({
      query: `query Issue($id: String!) { issue(id: $id) { openBlockers { id } } }`,
      variables: { id: blocked.id },
    });
    expectGraphQLSuccess(afterDone);
    expect(afterDone.body.data.issue.openBlockers).toEqual([]);
  });

  it('says why workLink refused instead of a bare success:false', async () => {
    const make = (title: string) =>
      prisma.issue.create({
        data: { identifier: `INV-8${nextIdentifierSuffix()}`, title, teamId: team.id, stateId: ready.id },
      });
    const upstream = await make('Upstream');
    const downstream = await make('Downstream');
    await createWorkLink(prisma, { fromId: upstream.id, toId: downstream.id, type: 'BLOCKS' });
    const mutation = `
      mutation WorkLink($fromId: String!, $toId: String!) {
        workLink(fromId: $fromId, toId: $toId, type: BLOCKS) { success message link { id } }
      }
    `;

    const cycle = await postGraphQL({ query: mutation, variables: { fromId: downstream.id, toId: upstream.id } });
    expectGraphQLSuccess(cycle);
    expect(cycle.body.data.workLink).toMatchObject({ success: false, link: null });
    expect(cycle.body.data.workLink.message).toEqual(expect.stringMatching(/cycle/i));

    const unknown = await postGraphQL({ query: mutation, variables: { fromId: 'INV-99999', toId: upstream.id } });
    expectGraphQLSuccess(unknown);
    expect(unknown.body.data.workLink.success).toBe(false);
    expect(unknown.body.data.workLink.message).toEqual(expect.any(String));

    const ok = await postGraphQL({ query: mutation, variables: { fromId: downstream.identifier, toId: (await make('Third')).id } });
    expectGraphQLSuccess(ok);
    expect(ok.body.data.workLink).toMatchObject({ success: true, message: null });
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
          parentId: await testParentId(prisma, team.id),
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
          parentId: await testParentId(prisma, team.id),
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

  it('says why a commit was refused and commits once a parent is given (INV-719)', async () => {
    const propose = await postGraphQL({
      query: `mutation($input: WorkProposeInput!) { workPropose(input: $input) { issue { id revision } } }`,
      variables: { input: { teamId: team.id, title: 'Unplaced', repository: 'test/placement' } },
    });
    expectGraphQLSuccess(propose);
    const { id, revision } = propose.body.data.workPropose.issue as { id: string; revision: number };
    const commit = (input: Record<string, unknown>) =>
      postGraphQL({
        query: `mutation($id: String!, $input: WorkCommitInput!) { workCommit(id: $id, input: $input) { success message issue { parent { id } } } }`,
        variables: { id, input: { expectedRevision: revision, acceptance: 'placed', assigneeId: viewer.id, ...input } },
      });

    const refused = await commit({});
    expectGraphQLSuccess(refused);
    expect(refused.body.data.workCommit).toMatchObject({ success: false, issue: null });
    expect(refused.body.data.workCommit.message).toContain('requires a parent');

    const parentId = await testParentId(prisma, team.id);
    const placed = await commit({ parentId });
    expectGraphQLSuccess(placed);
    expect(placed.body.data.workCommit).toMatchObject({ success: true, message: null, issue: { parent: { id: parentId } } });
  });

  it('lets a human rewrite committed contract fields and says why a cleared acceptance is refused', async () => {
    const work = await prisma.issue.create({
      data: {
        acceptance: 'docs/research lands in the repo',
        assigneeId: viewer.id,
        commitmentStatus: 'COMMITTED',
        identifier: `INV-C${nextIdentifierSuffix()}`,
        parentId: await projectId(team.id),
        scope: 'research doc in docs/research',
        stateId: ready.id,
        teamId: team.id,
        title: 'Contract under revision',
      },
    });
    const update = (input: Record<string, unknown>) =>
      postGraphQL({
        query: `
          mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
              message
              issue { revision outcome scope constraints acceptance verification }
            }
          }
        `,
        variables: { id: work.id, input },
      });

    const rewritten = await update({
      expectedRevision: work.revision,
      outcome: 'research stays local',
      scope: 'only one line in docs/73',
      constraints: 'no vendor source in the repo',
      acceptance: 'docs/73 has the row',
      verification: 'docs-lint passes',
    });
    expectGraphQLSuccess(rewritten);
    expect(rewritten.body.data.issueUpdate).toMatchObject({
      success: true,
      message: null,
      issue: {
        revision: work.revision + 1,
        outcome: 'research stays local',
        scope: 'only one line in docs/73',
        constraints: 'no vendor source in the repo',
        acceptance: 'docs/73 has the row',
        verification: 'docs-lint passes',
      },
    });
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: work.id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(audit)).toContain('only one line in docs/73');

    const cleared = await update({ acceptance: '  ' });
    expectGraphQLSuccess(cleared);
    expect(cleared.body.data.issueUpdate).toMatchObject({ success: false, issue: null });
    expect(cleared.body.data.issueUpdate.message).toContain('requires acceptance');

    const stale = await update({ expectedRevision: work.revision, scope: 'stale write' });
    expect(stale.body.data.issueUpdate.success).toBe(false);
    expect(stale.body.data.issueUpdate.message).toBeTruthy();
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
  // ActorAudit references users with Restrict (INV-586/604): it goes first.
  await prismaClient.actorAudit.deleteMany();
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
