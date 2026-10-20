/**
 * The organisation import engine (INV-1288).
 *
 * What it does, in one line: the groups an outside organisation names become
 * teams, and the people in those groups become their members.
 *
 * ## It does not know any source
 *
 * The engine reads `OrganizationSyncInput` and nothing else. It does not know
 * that DingTalk has departments, or that a roster file has lines. A source
 * walks its own shape into the contract (`../dingtalk/adapter.ts` for
 * DingTalk) and the engine does the rest. That is what keeps the import
 * independent of any particular sign-in line, and independent of sign-in
 * itself.
 *
 * ## What it never does
 *
 * It does not delete people, and it does not delete teams. A person who
 * leaves a group keeps their account; only the membership goes, and only when
 * the operator asks for it with `prune`. A workspace is a record of who
 * worked here; an organisation directory is a record of who is here now, and
 * the second must not erase the first.
 *
 * ## Identity
 *
 * A person is matched by **email**, because that is how the workspace keys
 * people (docs/permissions.md §1). The source's own id is recorded
 * alongside, so the same person can sign in through that source afterwards. A
 * person with no email address cannot be admitted and is reported, not
 * dropped in silence.
 *
 * ## Which teams it may change
 *
 * Only the teams it has mapped. A team is linked to its group by a row in
 * `ExternalOrganizationRef`, so a second group cannot quietly take over a
 * team, and `prune` never touches a team the import does not own.
 */

import { createHash } from 'node:crypto';

import type { PrismaClient, TeamMembershipRole } from '@prisma/client';

import { createValidationError } from '../errors.js';
import { createTeamWithDefaultStates } from '../team-lifecycle.js';
import type { OrganizationGroup, OrganizationPerson, OrganizationSyncInput } from './types.js';

export interface OrganizationSyncOptions {
  prisma: PrismaClient;
  input: OrganizationSyncInput;
  /** Remove memberships for people who left the group. Off by default. */
  prune?: boolean;
  /** Work out what would change and report it, without writing anything. */
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}

export interface OrganizationSyncSummary {
  provider: string;
  groups: number;
  membersAdded: number;
  membersRemoved: number;
  membersUnchanged: number;
  peopleCreated: number;
  peopleLinked: number;
  peopleWithoutEmail: string[];
  peopleWithoutIdentity: string[];
  teamsCreated: number;
  teamsReused: number;
  warnings: string[];
}

/** A team key is short, upper-case and starts with a letter. */
const TEAM_KEY_SHAPE = /^[A-Z][A-Z0-9]{1,9}$/;

export function normalizeTeamKey(value: string): string {
  const key = value.trim().toUpperCase();

  if (!TEAM_KEY_SHAPE.test(key)) {
    throw createValidationError(
      `Team key "${value}" is not usable: use 2-10 letters or digits, starting with a letter (for example CORE).`,
    );
  }

  return key;
}

/**
 * A placeholder id for a dry run.
 *
 * A dry run has no rows to point at, but it still has to count what would
 * change — and the columns these ids land in are `uuid`, so the placeholder
 * has to be a uuid as well. It is derived from the thing it stands for, so
 * the same person or team always gets the same placeholder.
 */
