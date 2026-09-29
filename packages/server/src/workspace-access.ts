import type { GlobalRole, Prisma, PrismaClient, TeamMembershipRole, User, WorkspaceSettings } from '@prisma/client';

import { recordActorAudit } from './actor-lifecycle.js';
import {
  GLOBAL_ROLE_LAST_ADMIN_MESSAGE,
  INVITE_ALREADY_MEMBER_MESSAGE,
  INVITE_FORBIDDEN_MESSAGE,
  INVITE_ADMIN_FORBIDDEN_MESSAGE,
  INVITE_EMAIL_INVALID_MESSAGE,
  INVITE_NOT_PENDING_MESSAGE,
  GUEST_CANNOT_OWN_TEAM_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
  USER_SUSPEND_HUMANS_ONLY_MESSAGE,
  USER_ALREADY_SUSPENDED_MESSAGE,
  USER_NOT_SUSPENDED_MESSAGE,
  USER_SUSPEND_SELF_MESSAGE,
  WORKSPACE_DEFAULT_TEAM_INVALID_MESSAGE,
  WORKSPACE_DOMAIN_INVALID_MESSAGE,
  createNotFoundError,
  createValidationError,
} from './errors.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * Workspace access (INV-847, docs/permissions.md §1–2).
 *
 * Sign-in is invite-only: a Google account gets in when a user row already
 * exists for it (everyone who signed in before, and everyone invited), when
 * its domain is approved, or — to bootstrap a fresh server — when it is on
 * ADMIN_EMAIL_ALLOWLIST. An invite *is* a user row created before the first
 * sign-in; it stays "pending" until Google links it.
 */

export const WORKSPACE_SETTINGS_ID = 'workspace';

export interface WorkspaceAccessSettings {
  approvedDomains: string[];
  defaultTeamIds: string[];
  membersCanCreateTeams: boolean;
  membersCanInvite: boolean;
}

const DEFAULT_SETTINGS: WorkspaceAccessSettings = {
  approvedDomains: [],
  defaultTeamIds: [],
  membersCanCreateTeams: false,
  membersCanInvite: false,
};

export async function getWorkspaceSettings(prisma: DatabaseClient): Promise<WorkspaceAccessSettings> {
  const row = await prisma.workspaceSettings.findUnique({ where: { id: WORKSPACE_SETTINGS_ID } });
  return row ? pickSettings(row) : { ...DEFAULT_SETTINGS };
}

function pickSettings(row: WorkspaceSettings): WorkspaceAccessSettings {
  return {
    approvedDomains: row.approvedDomains,
    defaultTeamIds: row.defaultTeamIds,
    membersCanCreateTeams: row.membersCanCreateTeams,
    membersCanInvite: row.membersCanInvite,
  };
}

const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '');
}

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

export async function updateWorkspaceSettings(
  prisma: PrismaClient,
  input: Partial<WorkspaceAccessSettings> & { byActorId: string },
): Promise<WorkspaceAccessSettings> {
  const current = await getWorkspaceSettings(prisma);
  const next: WorkspaceAccessSettings = { ...current };

  if (input.approvedDomains !== undefined) {
    const domains = [...new Set(input.approvedDomains.map(normalizeDomain).filter(Boolean))];
    if (domains.some((domain) => !DOMAIN_SHAPE.test(domain))) {
      throw createValidationError(WORKSPACE_DOMAIN_INVALID_MESSAGE);
    }
    next.approvedDomains = domains;
  }
  if (input.defaultTeamIds !== undefined) {
    const ids = [...new Set(input.defaultTeamIds)];
    const found = await prisma.team.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw createValidationError(WORKSPACE_DEFAULT_TEAM_INVALID_MESSAGE);
    next.defaultTeamIds = ids;
  }
  if (input.membersCanInvite !== undefined) next.membersCanInvite = input.membersCanInvite;
  if (input.membersCanCreateTeams !== undefined) next.membersCanCreateTeams = input.membersCanCreateTeams;

  return prisma.$transaction(async (tx) => {
    const saved = await tx.workspaceSettings.upsert({
      where: { id: WORKSPACE_SETTINGS_ID },
      create: { id: WORKSPACE_SETTINGS_ID, ...next, updatedById: input.byActorId },
      update: { ...next, updatedById: input.byActorId },
    });
    // Recorded against the admin who changed it: the workspace has no actor row of its own.
    await recordActorAudit(tx, {
      action: 'workspace_settings.update',
      after: { ...next },
      before: { ...current },
      byActorId: input.byActorId,
      subjectId: input.byActorId,
    });
    return pickSettings(saved);
  });
}

// --- Sign-in ---------------------------------------------------------------

export type SignInRefusal = 'not_invited' | 'suspended';

export class SignInRefusedError extends Error {
  constructor(readonly reason: SignInRefusal) {
    super(reason === 'suspended'
      ? 'This account is suspended. Ask an admin to reactivate it.'
      : 'This workspace is invite-only. Ask an admin to invite you.');
  }
}

export interface SignInProfile {
  email: string;
  name: string;
  picture: string | null;
  subject: string;
}

