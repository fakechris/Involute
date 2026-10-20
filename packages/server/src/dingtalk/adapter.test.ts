import { describe, expect, it } from 'vitest';

import type { DingTalkClient, DingTalkDepartment, DingTalkDirectoryUser } from './client.ts';
import { collectDingTalkOrganization } from './adapter.ts';

function department(id: number, name: string, parentId: number | null = null): DingTalkDepartment {
  return { deptId: id, name, parentId };
}

function person(
  userId: string,
  name: string,
  email: string | null,
  unionId: string | null = `union-${userId}`,
): DingTalkDirectoryUser {
  return {
    active: true,
    avatarUrl: null,
    departmentIds: [],
    email,
    name,
    title: null,
    unionId,
    userId,
  };
}

/** A DingTalk client that answers from a fixed directory. */
function fakeClient(options: {
  departments: Map<number, DingTalkDepartment>;
  users: Map<number, DingTalkDirectoryUser[]>;
}): DingTalkClient {
  return {
    getDepartment: async (id: number) => options.departments.get(id) ?? null,
    listSubDepartments: async (id: number) =>
      [...options.departments.values()].filter((entry) => entry.parentId === id),
    listDepartmentUsers: async (id: number) => options.users.get(id) ?? [],
    collectDepartmentTree: async (id: number) => {
      const collected: DingTalkDepartment[] = [];
      const queue = [id];

      while (queue.length > 0) {
        const current = queue.shift()!;
        const entry = options.departments.get(current);
        if (entry) {
          collected.push(entry);
        }
        for (const child of [...options.departments.values()].filter(
          (candidate) => candidate.parentId === current,
        )) {
          queue.push(child.deptId);
        }
      }

      return collected;
    },
  } as unknown as DingTalkClient;
}

describe('the DingTalk organisation adapter (INV-1288)', () => {
  const directory = () =>
    fakeClient({
      departments: new Map([
        [1, department(1, 'Core')],
        [2, department(2, 'Platform', 1)],
      ]),
      users: new Map([
        [1, [person('u1', 'Ann Li', 'ann@example.com'), person('u2', 'Bo Wang', null)]],
        [2, [person('u3', 'Cat Wu', 'cat@example.com')]],
      ]),
    });

  it('turns a department into a group the engine can read', async () => {
    const { input, warnings } = await collectDingTalkOrganization(directory(), [
      { deptId: 1, teamKey: 'CORE' },
    ]);

    expect(warnings).toEqual([]);
    expect(input.provider).toBe('dingtalk');
    expect(input.groups).toHaveLength(1);
    expect(input.groups[0]).toEqual({
      externalId: '1',
      name: 'Core',
      people: [
        { avatarUrl: null, email: 'ann@example.com', externalId: 'union-u1', name: 'Ann Li' },
        { avatarUrl: null, email: null, externalId: 'union-u2', name: 'Bo Wang' },
      ],
      role: undefined,
      teamKey: 'CORE',
    });
  });

  it('takes the sub-departments in when asked', async () => {
    const { input } = await collectDingTalkOrganization(directory(), [
      { deptId: 1, includeSubDepartments: true, teamKey: 'CORE' },
    ]);

    expect(input.groups[0]?.people.map((entry) => entry.name)).toEqual(['Ann Li', 'Bo Wang', 'Cat Wu']);
  });

  it('leaves the sub-departments out by default', async () => {
    const { input } = await collectDingTalkOrganization(directory(), [
      { deptId: 1, teamKey: 'CORE' },
    ]);

    expect(input.groups[0]?.people.map((entry) => entry.name)).toEqual(['Ann Li', 'Bo Wang']);
  });

  it('prefers the team name over the department name', async () => {
    const { input } = await collectDingTalkOrganization(directory(), [
      { deptId: 1, teamKey: 'CORE', teamName: '核心研发' },
    ]);

    expect(input.groups[0]?.name).toBe('核心研发');
  });

  it('reports a department DingTalk does not have, and skips it', async () => {
    const { input, warnings } = await collectDingTalkOrganization(directory(), [
      { deptId: 99, teamKey: 'GONE' },
    ]);

    expect(input.groups).toHaveLength(0);
    expect(warnings[0]).toMatch(/99/);
    expect(warnings[0]).toMatch(/not found/);
  });

  it('says a person has no stable id rather than inventing one', async () => {
    const client = fakeClient({
      departments: new Map([[1, department(1, 'Core')]]),
      users: new Map([[1, [person('u1', 'Ann Li', 'ann@example.com', null)]]]),
    });

    const { input } = await collectDingTalkOrganization(client, [
      { deptId: 1, teamKey: 'CORE' },
    ]);

    expect(input.groups[0]?.people[0]?.externalId).toBeNull();
  });
});
