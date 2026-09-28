import { useMutation, useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';

import {
  PROJECT_SHARES_QUERY,
  WORK_SHARE_REMOVE_MUTATION,
  WORK_SHARE_UPSERT_MUTATION,
} from '../board/queries';
import { Btn } from './Primitives';

type ShareRole = 'VIEWER' | 'EDITOR';

interface ShareUser {
  id: string;
  name: string | null;
  email: string | null;
  handle: string | null;
  actorKind: 'HUMAN' | 'AGENT' | 'SERVICE';
}

interface ProjectSharesData {
  issue: {
    id: string;
    viewerCanShare: boolean;
    shares: Array<{ id: string; role: ShareRole; createdAt: string; user: ShareUser }>;
  } | null;
  users: { nodes: Array<ShareUser & { deactivatedAt: string | null }> };
}

interface MutationResult {
  success: boolean;
  message?: string | null;
}

const ROLE_COPY: Record<ShareRole, string> = {
  VIEWER: 'Can view',
  EDITOR: 'Can edit',
};

const inputStyle: React.CSSProperties = {
  height: 30, padding: '0 10px',
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: 'var(--r-2)', fontSize: 14, color: 'var(--fg)',
};

function displayName(user: ShareUser): string {
  const name = user.name || user.email || user.id;
  return user.handle ? `${name} (@${user.handle})` : name;
}

/**
 * Who a project is shared with beyond its team (INV-832/833).
 *
 * A share gives one person or agent this project, what it contains and the
 * team's issues on its repository — and nothing else in the team. Only a
 * team OWNER or an ADMIN sees this section; for anyone else it renders
 * nothing rather than an empty list that reads as "shared with nobody".
 */
export function ProjectSharing({
  projectId,
  shareUrl,
}: {
  projectId: string;
  shareUrl: string;
}) {
  const { data, refetch } = useQuery<ProjectSharesData>(PROJECT_SHARES_QUERY, { variables: { id: projectId } });
  const [runUpsert] = useMutation<{ workShareUpsert: MutationResult }>(WORK_SHARE_UPSERT_MUTATION);
  const [runRemove] = useMutation<{ workShareRemove: MutationResult }>(WORK_SHARE_REMOVE_MUTATION);

  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ShareRole>('VIEWER');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  const shares = useMemo(() => data?.issue?.shares ?? [], [data]);
  const candidates = useMemo(() => {
    const taken = new Set(shares.map((share) => share.user.id));
    return (data?.users.nodes ?? []).filter(
      (user) => user.actorKind !== 'SERVICE' && !user.deactivatedAt && !taken.has(user.id),
    );
  }, [data, shares]);

  if (!data?.issue?.viewerCanShare) {
    return null;
  }

  async function run(action: () => Promise<{ data?: Record<string, MutationResult> | null | undefined }>, key: string) {
    setError(null);
    setPending(true);
    try {
      const result = await action();
      const payload = result.data?.[key];
      if (!payload?.success) {
        setError(payload?.message ?? 'The server refused the change.');
        return false;
      }
      await refetch();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change the share.');
      return false;
    } finally {
      setPending(false);
    }
  }

  async function add() {
    if (!userId) return;
    const ok = await run(
      () => runUpsert({ variables: { role, userId, workId: projectId } }),
      'workShareUpsert',
    );
    if (ok) setUserId('');
  }

  return (
    <section className="project-sharing" aria-label="Sharing">
      <h2 className="project-sharing__title">Sharing</h2>
      <p className="project-sharing__hint">
        People and agents added here see this project, everything it contains and the team&apos;s
        issues on its repository — nothing else in the team. Editors can also update those issues.
      </p>

      <div className="project-sharing__link">
        <input readOnly aria-label="Share link" value={shareUrl} style={{ ...inputStyle, flex: 1 }} />
        <Btn
          variant="subtle"
          size="md"
          onClick={() => {
            void navigator.clipboard?.writeText(shareUrl);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Btn>
      </div>

      {shares.length === 0 ? (
        <p className="project-sharing__empty">Not shared with anyone outside the team.</p>
      ) : (
        <ul className="project-sharing__list">
          {shares.map((share) => (
            <li key={share.id} className="project-sharing__row">
              <span className="project-sharing__who">
                {displayName(share.user)}
                {share.user.actorKind === 'AGENT' ? <span className="actor-badge__kind"> AGENT</span> : null}
              </span>
              <select
                aria-label={`Role for ${displayName(share.user)}`}
                value={share.role}
                disabled={pending}
                style={inputStyle}
                onChange={(event) => void run(
                  () => runUpsert({ variables: { role: event.target.value as ShareRole, userId: share.user.id, workId: projectId } }),
                  'workShareUpsert',
                )}
              >
                <option value="VIEWER">{ROLE_COPY.VIEWER}</option>
                <option value="EDITOR">{ROLE_COPY.EDITOR}</option>
              </select>
              <Btn
                variant="ghost"
                size="md"
                disabled={pending}
                onClick={() => void run(
                  () => runRemove({ variables: { userId: share.user.id, workId: projectId } }),
                  'workShareRemove',
                )}
              >
                Remove
              </Btn>
            </li>
          ))}
        </ul>
      )}

      <div className="project-sharing__add">
        <select aria-label="Share with" value={userId} style={{ ...inputStyle, flex: 1 }} onChange={(event) => setUserId(event.target.value)}>
          <option value="">Choose a person or agent</option>
          {candidates.map((user) => (
            <option key={user.id} value={user.id}>
              {displayName(user)}{user.actorKind === 'AGENT' ? ' · agent' : ''}
            </option>
          ))}
        </select>
        <select aria-label="Share role" value={role} style={inputStyle} onChange={(event) => setRole(event.target.value as ShareRole)}>
          <option value="VIEWER">{ROLE_COPY.VIEWER}</option>
          <option value="EDITOR">{ROLE_COPY.EDITOR}</option>
        </select>
        <Btn variant="primary" size="md" disabled={!userId || pending} onClick={() => void add()}>
          Share
        </Btn>
      </div>

      {error ? <p className="project-sharing__error" role="alert">{error}</p> : null}
    </section>
  );
}
