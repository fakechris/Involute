import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';

import {
  ACCESS_PAGE_QUERY,
  TEAM_MEMBERSHIP_REMOVE_MUTATION,
  TEAM_MEMBERSHIP_UPSERT_MUTATION,
  TEAM_UPDATE_ACCESS_MUTATION,
} from '../board/queries';
import type {
  AccessPageQueryData,
  TeamMembershipRemoveMutationData,
  TeamMembershipRemoveMutationVariables,
  TeamMembershipSummary,
  TeamMembershipUpsertMutationData,
  TeamMembershipUpsertMutationVariables,
  TeamSummary,
  TeamUpdateAccessMutationData,
  TeamUpdateAccessMutationVariables,
} from '../board/types';
import { getBoardBootstrapErrorMessage } from '../lib/apollo';

const ACCESS_ERROR_MESSAGE = 'We could not update team access right now. Please try again.';

function sortMemberships(memberships: TeamMembershipSummary[]) {
  return [...memberships].sort((left, right) => {
    const roleComparison = left.role.localeCompare(right.role);

    if (roleComparison !== 0) {
      return roleComparison;
    }

    return (left.user.email ?? '').localeCompare(right.user.email ?? '');
  });
}

function canManageTeam(team: TeamSummary | null, viewer: AccessPageQueryData['viewer']): boolean {
  if (!team || !viewer) {
    return false;
  }

  if (viewer.globalRole === 'ADMIN') {
    return true;
  }

  return team.memberships?.nodes.some(
    (membership) => membership.user.id === viewer.id && membership.role === 'OWNER',
  ) ?? false;
}