async function activeAdminCount(prisma: DatabaseClient): Promise<number> {
  return prisma.user.count({ where: { actorKind: 'HUMAN', deactivatedAt: null, globalRole: 'ADMIN' } });
}

/**
 * Link or create the user behind a verified Google profile, or refuse.
 * `existing` is the row already found by subject or email (the caller checks
 * for account conflicts first).
 */
export async function admitGoogleUser(
  prisma: PrismaClient,
  profile: SignInProfile,
  existing: User | null,
  adminEmails: readonly string[],
): Promise<User> {
  const allowlisted = adminEmails.includes(profile.email);

  if (existing) {
    if (existing.deactivatedAt) throw new SignInRefusedError('suspended');
    // The allowlist bootstraps; it does not overrule a demotion. It still
    // restores an admin when the workspace has none left (recovery).
    const recover = allowlisted && existing.globalRole !== 'ADMIN' && (await activeAdminCount(prisma)) === 0;
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        avatarUrl: profile.picture,
        email: profile.email,
        googleSubject: profile.subject,
        name: profile.name,
        ...(recover ? { globalRole: 'ADMIN' as const } : {}),
      },
    });
  }

  const settings = await getWorkspaceSettings(prisma);
  const domainApproved = settings.approvedDomains.includes(emailDomain(profile.email));
  if (!allowlisted && !domainApproved) {
    throw new SignInRefusedError('not_invited');
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        avatarUrl: profile.picture,
        email: profile.email,
        globalRole: allowlisted ? 'ADMIN' : 'USER',
        googleSubject: profile.subject,
        name: profile.name,
      },
    });
    // People who join by domain land in the default teams as Members.
    if (!allowlisted && settings.defaultTeamIds.length > 0) {
      const teams = await tx.team.findMany({ where: { id: { in: settings.defaultTeamIds } }, select: { id: true } });
      await tx.teamMembership.createMany({
        data: teams.map((team) => ({ role: 'EDITOR' as const, teamId: team.id, userId: user.id })),
        skipDuplicates: true,
      });
    }
    return user;
  });
}

// --- Invitations -----------------------------------------------------------

export interface Inviter {
  actorId: string;
  actorKind: User['actorKind'];
  globalRole: GlobalRole;
}

export async function canInvite(prisma: DatabaseClient, inviter: Inviter | null): Promise<boolean> {
  if (!inviter || inviter.actorKind !== 'HUMAN') return false;
  if (inviter.globalRole === 'ADMIN') return true;
  if (inviter.globalRole !== 'USER') return false;
  return (await getWorkspaceSettings(prisma)).membersCanInvite;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InviteInput {
  by: Inviter;
  email: string;
  name?: string | null;
  role: GlobalRole;
  teams?: Array<{ role: TeamMembershipRole; teamId: string }>;
}

/**
 * Create (or refresh) a pending user. Membership rows are written now so the
 * person lands in their teams on first sign-in.
 */
export async function inviteUser(prisma: PrismaClient, input: InviteInput): Promise<User> {
  if (!(await canInvite(prisma, input.by))) throw createValidationError(INVITE_FORBIDDEN_MESSAGE);
  if (input.role === 'ADMIN' && input.by.globalRole !== 'ADMIN') {
    throw createValidationError(INVITE_ADMIN_FORBIDDEN_MESSAGE);
  }
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) throw createValidationError(INVITE_EMAIL_INVALID_MESSAGE);
  const teams = input.teams ?? [];
  if (input.role === 'GUEST' && teams.some((team) => team.role === 'OWNER')) {
    throw createValidationError(GUEST_CANNOT_OWN_TEAM_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });
    if (existing && (existing.googleSubject || existing.actorKind !== 'HUMAN')) {
      throw createValidationError(INVITE_ALREADY_MEMBER_MESSAGE);
    }
    const now = new Date();
    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          // Re-inviting a revoked invite brings it back.
          data: { deactivatedAt: null, globalRole: input.role, invitedAt: now, invitedById: input.by.actorId },
        })
      : await tx.user.create({
          data: {
            email,
            globalRole: input.role,
            invitedAt: now,
            invitedById: input.by.actorId,
            name: input.name?.trim() || email.split('@')[0] || email,
          },
        });
    for (const team of teams) {
      await tx.teamMembership.upsert({
        where: { teamId_userId: { teamId: team.teamId, userId: user.id } },
        create: { role: team.role, teamId: team.teamId, userId: user.id },
        update: { role: team.role },
      });
    }
    await recordActorAudit(tx, {
      action: 'invited',
      after: { globalRole: input.role, teams: teams.map((team) => ({ role: team.role, teamId: team.teamId })) },
      byActorId: input.by.actorId,
      subjectId: user.id,
    });
    return user;
  });
}

