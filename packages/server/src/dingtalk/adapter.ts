/**
 * The DingTalk organisation, read as an organisation (INV-1288).
 *
 * This is the **adapter**: it walks the shape DingTalk has — a tree of
 * departments, each with its own members — and produces the source-neutral
 * contract the import engine reads (`../org-sync/types.ts`). The engine does
 * not know what a department is, and this file does not know what a team is.
 *
 * The split is the point: a second source (a roster file, another directory)
 * would add its own adapter next to this one and change nothing else.
 */

import type { TeamMembershipRole } from '@prisma/client';

import type { OrganizationGroup, OrganizationPerson, OrganizationSyncInput } from '../org-sync/types.js';
import type { DingTalkClient, DingTalkDirectoryUser } from './client.js';

/** Which DingTalk department becomes which Involute team. */
export interface DingTalkDepartmentMapping {
  /** The DingTalk department id. */
  deptId: number;
  /** The Involute team key this department becomes, e.g. `CORE`. */
  teamKey: string;
  /** The team name; the department name is used when this is absent. */
  teamName?: string;
  /** The membership role people get. Defaults to EDITOR. */
  role?: TeamMembershipRole;
  /** Whether people in sub-departments join too. Defaults to false. */
  includeSubDepartments?: boolean;
}

export const DINGTALK_ORG_PROVIDER = 'dingtalk';

/**
 * Read the named departments and their people, in the shape the import
 * engine reads.
 *
 * A department that DingTalk does not have is reported and skipped; it is
 * not an error, because a mapping file outlives the organisation it was
 * written for.
 */
export async function collectDingTalkOrganization(
  client: DingTalkClient,
  mappings: readonly DingTalkDepartmentMapping[],
): Promise<{ input: OrganizationSyncInput; warnings: string[] }> {
  const groups: OrganizationGroup[] = [];
  const warnings: string[] = [];

  for (const mapping of mappings) {
    const department = await client.getDepartment(mapping.deptId);

    if (!department) {
      warnings.push(`Department ${String(mapping.deptId)} was not found in DingTalk; it was skipped.`);
      continue;
    }

    const people = await collectPeople(client, mapping, department.deptId);

    const group: OrganizationGroup = {
      externalId: String(mapping.deptId),
      name: mapping.teamName?.trim() || department.name,
      people,
      teamKey: mapping.teamKey,
    };

    if (mapping.role !== undefined) {
      group.role = mapping.role;
    }

    groups.push(group);
  }

  return { input: { groups, provider: DINGTALK_ORG_PROVIDER }, warnings };
}

/** The people of a department, and of its sub-departments when asked for. */
async function collectPeople(
  client: DingTalkClient,
  mapping: DingTalkDepartmentMapping,
  departmentId: number,
): Promise<OrganizationPerson[]> {
  const people = new Map<string, DingTalkDirectoryUser>();

  const departments = mapping.includeSubDepartments
    ? await client.collectDepartmentTree(departmentId)
    : [{ deptId: departmentId, name: '', parentId: null }];

  for (const department of departments) {
    for (const person of await client.listDepartmentUsers(department.deptId)) {
      people.set(person.userId, person);
    }
  }

  return [...people.values()].map((person) => ({
    avatarUrl: person.avatarUrl,
    email: person.email,
    // The `unionId` is the identity that is stable across every app in the
    // corporation — the same one the sign-in flow uses. A person without one
    // can still be a member, but cannot be recognised at sign-in, and the
    // engine reports that rather than inventing an id.
    externalId: person.unionId,
    name: person.name,
  }));
}
