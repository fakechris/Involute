import type { GlobalRole, IssueLabel, PrismaClient, User, WorkflowState, WorkflowStateType } from '@prisma/client';
import { GraphQLError } from 'graphql';

import { recordActorAudit } from './actor-lifecycle.js';
import {
  createNotFoundError,
  createValidationError,
  GLOBAL_ROLE_LAST_ADMIN_MESSAGE,
  GLOBAL_ROLE_TARGET_HUMAN_MESSAGE,
  LABEL_NAME_INVALID_MESSAGE,
  LABEL_NAME_TAKEN_MESSAGE,
  LABEL_NOT_FOUND_MESSAGE,
  LABEL_PROTECTED_MESSAGE,
  LABEL_TYPE_NAME_RESERVED_MESSAGE,
  SETTINGS_ADMIN_ONLY_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
  WORKFLOW_STATE_IN_USE_MESSAGE,
  WORKFLOW_STATE_LAST_OF_TYPE_MESSAGE,
  WORKFLOW_STATE_NAME_INVALID_MESSAGE,
  WORKFLOW_STATE_NOT_FOUND_MESSAGE,
} from './errors.js';
import { isTypeLabel } from './labels.js';

/**
 * Workspace settings a person used to change with SQL, env edits or the CLI
 * (INV-797): labels, workflow states, who is an admin, and a read-only view
 * of which server features are on. All of it is for admins.
 */

interface SettingsViewer {
  isTrustedSystem?: boolean;
  viewer?: Pick<User, 'actorKind' | 'globalRole' | 'id'> | null;
}

export function assertSettingsAdmin(context: SettingsViewer): void {
  if (context.isTrustedSystem) return;
  if (context.viewer?.actorKind === 'HUMAN' && context.viewer.globalRole === 'ADMIN') return;
  throw new GraphQLError(SETTINGS_ADMIN_ONLY_MESSAGE, { extensions: { code: 'FORBIDDEN' } });
}

// --- Labels ---------------------------------------------------------------

const MAX_LABEL_LENGTH = 50;
/** Built in: the Type group (INV-748) and the research rule (INV-721) look these up by name. */
const PROTECTED_LABELS = new Set(['bug', 'feature', 'improvement', 'research']);

function labelName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_LABEL_LENGTH) throw createValidationError(LABEL_NAME_INVALID_MESSAGE);
  return name;
}

async function assertLabelNameFree(prisma: PrismaClient, name: string, exceptId?: string): Promise<void> {
  const clash = await prisma.issueLabel.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw createValidationError(LABEL_NAME_TAKEN_MESSAGE);
}

async function findLabel(prisma: PrismaClient, id: string): Promise<IssueLabel> {
  const label = await prisma.issueLabel.findUnique({ where: { id } });
  if (!label) throw createNotFoundError(LABEL_NOT_FOUND_MESSAGE);
  return label;
}

export async function createLabel(prisma: PrismaClient, rawName: string): Promise<IssueLabel> {
  const name = labelName(rawName);
  await assertLabelNameFree(prisma, name);
  return prisma.issueLabel.create({ data: { name } });
}

export async function renameLabel(prisma: PrismaClient, id: string, rawName: string): Promise<IssueLabel> {
  const label = await findLabel(prisma, id);
  const name = labelName(rawName);
  if (PROTECTED_LABELS.has(label.name.toLowerCase())) throw createValidationError(LABEL_PROTECTED_MESSAGE);
  if (isTypeLabel(name)) throw createValidationError(LABEL_TYPE_NAME_RESERVED_MESSAGE);
  await assertLabelNameFree(prisma, name, id);
  return prisma.issueLabel.update({ where: { id }, data: { name } });
}

/** Deletes the label and takes it off every item that carries it. */
export async function deleteLabel(prisma: PrismaClient, id: string): Promise<IssueLabel> {
  const label = await findLabel(prisma, id);
  if (PROTECTED_LABELS.has(label.name.toLowerCase())) throw createValidationError(LABEL_PROTECTED_MESSAGE);
  return prisma.issueLabel.delete({ where: { id } });
}

// --- Workflow states ------------------------------------------------------

const MAX_STATE_NAME_LENGTH = 40;

