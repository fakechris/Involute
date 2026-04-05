import { describe, expect, it, vi } from 'vitest';

import { assertCanWriteTeam } from './access-control.js';
import { TEAM_WRITE_FORBIDDEN_MESSAGE } from './errors.js';

describe('access control', () => {
  it('allows trusted system requests to bypass team write membership checks', async () => {
    await expect(
      assertCanWriteTeam(
        {
          teamMembership: {
            findUnique: vi.fn(),
          },
        } as never,
        {
          authMode: 'token',
          isTrustedSystem: true,
          prisma: {} as never,
          viewer: null,
        },
        'team-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('allows admins to bypass team write membership checks', async () => {
    await expect(
      assertCanWriteTeam(
        {
          teamMembership: {
            findUnique: vi.fn(),
          },
        } as never,
        {
          authMode: 'session',
          isTrustedSystem: false,
          prisma: {} as never,
          viewer: {
            email: 'admin@example.com',
            globalRole: 'ADMIN',
            id: 'user-1',
            name: 'Admin',
          } as never,
        },
        'team-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects non-members without editor access', async () => {
    await expect(
      assertCanWriteTeam(
        {
          teamMembership: {
            findUnique: vi.fn().mockResolvedValue(null),
          },
        } as never,
        {
          authMode: 'session',
          isTrustedSystem: false,
          prisma: {} as never,
          viewer: {
            email: 'user@example.com',
            globalRole: 'USER',
            id: 'user-1',
            name: 'User',
          } as never,
        },
        'team-1',
      ),
    ).rejects.toMatchObject({
      message: TEAM_WRITE_FORBIDDEN_MESSAGE,
    });
  });

  it('allows editor memberships to write', async () => {
    await expect(
      assertCanWriteTeam(
        {
          teamMembership: {
            findUnique: vi.fn().mockResolvedValue({ role: 'EDITOR' }),
          },
        } as never,
        {
          authMode: 'session',
          isTrustedSystem: false,
          prisma: {} as never,
          viewer: {
            email: 'editor@example.com',
            globalRole: 'USER',
            id: 'user-1',
            name: 'Editor',
          } as never,
        },
        'team-1',
      ),
    ).resolves.toBeUndefined();
  });
});
