import { useMutation, useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { IcoCheck, IcoClose } from '../components/Icons';
import { Btn } from '../components/Primitives';
import {
  CANDIDATES_PAGE_QUERY,
  WORK_COMMIT_MUTATION,
  WORK_REJECT_MUTATION,
} from '../work/queries';
import type {
  CandidateWork,
  CandidatesPageQueryData,
  CandidatesPageQueryVariables,
  WorkCommitMutationData,
  WorkCommitMutationVariables,
  WorkRejectMutationData,
  WorkRejectMutationVariables,
  WorkUserSummary,
} from '../work/types';

const COMMIT_ERROR_MESSAGE = 'We could not commit this candidate. Check acceptance, owner, and revision.';
const REJECT_ERROR_MESSAGE = 'We could not reject this candidate. Please try again.';

function humanUsers(users: WorkUserSummary[]): WorkUserSummary[] {
  return users.filter((user) => user.actorKind !== 'AGENT' && user.actorKind !== 'SERVICE');
}

function CandidateCard({
  candidate,
  humans,
  onCommitted,
  onRejected,
}: {
  candidate: CandidateWork;
  humans: WorkUserSummary[];
  onCommitted: () => void;
  onRejected: () => void;
}) {
  const navigate = useNavigate();
  const [acceptance, setAcceptance] = useState(candidate.acceptance ?? '');
  const [assigneeId, setAssigneeId] = useState(candidate.assignee?.id ?? humans[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [runCommit] = useMutation<WorkCommitMutationData, WorkCommitMutationVariables>(WORK_COMMIT_MUTATION);
  const [runReject] = useMutation<WorkRejectMutationData, WorkRejectMutationVariables>(WORK_REJECT_MUTATION);

  async function handleCommit() {
    setError(null);
    const result = await runCommit({
      variables: {
        id: candidate.id,
        input: {
          expectedRevision: candidate.revision,
          ...(acceptance.trim() ? { acceptance: acceptance.trim() } : {}),
          ...(assigneeId ? { assigneeId } : {}),
        },
      },
    });

    if (!result.data?.workCommit.success || !result.data.workCommit.issue) {
      setError(COMMIT_ERROR_MESSAGE);
      return;
    }

    onCommitted();
  }

  async function handleReject() {
    setError(null);
    const result = await runReject({
      variables: {
        id: candidate.id,
        input: {
          expectedRevision: candidate.revision,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      },
    });

    if (!result.data?.workReject.success || !result.data.workReject.issue) {
      setError(REJECT_ERROR_MESSAGE);
      return;
    }

    onRejected();
  }

  return (
    <article className="observation-card" aria-label={`${candidate.identifier} candidate`}>
      <header className="observation-card__header">
        <button
          type="button"
          className="observation-card__id"
          onClick={() => navigate(`/work/${candidate.id}`)}
        >
          {candidate.identifier}
        </button>
        <span className="observation-card__status">candidate</span>
        <span className="observation-card__meta">{candidate.team.key}</span>
        <span className="observation-card__meta">rev {candidate.revision}</span>
      </header>
      <h2 className="observation-card__title">{candidate.title}</h2>
      {candidate.description ? <p className="observation-card__body">{candidate.description}</p> : null}
      <dl className="observation-contract">
        <div>
          <dt>Outcome</dt>
          <dd>{candidate.outcome || '—'}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{candidate.scope || '—'}</dd>
        </div>
        <div>
          <dt>Constraints</dt>
          <dd>{candidate.constraints || '—'}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>{candidate.verification || '—'}</dd>
        </div>
      </dl>
      <label className="observation-field">
        <span>Acceptance</span>
        <textarea
          aria-label={`Acceptance for ${candidate.identifier}`}
          value={acceptance}
          onChange={(event) => setAcceptance(event.target.value)}
          rows={3}
        />
      </label>
      <label className="observation-field">
        <span>Human owner</span>
        <select
          aria-label={`Owner for ${candidate.identifier}`}
          value={assigneeId}
          onChange={(event) => setAssigneeId(event.target.value)}
        >
          <option value="">Select owner</option>
          {humans.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name ?? user.email ?? user.id}
            </option>
          ))}
        </select>
      </label>
      <label className="observation-field">
        <span>Reject reason</span>
        <input
          aria-label={`Reject reason for ${candidate.identifier}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Optional"
        />
      </label>
      {error ? (
        <p className="observation-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="observation-card__actions">
        <Btn variant="accent" icon={<IcoCheck size={12} />} onClick={() => void handleCommit()}>
          Commit
        </Btn>
        <Btn variant="danger" icon={<IcoClose size={12} />} onClick={() => void handleReject()}>
          Reject
        </Btn>
        <Btn variant="ghost" onClick={() => navigate(`/work/${candidate.id}`)}>
          Open context
        </Btn>
      </div>
    </article>
  );
}

export function CandidatesPage() {
  const teamKey = readStoredTeamKey();
  const { data, loading, refetch } = useQuery<CandidatesPageQueryData, CandidatesPageQueryVariables>(
    CANDIDATES_PAGE_QUERY,
    {
      variables: {
        first: 100,
        filter: {
          commitmentStatus: 'CANDIDATE',
          ...(teamKey ? { team: { key: { eq: teamKey } } } : {}),
        },
      },
    },
  );
  const humans = useMemo(() => humanUsers(data?.users.nodes ?? []), [data?.users.nodes]);
  const candidates = data?.issues.nodes ?? [];

  return (
    <div className="observation-page">
      <div className="page-header">
        <h1 className="page-header__title">Candidates</h1>
        <span className="mono observation-count">{candidates.length}</span>
        <div style={{ flex: 1 }} />
        <span className="observation-hint">Proposed work waits here until a human commits it.</span>
      </div>
      <div className="page-content observation-content">
        {loading && candidates.length === 0 ? (
          <p className="observation-empty">Loading candidates…</p>
        ) : candidates.length === 0 ? (
          <div className="empty-state">
            <h3>No candidate work</h3>
            <p>Agents propose here. The board only shows committed issues.</p>
          </div>
        ) : (
          <div className="observation-list">
            {candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                humans={humans}
                onCommitted={() => void refetch()}
                onRejected={() => void refetch()}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
