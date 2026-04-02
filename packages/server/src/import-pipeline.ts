/**
 * Import pipeline — reads exported Linear data and writes to Involute database via Prisma.
 *
 * Steps:
 * 1. Read export directory (teams.json, workflow_states.json, labels.json, users.json, issues.json, comments/)
 * 2. Import teams — upsert by key
 * 3. Import workflow states — upsert per team
 * 4. Import labels — upsert by name
 * 5. Import users — upsert by email
 * 6. Import issues WITHOUT parentId first — preserve identifier and timestamps. Build old_id→new_id mapping.
 * 7. Backfill parentId using mapping
 * 8. Import comments in createdAt order, preserving original timestamps
 * 9. Write legacy_linear_mapping table entries for all entities
 * 10. Idempotent: re-import skips already-imported records (check mapping table)
 */

import type { PrismaClient } from '@prisma/client';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';

// --- Types matching the Linear export format ---

interface ExportedTeam {
  id: string;
  key: string;
  name: string;
}

interface ExportedWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  team: { id: string };
}

interface ExportedLabel {
  id: string;
  name: string;
  color: string;
}

interface ExportedUser {
  id: string;
  name: string;
  email: string;
  displayName: string;
  active: boolean;
}

interface ExportedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  state: { id: string; name: string };
  team: { id: string; key: string };
  assignee: { id: string; name: string; email: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
  parent: { id: string } | null;
}

interface ExportedComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; email: string } | null;
}

export type ProgressCallback = (message: string) => void;

export interface ImportResult {
  counts: {
    teams: number;
    workflowStates: number;
    labels: number;
    users: number;
    issues: number;
    comments: number;
    parentChildBackfills: number;
  };
  skipped: {
    teams: number;
    workflowStates: number;
    labels: number;
    users: number;
    issues: number;
    comments: number;
  };
  warnings: {
    orphanCommentFallbacks: number;
  };
}

const ORPHAN_COMMENT_USER_EMAIL = 'orphan-comments@involute.import';
const ORPHAN_COMMENT_USER_NAME = 'Imported Orphan Comment User';

// --- File reading helpers ---

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// --- ID mapping helpers ---

async function getExistingMappings(
  prisma: PrismaClient,
  entityType: string,
): Promise<Map<string, string>> {
  const mappings = await prisma.legacyLinearMapping.findMany({
    where: { entityType },
  });
  return new Map(mappings.map((m) => [m.oldId, m.newId]));
}

async function createMapping(
  prisma: PrismaClient,
  oldId: string,
  newId: string,
  entityType: string,
): Promise<void> {
  await prisma.legacyLinearMapping.upsert({
    where: {
      oldId_entityType: { oldId, entityType },
    },
    create: { oldId, newId, entityType },
    update: {},
  });
}

// --- Import steps ---

async function importTeams(
  prisma: PrismaClient,
  teams: ExportedTeam[],
  onProgress?: ProgressCallback,
): Promise<{ idMap: Map<string, string>; imported: number; skipped: number }> {
  onProgress?.(`Importing ${String(teams.length)} teams...`);
  const existingMappings = await getExistingMappings(prisma, 'team');
  const idMap = new Map<string, string>(existingMappings);
  let imported = 0;
  let skipped = 0;

  for (const team of teams) {
    if (existingMappings.has(team.id)) {
      skipped++;
      continue;
    }

    const created = await prisma.team.upsert({
      where: { key: team.key },
      create: { key: team.key, name: team.name },
      update: { name: team.name },
    });

    idMap.set(team.id, created.id);
    await createMapping(prisma, team.id, created.id, 'team');
    imported++;
  }

  onProgress?.(`  Teams: ${String(imported)} imported, ${String(skipped)} skipped`);
  return { idMap, imported, skipped };
}