function dryRunId(kind: string, key: string): string {
  const bytes = createHash('sha1').update(`${kind}:${key}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant
  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function syncOrganization(
  options: OrganizationSyncOptions,
): Promise<OrganizationSyncSummary> {
  const { prisma, input, dryRun = false, prune = false } = options;
  const log = options.onProgress ?? (() => undefined);

  const summary: OrganizationSyncSummary = {
    provider: input.provider,
    groups: input.groups.length,
    membersAdded: 0,
    membersRemoved: 0,
    membersUnchanged: 0,
    peopleCreated: 0,
    peopleLinked: 0,
    peopleWithoutEmail: [],
    peopleWithoutIdentity: [],
    teamsCreated: 0,
    teamsReused: 0,
    warnings: [],
  };

  for (const group of input.groups) {
    const teamKey = normalizeTeamKey(group.teamKey);
    const team = await resolveTeam(prisma, group, teamKey, input.provider, dryRun, summary);

    if (!team) {
      continue;
    }

    log(`Syncing ${group.name ?? teamKey} → team ${teamKey}...`);

    const memberUserIds = new Set<string>();

    for (const person of group.people) {
      const userId = await admitPerson(prisma, person, input.provider, dryRun, summary);

      if (!userId) {
        continue;
      }

      memberUserIds.add(userId);

      const membership = await prisma.teamMembership.findUnique({
        where: { teamId_userId: { teamId: team.id, userId } },
      });

      if (!membership) {
        summary.membersAdded += 1;

        if (!dryRun) {
          await prisma.teamMembership.create({
            data: { role: group.role ?? 'EDITOR', teamId: team.id, userId },
          });
        }
      } else if (membership.role !== (group.role ?? 'EDITOR')) {
        summary.membersAdded += 1;

        if (!dryRun) {
          await prisma.teamMembership.update({
            where: { id: membership.id },
            data: { role: group.role ?? 'EDITOR' },
          });
        }
      } else {
        summary.membersUnchanged += 1;
      }
    }

    // --- Leaving ---------------------------------------------------------
    if (prune) {
      const current = await prisma.teamMembership.findMany({
        where: { teamId: team.id },
        select: { id: true, userId: true },
      });

      for (const membership of current) {
        if (memberUserIds.has(membership.userId)) {
          continue;
        }

        summary.membersRemoved += 1;

        if (!dryRun) {
          await prisma.teamMembership.delete({ where: { id: membership.id } });
        }
      }
    }
  }

  if (summary.peopleWithoutIdentity.length > 0) {
    log(
      `  ${String(summary.peopleWithoutIdentity.length)} person/people have no stable id at ${input.provider} and were left out: ${summary.peopleWithoutIdentity
        .slice(0, 10)
        .join(', ')}${summary.peopleWithoutIdentity.length > 10 ? ' …' : ''}`,
    );
  }

  if (summary.peopleWithoutEmail.length > 0) {
    log(
      `  ${String(summary.peopleWithoutEmail.length)} person/people have no email address and were left out: ${summary.peopleWithoutEmail
        .slice(0, 10)
        .join(', ')}${summary.peopleWithoutEmail.length > 10 ? ' …' : ''}`,
    );
  }

  return summary;
}

/**
 * The team a group becomes.
 *
 * A group is bound to its team by a row in `ExternalOrganizationRef`, so a
 * team belongs to exactly one group of exactly one source. A group that
 * arrives for a team another group already owns is refused, loudly, rather
 * than quietly taking it over.
 */
async function resolveTeam(
  prisma: PrismaClient,
  group: OrganizationGroup,
  teamKey: string,
  provider: string,
  dryRun: boolean,
  summary: OrganizationSyncSummary,
): Promise<{ id: string } | null> {
  const existingRef = await prisma.externalOrganizationRef.findUnique({
    where: {
      provider_externalId: {
        externalId: group.externalId,
        provider,
      },
    },
    include: { team: true },
  });

  if (existingRef) {
    // The group is already bound to a team. It keeps it, whatever key the
    // mapping now names.
    if (existingRef.team.key !== teamKey) {
      summary.warnings.push(
        `Group ${group.externalId} is already mapped to team ${existingRef.team.key}; the mapping key ${teamKey} was ignored.`,
      );
    }
    summary.teamsReused += 1;

    return { id: existingRef.teamId };
  }

  const teamWithKey = await prisma.team.findUnique({ where: { key: teamKey } });

  if (teamWithKey) {
    // The team may already belong to another group. Two groups must not share
    // one team, so the second one is refused rather than quietly taking over:
    // give it its own team key instead.
    const owner = await prisma.externalOrganizationRef.findFirst({
      where: { teamId: teamWithKey.id },
    });

    if (owner && !(owner.provider === provider && owner.externalId === group.externalId)) {
      summary.warnings.push(
        `Group ${group.externalId} cannot take team ${teamKey}: it is already mapped to another group. It was skipped; give the group its own team key to sync it.`,
      );
      return null;
    }

    // An existing team adopts the group. The binding is written so the
    // import knows this team is its own from now on.
    summary.teamsReused += 1;

    if (!dryRun) {
      await prisma.externalOrganizationRef.create({
        data: { externalId: group.externalId, provider, teamId: teamWithKey.id },
      });
    }

    return { id: teamWithKey.id };
  }

  // A key spells identifiers. A project alias spells them too, so the two
  // must not be the same string: `CORE-12` would be ambiguous.
  const aliasClash = await prisma.issue.findFirst({
    where: { alias: { equals: teamKey, mode: 'insensitive' } },
    select: { id: true },
  });

  if (aliasClash) {
    summary.warnings.push(
      `Team key ${teamKey} is already used as a project alias, so it cannot spell identifiers; group ${group.externalId} was skipped.`,
    );
    return null;
  }

  summary.teamsCreated += 1;

  if (dryRun) {
    // The team does not exist yet, but a dry run still has to say how many
    // people would join it.
    return { id: dryRunId('team', teamKey) };
  }

  // The team is created with the default workflow, exactly as a team created
  // by a person is: a team without states is a team nobody can file an issue
  // in.
  const created = await createTeamWithDefaultStates(prisma, {
    key: teamKey,
    name: group.name?.trim() || teamKey,
  });

  await prisma.externalOrganizationRef.create({
    data: { externalId: group.externalId, provider, teamId: created.id },
  });

  return { id: created.id };
}

/**
 * The person behind a source's record: found, or created, and linked to the
 * source's identity.
 */
async function admitPerson(
  prisma: PrismaClient,
  person: OrganizationPerson,
  provider: string,
  dryRun: boolean,
  summary: OrganizationSyncSummary,
): Promise<string | null> {
  const email = person.email?.trim().toLowerCase() ?? '';

  if (!email) {
    summary.peopleWithoutEmail.push(person.name);
    return null;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  let userId: string;

  if (existing) {
    userId = existing.id;
  } else {
    summary.peopleCreated += 1;

    if (dryRun) {
      // No row will be written, so the person carries a placeholder id that
      // the membership accounting can still count.
      userId = dryRunId('user', email);
    } else {
      const created = await prisma.user.create({
        data: {
          avatarUrl: person.avatarUrl ?? null,
          email,
          globalRole: 'USER',
          name: person.name,
        },
      });
      userId = created.id;
    }
  }

  // The source's identity, so the person can sign in through that source.
  if (!person.externalId) {
    summary.peopleWithoutIdentity.push(person.name);
    return userId;
  }

  const identity = await prisma.userIdentity.findUnique({
    where: { provider_subject: { provider, subject: person.externalId } },
  });

  if (!identity) {
    summary.peopleLinked += 1;

    if (!dryRun) {
      await prisma.userIdentity.create({
        data: { provider, subject: person.externalId, userId },
      });
    }
  } else if (identity.userId !== userId) {
    summary.warnings.push(
      `${person.name} has the ${provider} identity ${person.externalId}, which is already linked to another account; it was not changed.`,
    );
  }

  return userId;
}

export type { OrganizationGroup, OrganizationPerson, OrganizationSyncInput, TeamMembershipRole };
