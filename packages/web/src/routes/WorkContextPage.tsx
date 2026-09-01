import { useQuery } from '@apollo/client/react';
import { useNavigate, useParams } from 'react-router-dom';

import { IcoChevL } from '../components/Icons';
import { Btn } from '../components/Primitives';
import { WORK_CONTEXT_PAGE_QUERY } from '../work/queries';
import type { WorkContextPageQueryData, WorkContextPageQueryVariables, WorkRef } from '../work/types';

function formatWhen(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function ContractField({ label, value }: { label: string; value?: string | null | undefined }) {
  return (
    <div className="observation-contract__item">
      <dt>{label}</dt>
      <dd>{value?.trim() ? value : '—'}</dd>
    </div>
  );
}

function RelatedList({
  label,
  items,
  onOpen,
}: {
  label: string;
  items: WorkRef[];
  onOpen: (id: string) => void;
}) {
  return (
    <section className="work-context__section">
      <h2>{label}</h2>
      {items.length === 0 ? (
        <p className="observation-empty">None</p>
      ) : (
        <ul className="work-context__links">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" className="observation-card__id" onClick={() => onOpen(item.id)}>
                {item.identifier}
              </button>
              <span>{item.title}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function WorkContextPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { data, error, loading } = useQuery<WorkContextPageQueryData, WorkContextPageQueryVariables>(
    WORK_CONTEXT_PAGE_QUERY,
    {
      skip: !id,
      variables: { id: id ?? '' },
    },
  );
  const bundle = data?.workContext ?? null;

  if (loading && !bundle) {
    return (
      <div className="observation-page">
        <div className="page-header">
          <h1 className="page-header__title">Work context</h1>
        </div>
        <p className="observation-empty">Loading work context…</p>
      </div>
    );
  }

  if (error || !bundle) {
    return (
      <div className="observation-page">
        <div className="page-header">
          <h1 className="page-header__title">Work context</h1>
        </div>
        <div className="empty-state">
          <h3>Work not found</h3>
          <p>Context is loaded from the kernel by identifier or UUID.</p>
        </div>
      </div>
    );
  }

  const work = bundle.work;

  return (
    <div className="observation-page">
      <div className="page-header">
        <Btn variant="ghost" icon={<IcoChevL size={12} />} onClick={() => navigate(-1)}>
          Back
        </Btn>
        <span className="mono">{work.identifier}</span>
        <span className="page-header__title">{work.title}</span>
        <span className="observation-card__status">{work.commitmentStatus.toLowerCase()}</span>
        <span className="observation-card__meta">{work.state.name}</span>
        <span className="observation-card__meta">rev {work.revision}</span>
        <div style={{ flex: 1 }} />
        <Btn variant="subtle" onClick={() => navigate(`/issue/${work.id}`)}>
          Issue editor
        </Btn>
      </div>
      <div className="page-content observation-content work-context">
        <section className="work-context__section">
          <h2>Contract</h2>
          <dl className="observation-contract observation-contract--stack">
            <ContractField label="Kind" value={work.kind.toLowerCase()} />
            <ContractField label="Outcome" value={work.outcome} />
            <ContractField label="Scope" value={work.scope} />
            <ContractField label="Constraints" value={work.constraints} />
            <ContractField label="Acceptance" value={work.acceptance} />
            <ContractField label="Verification" value={work.verification} />
            <ContractField label="Repository" value={work.repository} />
            <ContractField label="Owner" value={work.assignee?.name ?? work.assignee?.email} />
          </dl>
        </section>
        <RelatedList label="Contains ancestors" items={bundle.ancestors} onOpen={(workId) => navigate(`/work/${workId}`)} />
        <RelatedList label="Blocked by" items={bundle.blockedBy} onOpen={(workId) => navigate(`/work/${workId}`)} />
        <RelatedList label="Blocks" items={bundle.blocks} onOpen={(workId) => navigate(`/work/${workId}`)} />
        <section className="work-context__section">
          <h2>Claim</h2>
          {bundle.claim ? (
            <p>
              {bundle.claim.actor.name ?? bundle.claim.actor.email ?? 'Actor'} until {formatWhen(bundle.claim.leaseUntil)}
            </p>
          ) : (
            <p className="observation-empty">Unclaimed</p>
          )}
        </section>
        <section className="work-context__section">
          <h2>Runs</h2>
          {bundle.runs.length === 0 ? (
            <p className="observation-empty">No runs</p>
          ) : (
            <ul className="work-context__timeline">
              {bundle.runs.map((run) => (
                <li key={run.id}>
                  <strong className="mono">{run.publicId}</strong>
                  <span>{run.status.toLowerCase()}</span>
                  {run.phase ? <span>{run.phase}</span> : null}
                  {run.summary ? <span>{run.summary}</span> : null}
                  {run.externalUrl ? (
                    <a href={run.externalUrl} target="_blank" rel="noreferrer">
                      {run.externalUrl}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="work-context__section">
          <h2>Evidence</h2>
          {bundle.evidence.length === 0 ? (
            <p className="observation-empty">No evidence</p>
          ) : (
            <ul className="work-context__timeline">
              {bundle.evidence.map((item) => (
                <li key={item.id}>
                  <strong>{item.kind.toLowerCase()}</strong>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.url}
                  </a>
                  {item.summary ? <span>{item.summary}</span> : null}
                  <span className="observation-card__meta">{formatWhen(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="work-context__section">
          <h2>Audits</h2>
          {bundle.audits.length === 0 ? (
            <p className="observation-empty">No audits</p>
          ) : (
            <ul className="work-context__timeline">
              {bundle.audits.map((audit) => (
                <li key={audit.id}>
                  <strong>rev {audit.revision}</strong>
                  <span>{audit.actorKind.toLowerCase()}</span>
                  {audit.actor?.name || audit.actor?.email ? (
                    <span>{audit.actor.name ?? audit.actor.email}</span>
                  ) : null}
                  {audit.surface ? <span>{audit.surface}</span> : null}
                  {audit.reason ? <span>{audit.reason}</span> : null}
                  <span className="observation-card__meta">{formatWhen(audit.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