export function AccessPage() {
  const { data, error, loading } = useQuery<AccessPageQueryData>(ACCESS_PAGE_QUERY);
  const [runTeamUpdateAccess] = useMutation<TeamUpdateAccessMutationData, TeamUpdateAccessMutationVariables>(
    TEAM_UPDATE_ACCESS_MUTATION,
  );
  const [runTeamMembershipUpsert] = useMutation<
    TeamMembershipUpsertMutationData,
    TeamMembershipUpsertMutationVariables
  >(TEAM_MEMBERSHIP_UPSERT_MUTATION);
  const [runTeamMembershipRemove] = useMutation<
    TeamMembershipRemoveMutationData,
    TeamMembershipRemoveMutationVariables
  >(TEAM_MEMBERSHIP_REMOVE_MUTATION);

  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<'VIEWER' | 'EDITOR' | 'OWNER'>('VIEWER');
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const nextTeams = data?.teams.nodes ?? [];
    setTeams(nextTeams);

    if (!nextTeams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(nextTeams[0]?.id ?? '');
    }
  }, [data?.teams.nodes, selectedTeamId]);

  const viewer = data?.viewer ?? null;
  const selectedTeam = useMemo(
    () => teams.find((team) => team.id === selectedTeamId) ?? null,
    [selectedTeamId, teams],
  );
  const memberships = useMemo(
    () => sortMemberships(selectedTeam?.memberships?.nodes ?? []),
    [selectedTeam],
  );
  const isManageable = canManageTeam(selectedTeam, viewer);

  if (error) {
    const errorState = getBoardBootstrapErrorMessage(error);

    return (
      <main className="access-page access-page--state">
        <header className="app-shell__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h1>Access</h1>
          </div>
        </header>
        <section className="board-message board-message--error" role="alert">
          <h2>{errorState.title}</h2>
          <p>{errorState.description}</p>
        </section>
      </main>
    );
  }

  if (loading && teams.length === 0) {
    return (
      <main className="access-page access-page--state">
        <header className="app-shell__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h1>Access</h1>
          </div>
        </header>
        <section className="board-message">
          <p>Loading team access settings…</p>
        </section>
      </main>
    );
  }

  function updateSelectedTeam(updater: (team: TeamSummary) => TeamSummary) {
    if (!selectedTeam) {
      return;
    }

    setTeams((currentTeams) => currentTeams.map((team) => (team.id === selectedTeam.id ? updater(team) : team)));
  }

  async function handleVisibilityChange(nextVisibility: 'PRIVATE' | 'PUBLIC') {
    if (!selectedTeam) {
      return;
    }

    setMutationError(null);
    setIsSaving(true);

    const previousVisibility = selectedTeam.visibility ?? 'PRIVATE';
    updateSelectedTeam((team) => ({
      ...team,
      visibility: nextVisibility,
    }));

    try {
      const result = await runTeamUpdateAccess({
        variables: {
          input: {
            teamId: selectedTeam.id,
            visibility: nextVisibility,
          },
        },
      });

      if (!result.data?.teamUpdateAccess.success || !result.data.teamUpdateAccess.team) {
        throw new Error('Visibility update failed');
      }

      setTeams((currentTeams) =>
        currentTeams.map((team) =>
          team.id === selectedTeam.id ? result.data!.teamUpdateAccess.team! : team,
        ),
      );
    } catch {
      updateSelectedTeam((team) => ({
        ...team,
        visibility: previousVisibility,
      }));
      setMutationError(ACCESS_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleMembershipUpsert() {
    if (!selectedTeam) {
      return;
    }

    const email = newMemberEmail.trim().toLowerCase();

    if (!email) {
      return;
    }

    setMutationError(null);
    setIsSaving(true);

    try {
      const result = await runTeamMembershipUpsert({
        variables: {
          input: {
            email,
            name: newMemberName.trim() || null,
            role: newMemberRole,
            teamId: selectedTeam.id,
          },
        },
      });

      if (!result.data?.teamMembershipUpsert.success || !result.data.teamMembershipUpsert.membership) {
        throw new Error('Membership upsert failed');
      }

      const membership = result.data.teamMembershipUpsert.membership;
      updateSelectedTeam((team) => ({
        ...team,
        memberships: {
          nodes: sortMemberships([
            ...(team.memberships?.nodes.filter((item) => item.user.id !== membership.user.id) ?? []),
            membership,
          ]),
        },
      }));

      setNewMemberEmail('');
      setNewMemberName('');
      setNewMemberRole('VIEWER');
    } catch {
      setMutationError(ACCESS_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleMembershipRemove(userId: string) {
    if (!selectedTeam) {
      return;
    }

    setMutationError(null);
    setIsSaving(true);

    try {
      const result = await runTeamMembershipRemove({
        variables: {
          input: {
            teamId: selectedTeam.id,
            userId,
          },
        },
      });

      if (!result.data?.teamMembershipRemove.success) {
        throw new Error('Membership remove failed');
      }

      updateSelectedTeam((team) => ({
        ...team,
        memberships: {
          nodes: team.memberships?.nodes.filter((membership) => membership.user.id !== userId) ?? [],
        },
      }));
    } catch {
      setMutationError(ACCESS_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="access-page">
      <header className="app-shell__header">
        <div>
          <p className="app-shell__eyebrow">Involute</p>
          <h1>Access</h1>
          <p className="app-shell__subtext">
            Manage team visibility and editor access with the current RBAC model.
          </p>
          <p className="app-shell__subtext">
            System admins are bootstrapped separately through <code>ADMIN_EMAIL_ALLOWLIST</code> or{' '}
            <code>pnpm --filter @involute/server admin:bootstrap</code>.
          </p>
        </div>
      </header>

      <section className="access-panel">
        <label className="team-selector">
          <span>Team</span>
          <select
            aria-label="Select access team"
            value={selectedTeam?.id ?? ''}
            onChange={(event) => setSelectedTeamId(event.target.value)}
          >
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>

        {selectedTeam ? (
          <>
            <div className="access-panel__section">
              <div>
                <h2>Visibility</h2>
                <p className="app-shell__subtext">
                  <code>PUBLIC</code> teams are readable by all signed-in users. Only members with
                  edit access can write.
                </p>
              </div>
              <select
                aria-label="Team visibility"
                disabled={!isManageable || isSaving}
                value={selectedTeam.visibility ?? 'PRIVATE'}
                onChange={(event) => handleVisibilityChange(event.target.value as 'PRIVATE' | 'PUBLIC')}
              >
                <option value="PRIVATE">PRIVATE</option>
                <option value="PUBLIC">PUBLIC</option>
              </select>
            </div>

            <div className="access-panel__section">
              <div>
                <h2>Members</h2>
                <p className="app-shell__subtext">
                  `OWNER` can manage access, `EDITOR` can modify issues, `VIEWER` is read-only.
                </p>
              </div>
              <div className="access-member-list">
                {memberships.length > 0 ? (
                  memberships.map((membership) => (
                    <div key={membership.id} className="access-member-card">
                      <div>
                        <strong>{membership.user.name ?? membership.user.email ?? 'Unnamed user'}</strong>
                        <p>{membership.user.email ?? 'No email'}</p>
                        <p>
                          {membership.role}
                          {' · '}
                          {membership.user.globalRole}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="app-shell__session-action"
                        aria-label={`Remove ${membership.user.email ?? membership.user.name ?? 'member'} from ${selectedTeam.name}`}
                        disabled={!isManageable || isSaving}
                        onClick={() => handleMembershipRemove(membership.user.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="app-shell__subtext">No explicit team members yet.</p>
                )}
              </div>
            </div>

            <div className="access-panel__section">
              <div>
                <h2>Add or update member</h2>
                <p className="app-shell__subtext">
                  This upserts a team member by email and leaves global admin bootstrapping to the server runtime.
                </p>
              </div>
              <div className="access-form">
                <input
                  aria-label="Member email"
                  className="issue-detail-drawer__title-input"
                  disabled={!isManageable || isSaving}
                  placeholder="person@example.com"
                  value={newMemberEmail}
                  onChange={(event) => setNewMemberEmail(event.target.value)}
                />
                <input
                  aria-label="Member name"
                  className="issue-detail-drawer__title-input"
                  disabled={!isManageable || isSaving}
                  placeholder="Optional name"
                  value={newMemberName}
                  onChange={(event) => setNewMemberName(event.target.value)}
                />
                <select
                  aria-label="Member role"
                  disabled={!isManageable || isSaving}
                  value={newMemberRole}
                  onChange={(event) => setNewMemberRole(event.target.value as 'VIEWER' | 'EDITOR' | 'OWNER')}
                >
                  <option value="VIEWER">VIEWER</option>
                  <option value="EDITOR">EDITOR</option>
                  <option value="OWNER">OWNER</option>
                </select>
                <button
                  type="button"
                  className="issue-comment-composer__submit"
                  disabled={!isManageable || isSaving}
                  onClick={() => void handleMembershipUpsert()}
                >
                  Save member
                </button>
              </div>
            </div>
          </>
        ) : (
          <section className="board-message">
            <p>No visible teams available for access management.</p>
          </section>
        )}

        {!isManageable && selectedTeam ? (
          <p className="board-message board-message--error">
            You can view this team, but only an `OWNER` or `ADMIN` can change its access settings.
          </p>
        ) : null}
        {mutationError ? <p className="board-message board-message--error">{mutationError}</p> : null}
      </section>
    </main>
  );
}