/** A pending invite is revoked by suspending its row; re-inviting reactivates it. */
export async function revokeInvite(
  prisma: PrismaClient,
  input: { by: Inviter; userId: string },
): Promise<User> {
  if (!(await canInvite(prisma, input.by))) throw createValidationError(INVITE_FORBIDDEN_MESSAGE);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw createNotFoundError(USER_NOT_FOUND_MESSAGE);
    if (user.googleSubject || user.actorKind !== 'HUMAN' || user.deactivatedAt) {
      throw createValidationError(INVITE_NOT_PENDING_MESSAGE);
    }
    const updated = await tx.user.update({ where: { id: user.id }, data: { deactivatedAt: new Date() } });
    await recordActorAudit(tx, {
      action: 'invite_revoked',
      after: { deactivatedAt: updated.deactivatedAt?.toISOString() ?? null },
      byActorId: input.by.actorId,
      subjectId: user.id,
    });
    return updated;
  });
}

// --- Suspension ------------------------------------------------------------

/**
 * Suspend a person: sign them out now and refuse future sign-in. History,
 * memberships and assignments stay. Agents use actorDeactivate instead.
 */
export async function suspendUser(
  prisma: PrismaClient,
  input: { byActorId: string; reason?: string | null; userId: string },
): Promise<User> {
  if (input.byActorId === input.userId) throw createValidationError(USER_SUSPEND_SELF_MESSAGE);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw createNotFoundError(USER_NOT_FOUND_MESSAGE);
    if (user.actorKind !== 'HUMAN') throw createValidationError(USER_SUSPEND_HUMANS_ONLY_MESSAGE);
    if (user.deactivatedAt) throw createValidationError(USER_ALREADY_SUSPENDED_MESSAGE);
    if (user.globalRole === 'ADMIN' && (await activeAdminCount(tx)) <= 1) {
      throw createValidationError(GLOBAL_ROLE_LAST_ADMIN_MESSAGE);
    }
    const now = new Date();
    const updated = await tx.user.update({ where: { id: user.id }, data: { deactivatedAt: now } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await recordActorAudit(tx, {
      action: 'suspended',
      after: { deactivatedAt: now.toISOString() },
      before: { deactivatedAt: null },
      byActorId: input.byActorId,
      reason: input.reason ?? null,
      subjectId: user.id,
    });
    return updated;
  });
}

export async function reactivateUser(
  prisma: PrismaClient,
  input: { byActorId: string; reason?: string | null; userId: string },
): Promise<User> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw createNotFoundError(USER_NOT_FOUND_MESSAGE);
    if (user.actorKind !== 'HUMAN') throw createValidationError(USER_SUSPEND_HUMANS_ONLY_MESSAGE);
    if (!user.deactivatedAt) throw createValidationError(USER_NOT_SUSPENDED_MESSAGE);
    const updated = await tx.user.update({ where: { id: user.id }, data: { deactivatedAt: null } });
    await recordActorAudit(tx, {
      action: 'reactivated',
      after: { deactivatedAt: null },
      before: { deactivatedAt: user.deactivatedAt.toISOString() },
      byActorId: input.byActorId,
      reason: input.reason ?? null,
      subjectId: user.id,
    });
    return updated;
  });
}

export type UserAccessStatus = 'ACTIVE' | 'PENDING' | 'SUSPENDED';

export function userAccessStatus(user: Pick<User, 'actorKind' | 'deactivatedAt' | 'googleSubject'>): UserAccessStatus {
  if (user.deactivatedAt) return 'SUSPENDED';
  if (user.actorKind === 'HUMAN' && !user.googleSubject) return 'PENDING';
  return 'ACTIVE';
}

// --- Invite email ------------------------------------------------------------

export interface InviteDelivery {
  /** True only when an email actually left the server. */
  emailSent: boolean;
  /** Why no email was sent, in words a person can act on. */
  emailNote: string | null;
  /** Where the invited person signs in; shown so it can be sent by hand. */
  signInUrl: string;
}

/**
 * Invites work without mail: the row is what lets the person in. When SMTP
 * is configured (NOTIFICATION_EMAIL_*) an email goes out too; otherwise the
 * caller is told plainly that nothing was sent and given the link.
 */
export async function deliverInvite(
  input: { email: string; inviterName: string | null },
  runtime: { appOrigin: string; send: ((mail: { html: string; subject: string; text: string; to: string }) => Promise<void>) | null },
): Promise<InviteDelivery> {
  const signInUrl = runtime.appOrigin;
  if (!runtime.send) {
    return {
      emailNote: 'No email was sent: this server has no mail (SMTP) configured. Send them the link yourself.',
      emailSent: false,
      signInUrl,
    };
  }
  const who = input.inviterName ?? 'An admin';
  const text = `${who} invited you to Involute.\n\nSign in with Google using ${input.email}:\n${signInUrl}\n`;
  try {
    await runtime.send({
      html: `<p>${escapeHtml(who)} invited you to Involute.</p><p>Sign in with Google using <strong>${escapeHtml(input.email)}</strong>:<br><a href="${escapeHtml(signInUrl)}">${escapeHtml(signInUrl)}</a></p>`,
      subject: `${who} invited you to Involute`,
      text,
      to: input.email,
    });
    return { emailNote: null, emailSent: true, signInUrl };
  } catch (error) {
    return {
      emailNote: `The invite is saved, but the email failed (${error instanceof Error ? error.message : 'unknown error'}). Send them the link yourself.`,
      emailSent: false,
      signInUrl,
    };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