async function importWorkflowStates(
  prisma: PrismaClient,
  states: ExportedWorkflowState[],
  teamIdMap: Map<string, string>,
  onProgress?: ProgressCallback,
): Promise<{ idMap: Map<string, string>; imported: number; skipped: number }> {
  onProgress?.(`Importing ${String(states.length)} workflow states...`);
  const existingMappings = await getExistingMappings(prisma, 'workflow_state');
  const idMap = new Map<string, string>(existingMappings);
  let imported = 0;
  let skipped = 0;

  for (const state of states) {
    if (existingMappings.has(state.id)) {
      skipped++;
      continue;
    }

    const newTeamId = teamIdMap.get(state.team.id);

    if (!newTeamId) {
      continue;
    }

    const created = await prisma.workflowState.upsert({
      where: {
        teamId_name: { teamId: newTeamId, name: state.name },
      },
      create: { name: state.name, teamId: newTeamId },
      update: {},
    });

    idMap.set(state.id, created.id);
    await createMapping(prisma, state.id, created.id, 'workflow_state');
    imported++;
  }

  onProgress?.(`  Workflow states: ${String(imported)} imported, ${String(skipped)} skipped`);
  return { idMap, imported, skipped };
}

async function importLabels(
  prisma: PrismaClient,
  labels: ExportedLabel[],
  onProgress?: ProgressCallback,
): Promise<{ idMap: Map<string, string>; imported: number; skipped: number }> {
  onProgress?.(`Importing ${String(labels.length)} labels...`);
  const existingMappings = await getExistingMappings(prisma, 'label');
  const idMap = new Map<string, string>(existingMappings);
  let imported = 0;
  let skipped = 0;

  for (const label of labels) {
    if (existingMappings.has(label.id)) {
      skipped++;
      continue;
    }

    const created = await prisma.issueLabel.upsert({
      where: { name: label.name },
      create: { name: label.name },
      update: {},
    });

    idMap.set(label.id, created.id);
    await createMapping(prisma, label.id, created.id, 'label');
    imported++;
  }

  onProgress?.(`  Labels: ${String(imported)} imported, ${String(skipped)} skipped`);
  return { idMap, imported, skipped };
}

async function importUsers(
  prisma: PrismaClient,
  users: ExportedUser[],
  onProgress?: ProgressCallback,
): Promise<{ idMap: Map<string, string>; imported: number; skipped: number }> {
  onProgress?.(`Importing ${String(users.length)} users...`);
  const existingMappings = await getExistingMappings(prisma, 'user');
  const idMap = new Map<string, string>(existingMappings);
  let imported = 0;
  let skipped = 0;

  for (const user of users) {
    if (existingMappings.has(user.id)) {
      skipped++;
      continue;
    }

    const created = await prisma.user.upsert({
      where: { email: user.email },
      create: { name: user.name, email: user.email },
      update: { name: user.name },
    });

    idMap.set(user.id, created.id);
    await createMapping(prisma, user.id, created.id, 'user');
    imported++;
  }

  onProgress?.(`  Users: ${String(imported)} imported, ${String(skipped)} skipped`);
  return { idMap, imported, skipped };
}

async function importIssues(
  prisma: PrismaClient,
  issues: ExportedIssue[],
  teamIdMap: Map<string, string>,
  stateIdMap: Map<string, string>,
  userIdMap: Map<string, string>,
  labelIdMap: Map<string, string>,
  onProgress?: ProgressCallback,
): Promise<{ idMap: Map<string, string>; imported: number; skipped: number }> {
  onProgress?.(`Importing ${String(issues.length)} issues (without parent references)...`);
  const existingMappings = await getExistingMappings(prisma, 'issue');
  const idMap = new Map<string, string>(existingMappings);
  let imported = 0;
  let skipped = 0;

  for (const issue of issues) {
    if (existingMappings.has(issue.id)) {
      skipped++;
      continue;
    }

    const newTeamId = teamIdMap.get(issue.team.id);
    const newStateId = stateIdMap.get(issue.state.id);

    if (!newTeamId || !newStateId) {
      continue;
    }

    const newAssigneeId = issue.assignee ? userIdMap.get(issue.assignee.id) ?? null : null;

    const labelConnections = issue.labels.nodes
      .map((label) => labelIdMap.get(label.id))
      .filter((id): id is string => id !== undefined)
      .map((id) => ({ id }));

    const data: Parameters<typeof prisma.issue.create>[0]['data'] = {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      stateId: newStateId,
      teamId: newTeamId,
      assigneeId: newAssigneeId,
      createdAt: new Date(issue.createdAt),
      updatedAt: new Date(issue.updatedAt),
    };

    if (labelConnections.length > 0) {
      data.labels = { connect: labelConnections };
    }

    const created = await prisma.issue.create({ data });

    idMap.set(issue.id, created.id);
    await createMapping(prisma, issue.id, created.id, 'issue');
    imported++;
  }

  onProgress?.(`  Issues: ${String(imported)} imported, ${String(skipped)} skipped`);
  return { idMap, imported, skipped };
}