async function stateName(prisma: PrismaClient, teamId: string, raw: string, exceptId?: string): Promise<string> {
  const name = raw.trim();
  if (!name || name.length > MAX_STATE_NAME_LENGTH) throw createValidationError(WORKFLOW_STATE_NAME_INVALID_MESSAGE);
  const clash = await prisma.workflowState.findFirst({
    where: { teamId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw createValidationError(WORKFLOW_STATE_NAME_INVALID_MESSAGE);
  return name;
}

async function findState(prisma: PrismaClient, id: string): Promise<WorkflowState> {
  const state = await prisma.workflowState.findUnique({ where: { id } });
  if (!state) throw createNotFoundError(WORKFLOW_STATE_NOT_FOUND_MESSAGE);
  return state;
}

/**
 * A new state goes after the team's existing states, so the first state of
 * each type — the one agents and GitHub move work into — stays the same.
 */
export async function createWorkflowState(
  prisma: PrismaClient,
  input: { teamId: string; name: string; type: WorkflowStateType },
): Promise<WorkflowState> {
  const name = await stateName(prisma, input.teamId, input.name);
  const last = await prisma.workflowState.findFirst({
    where: { teamId: input.teamId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return prisma.workflowState.create({
    data: { name, position: (last?.position ?? -1) + 1, teamId: input.teamId, type: input.type },
  });
}

/** Renames and reorders; the type is fixed because automation moves work by type. */
export async function updateWorkflowState(
  prisma: PrismaClient,
  id: string,
  input: { name?: string | null; position?: number | null },
): Promise<WorkflowState> {
  const state = await findState(prisma, id);
  return prisma.workflowState.update({
    where: { id },
    data: {
      ...(input.name != null ? { name: await stateName(prisma, state.teamId, input.name, id) } : {}),
      ...(input.position != null ? { position: input.position } : {}),
    },
  });
}

export async function deleteWorkflowState(prisma: PrismaClient, id: string): Promise<WorkflowState> {
  const state = await findState(prisma, id);
  const [holding, sameType] = await Promise.all([
    prisma.issue.count({ where: { stateId: id } }),
    prisma.workflowState.count({ where: { teamId: state.teamId, type: state.type } }),
  ]);
  if (holding > 0) throw createValidationError(WORKFLOW_STATE_IN_USE_MESSAGE);
  if (sameType <= 1) throw createValidationError(WORKFLOW_STATE_LAST_OF_TYPE_MESSAGE);
  return prisma.workflowState.delete({ where: { id } });
}

// --- Admins ----------------------------------------------------------------

export async function setGlobalRole(
  prisma: PrismaClient,
  input: { byActorId: string | null; reason?: string | null; role: GlobalRole; userId: string },
): Promise<User> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw createNotFoundError(USER_NOT_FOUND_MESSAGE);
    if (user.actorKind !== 'HUMAN') throw createValidationError(GLOBAL_ROLE_TARGET_HUMAN_MESSAGE);
    if (user.globalRole === input.role) return user;
    if (input.role !== 'ADMIN') {
      const admins = await tx.user.count({ where: { actorKind: 'HUMAN', deactivatedAt: null, globalRole: 'ADMIN' } });
      if (admins <= 1) throw createValidationError(GLOBAL_ROLE_LAST_ADMIN_MESSAGE);
    }
    const updated = await tx.user.update({ where: { id: user.id }, data: { globalRole: input.role } });
    await recordActorAudit(tx, {
      action: 'global_role.set',
      after: { globalRole: input.role },
      before: { globalRole: user.globalRole },
      byActorId: input.byActorId,
      reason: input.reason ?? null,
      subjectId: user.id,
    });
    return updated;
  });
}

// --- Server features (read only) -------------------------------------------

export interface ServerFeature {
  detail: string;
  enabled: boolean;
  key: string;
  label: string;
}

/**
 * Which optional server features this deployment runs, read from the same
 * environment the server starts with. Only on/off and counts: never a URL,
 * token, secret or address.
 */
export function listServerFeatures(env: NodeJS.ProcessEnv = process.env): ServerFeature[] {
  const set = (name: string) => Boolean(env[name]?.trim());
  const allowlist = (env.ADMIN_EMAIL_ALLOWLIST ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return [
    {
      key: 'githubSync',
      label: 'GitHub sync',
      enabled: set('GITHUB_TOKEN') || env.GITHUB_SYNC_ENABLED === 'true',
      detail: 'Periodic reconciliation of pull requests (GITHUB_TOKEN or GITHUB_SYNC_ENABLED).',
    },
    {
      key: 'githubInbound',
      label: 'GitHub webhooks',
      enabled: set('GITHUB_WEBHOOK_SECRET'),
      detail: 'Receives GitHub webhook deliveries (GITHUB_WEBHOOK_SECRET).',
    },
    {
      key: 'evidenceVerifier',
      label: 'Evidence verifier',
      enabled: env.EVIDENCE_VERIFIER_ENABLED === 'true',
      detail: 'Checks attached evidence against GitHub; shadow only (EVIDENCE_VERIFIER_ENABLED).',
    },
    {
      key: 'emailNotifications',
      label: 'Email notifications',
      enabled: env.NOTIFICATION_EMAIL_ENABLED === 'true',
      detail: 'Sends inbox notifications by email (NOTIFICATION_EMAIL_ENABLED).',
    },
    {
      key: 'opsWebhook',
      label: 'Ops alert webhook',
      enabled: set('OPS_WEBHOOK_URL'),
      detail: 'Posts ops alerts to chat or paging (OPS_WEBHOOK_URL).',
    },
    {
      key: 'outboundWebhook',
      label: 'Static event webhook',
      enabled: set('INVOLUTE_WEBHOOK_URL'),
      detail: 'Work events posted to a fixed URL besides subscriptions (INVOLUTE_WEBHOOK_URL).',
    },
    {
      key: 'googleOAuth',
      label: 'Google sign-in',
      enabled: set('GOOGLE_OAUTH_CLIENT_ID'),
      detail: 'People sign in with Google (GOOGLE_OAUTH_CLIENT_ID).',
    },
    {
      key: 'adminEmailAllowlist',
      label: 'Admin email allowlist',
      enabled: allowlist.length > 0,
      detail: `${allowlist.length} address${allowlist.length === 1 ? '' : 'es'} become admins on sign-in (ADMIN_EMAIL_ALLOWLIST).`,
    },
  ];
}
