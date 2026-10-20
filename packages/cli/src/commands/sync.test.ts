import { describe, expect, it } from 'vitest';

import { isOrganizationProviderId, parseDingTalkMapping, runOrganizationSync } from './sync.js';

describe('the organisation import (INV-1288)', () => {
  it('knows which sources it can read', () => {
    expect(isOrganizationProviderId('dingtalk')).toBe(true);
    expect(isOrganizationProviderId('google')).toBe(false);
    expect(isOrganizationProviderId('roster')).toBe(false);
  });

  it('refuses a source it cannot read, and says which ones it can', async () => {
    await expect(
      runOrganizationSync({ mappingFile: '/tmp/does-not-matter.json', provider: 'google' }),
    ).rejects.toThrow(/Unknown organisation provider "google"/);
  });

  it('refuses to run without a mapping file', async () => {
    await expect(runOrganizationSync({ provider: 'dingtalk' })).rejects.toThrow(
      /--mapping is required/,
    );
  });

  it('reads the departments out of the file', () => {
    const mapping = parseDingTalkMapping(
      {
        departments: [
          {
            deptId: 1,
            includeSubDepartments: true,
            role: 'EDITOR',
            teamKey: 'CORE',
            teamName: '核心研发',
          },
        ],
      },
      'mapping.json',
    );

    expect(mapping.departments).toEqual([
      {
        deptId: 1,
        includeSubDepartments: true,
        role: 'EDITOR',
        teamKey: 'CORE',
        teamName: '核心研发',
      },
    ]);
  });

  it('fills in the defaults', () => {
    const mapping = parseDingTalkMapping({ departments: [{ deptId: 3, teamKey: 'DATA' }] }, 'map');

    expect(mapping.departments[0]).toEqual({
      deptId: 3,
      includeSubDepartments: false,
      teamKey: 'DATA',
    });
  });

  it('refuses a file that is not a mapping', () => {
    expect(() => parseDingTalkMapping(null, 'map')).toThrow(/must be a JSON object/);
    expect(() => parseDingTalkMapping([], 'map')).toThrow(/must be a JSON object/);
    expect(() => parseDingTalkMapping({}, 'map')).toThrow(/at least one department/);
    expect(() => parseDingTalkMapping({ departments: [] }, 'map')).toThrow(/at least one department/);
  });

  it('refuses a department it cannot read', () => {
    expect(() => parseDingTalkMapping({ departments: ['x'] }, 'map')).toThrow(
      /departments\[0\] must be an object/,
    );
    expect(() => parseDingTalkMapping({ departments: [{ teamKey: 'CORE' }] }, 'map')).toThrow(
      /deptId must be a number/,
    );
    expect(() => parseDingTalkMapping({ departments: [{ deptId: 1 }] }, 'map')).toThrow(
      /teamKey must be a string/,
    );
    expect(() =>
      parseDingTalkMapping({ departments: [{ deptId: 1, role: 'ADMIN', teamKey: 'CORE' }] }, 'map'),
    ).toThrow(/role must be VIEWER, EDITOR or OWNER/);
  });
});