async function backfillParentIds(
  prisma: PrismaClient,
  issues: ExportedIssue[],
  issueIdMap: Map<string, string>,
  onProgress?: ProgressCallback,
): Promise<number> {
  const issuesWithParent = issues.filter((i) => i.parent !== null);
  onProgress?.(`Backfilling ${String(issuesWithParent.length)} parent-child relationships...`);
  let backfilled = 0;

  for (const issue of issuesWithParent) {
    const newChildId = issueIdMap.get(issue.id);
    const newParentId = issue.parent ? issueIdMap.get(issue.parent.id) : null;

    if (!newChildId || !newParentId) {
      continue;
    }

    // Check if already set (idempotent)
    const existing = await prisma.issue.findUnique({
      where: { id: newChildId },
      select: { parentId: true },
    });

    if (existing?.parentId === newParentId) {
      continue;
    }

    await prisma.issue.update({
      where: { id: newChildId },
      data: { parentId: newParentId },
    });

    backfilled++;
  }

  onProgress?.(`  Parent-child backfills: ${String(backfilled)}`);
  return backfilled;
}

async function importComments(
  prisma: PrismaClient,
  exportDir: string,
  issues: ExportedIssue[],
  issueIdMap: Map<string, string>,
  userIdMap: Map<string, string>,
  onProgress?: ProgressCallback,
): Promise<{ imported: number; skipped: number; orphanCommentFallbacks: number }> {
  onProgress?.('Importing comments...');
  const existingMappings = await getExistingMappings(prisma, 'comment');
  let imported = 0;
  let skipped = 0;
  let orphanCommentFallbacks = 0;

  // Collect all comments across all issues, then sort by createdAt
  const allComments: Array<{
    comment: ExportedComment;
    issueId: string;
  }> = [];

  const commentsDir = join(exportDir, 'comments');

  for (const issue of issues) {
    const commentsFile = join(commentsDir, `${issue.id}.json`);
    const exists = await fileExists(commentsFile);

    if (!exists) {
      continue;
    }

    const comments = await readJsonFile<ExportedComment[]>(commentsFile);

    for (const comment of comments) {
      allComments.push({ comment, issueId: issue.id });
    }
  }

  // Sort all comments by createdAt for chronological import
  allComments.sort((a, b) =>
    a.comment.createdAt.localeCompare(b.comment.createdAt),
  );

  let orphanFallbackUserId: string | null = null;

  for (const { comment, issueId } of allComments) {
    if (existingMappings.has(comment.id)) {
      skipped++;
      continue;
    }

    const newIssueId = issueIdMap.get(issueId);

    if (!newIssueId) {
      continue;
    }

    let newUserId: string | null = null;

    if (comment.user) {
      newUserId = userIdMap.get(comment.user.id) ?? null;
    } else {
      if (!orphanFallbackUserId) {
        const orphanUser = await prisma.user.upsert({
          where: { email: ORPHAN_COMMENT_USER_EMAIL },
          create: {
            name: ORPHAN_COMMENT_USER_NAME,
            email: ORPHAN_COMMENT_USER_EMAIL,
          },
          update: { name: ORPHAN_COMMENT_USER_NAME },
        });
        orphanFallbackUserId = orphanUser.id;
      }

      newUserId = orphanFallbackUserId;
      orphanCommentFallbacks++;
      onProgress?.(
        `  Comment ${comment.id} has null user; imported with fallback user ${ORPHAN_COMMENT_USER_EMAIL}`,
      );
    }

    if (!newUserId) {
      continue;
    }

    const created = await prisma.comment.create({
      data: {
        body: comment.body,
        createdAt: new Date(comment.createdAt),
        updatedAt: new Date(comment.updatedAt),
        issueId: newIssueId,
        userId: newUserId,
      },
    });

    await createMapping(prisma, comment.id, created.id, 'comment');
    imported++;
  }

  onProgress?.(
    `  Comments: ${String(imported)} imported, ${String(skipped)} skipped, ${String(orphanCommentFallbacks)} via fallback user`,
  );
  return { imported, skipped, orphanCommentFallbacks };
}

async function updateTeamNextIssueNumbers(
  prisma: PrismaClient,
  teams: ExportedTeam[],
  issues: ExportedIssue[],
  teamIdMap: Map<string, string>,
): Promise<void> {
  for (const team of teams) {
    const teamIssues = issues.filter((i) => i.team.id === team.id);
    const maxNumber = teamIssues.reduce((max, issue) => {
      const match = issue.identifier.match(/-(\d+)$/);

      if (match) {
        const num = parseInt(match[1]!, 10);
        return Math.max(max, num);
      }

      return max;
    }, 0);

    if (maxNumber > 0) {
      const newTeamId = teamIdMap.get(team.id);

      if (newTeamId) {
        await prisma.team.update({
          where: { id: newTeamId },
          data: { nextIssueNumber: maxNumber + 1 },
        });
      }
    }
  }
}

// --- Main pipeline ---

export async function runImportPipeline(
  prisma: PrismaClient,
  exportDir: string,
  onProgress?: ProgressCallback,
): Promise<ImportResult> {
  onProgress?.(`Reading export data from ${exportDir}...`);

  // Step 1: Read exported data
  const teams = await readJsonFile<ExportedTeam[]>(join(exportDir, 'teams.json'));
  const workflowStates = await readJsonFile<ExportedWorkflowState[]>(
    join(exportDir, 'workflow_states.json'),
  );
  const labels = await readJsonFile<ExportedLabel[]>(join(exportDir, 'labels.json'));
  const users = await readJsonFile<ExportedUser[]>(join(exportDir, 'users.json'));
  const issues = await readJsonFile<ExportedIssue[]>(join(exportDir, 'issues.json'));

  // Step 2: Import teams
  const teamResult = await importTeams(prisma, teams, onProgress);

  // Step 3: Import workflow states
  const stateResult = await importWorkflowStates(
    prisma,
    workflowStates,
    teamResult.idMap,
    onProgress,
  );

  // Step 4: Import labels
  const labelResult = await importLabels(prisma, labels, onProgress);

  // Step 5: Import users
  const userResult = await importUsers(prisma, users, onProgress);

  // Step 6: Import issues without parentId
  const issueResult = await importIssues(
    prisma,
    issues,
    teamResult.idMap,
    stateResult.idMap,
    userResult.idMap,
    labelResult.idMap,
    onProgress,
  );

  // Step 7: Backfill parentId
  const parentChildBackfills = await backfillParentIds(
    prisma,
    issues,
    issueResult.idMap,
    onProgress,
  );

  // Step 8: Import comments
  const commentResult = await importComments(
    prisma,
    exportDir,
    issues,
    issueResult.idMap,
    userResult.idMap,
    onProgress,
  );

  // Update team nextIssueNumber based on imported identifiers
  await updateTeamNextIssueNumbers(prisma, teams, issues, teamResult.idMap);

  onProgress?.('Import complete.');

  return {
    counts: {
      teams: teamResult.imported + teamResult.skipped,
      workflowStates: stateResult.imported + stateResult.skipped,
      labels: labelResult.imported + labelResult.skipped,
      users: userResult.imported + userResult.skipped,
      issues: issueResult.imported + issueResult.skipped,
      comments: commentResult.imported + commentResult.skipped,
      parentChildBackfills,
    },
    skipped: {
      teams: teamResult.skipped,
      workflowStates: stateResult.skipped,
      labels: labelResult.skipped,
      users: userResult.skipped,
      issues: issueResult.skipped,
      comments: commentResult.skipped,
    },
    warnings: {
      orphanCommentFallbacks: commentResult.orphanCommentFallbacks,
    },
  };
}
