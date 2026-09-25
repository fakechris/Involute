import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';

import {
  ISSUE_RELATIONS_QUERY,
  WORK_LINK_DELETE_MUTATION,
  WORK_LINK_MUTATION,
} from '../board/queries';
import type {
  IssueRelationEnd,
  IssueRelationsQueryData,
  IssueRelationsQueryVariables,
  WorkLinkDeleteMutationData,
  WorkLinkDeleteMutationVariables,
  WorkLinkMutationData,
  WorkLinkMutationVariables,
  WorkLinkType,
} from '../board/types';
import { Btn } from './Primitives';
import { StatusIcon } from './StatusIcon';

/**
 * How a typed link reads from the open issue's side. A link is stored once,
 * `from --type--> to`, so the same edge is "Blocked by" on one end and
 * "Blocking" on the other. CONTAINS is left out: the parent and sub-issues
 * already have their own places in the panel, and removing a CONTAINS edge
 * here would bypass the parent projection.
 */
const RELATION_GROUPS: Array<{
  key: string;
  label: string;
  type: WorkLinkType;
  direction: 'outgoing' | 'incoming' | 'either';
}> = [
  { key: 'blocked-by', label: 'Blocked by', type: 'BLOCKS', direction: 'incoming' },
  { key: 'blocking', label: 'Blocking', type: 'BLOCKS', direction: 'outgoing' },
  { key: 'related', label: 'Related', type: 'RELATED_TO', direction: 'either' },
  { key: 'duplicate-of', label: 'Duplicate of', type: 'DUPLICATE_OF', direction: 'outgoing' },
  { key: 'duplicated-by', label: 'Duplicated by', type: 'DUPLICATE_OF', direction: 'incoming' },
  { key: 'derived-from', label: 'Derived from', type: 'DERIVED_FROM', direction: 'outgoing' },
  { key: 'derivations', label: 'Derived into', type: 'DERIVED_FROM', direction: 'incoming' },
  { key: 'discovered-during', label: 'Discovered during', type: 'DISCOVERED_DURING', direction: 'outgoing' },
  { key: 'discoveries', label: 'Discovered here', type: 'DISCOVERED_DURING', direction: 'incoming' },
];

/** Relations a person can add from this issue; `reverse` means the target is the link's `from`. */
const ADDABLE_RELATIONS: Array<{ key: string; label: string; type: WorkLinkType; reverse: boolean }> = [
  { key: 'blocked-by', label: 'Blocked by', type: 'BLOCKS', reverse: true },
  { key: 'blocking', label: 'Blocking', type: 'BLOCKS', reverse: false },
  { key: 'related', label: 'Related to', type: 'RELATED_TO', reverse: false },
  { key: 'duplicate-of', label: 'Duplicate of', type: 'DUPLICATE_OF', reverse: false },
  { key: 'derived-from', label: 'Derived from', type: 'DERIVED_FROM', reverse: false },
  { key: 'discovered-during', label: 'Discovered during', type: 'DISCOVERED_DURING', reverse: false },
];

export interface RelationRow {
  linkId: string;
  other: IssueRelationEnd;
}

type RelationLink = NonNullable<NonNullable<IssueRelationsQueryData['issue']>['links']>['nodes'][number];

export function groupRelations(
  issueId: string,
  links: RelationLink[],
): Array<{ key: string; label: string; type: WorkLinkType; rows: RelationRow[] }> {
  return RELATION_GROUPS.map((group) => {
    const rows: RelationRow[] = [];
    for (const link of links) {
      if (link.type !== group.type) continue;
      const outgoing = link.from.id === issueId;
      const incoming = link.to.id === issueId;
      if (group.direction === 'outgoing' && outgoing) rows.push({ linkId: link.id, other: link.to });
      else if (group.direction === 'incoming' && incoming) rows.push({ linkId: link.id, other: link.from });
      else if (group.direction === 'either' && (outgoing || incoming)) {
        rows.push({ linkId: link.id, other: outgoing ? link.to : link.from });
      }
    }
    return { key: group.key, label: group.label, type: group.type, rows };
  }).filter((group) => group.rows.length > 0);
}

/** Same rule the ready queue applies: a committed blocker that is neither Done nor Canceled. */
export function isOpenBlocker(end: IssueRelationEnd): boolean {
  return (
    (end.commitmentStatus ?? 'COMMITTED') === 'COMMITTED' &&
    end.state?.type !== 'COMPLETED' &&
    end.state?.type !== 'CANCELED'
  );
}

function refusalMessage(message: string | null | undefined): string {
  return message?.trim() || 'The server refused the change.';
}

interface IssueRelationsProps {
  issueId: string;
  disabled?: boolean;
  onOpen: (issueId: string) => void;
}

export function IssueRelations({ issueId, disabled = false, onOpen }: IssueRelationsProps) {
  const [adding, setAdding] = useState(false);
  const [relationKey, setRelationKey] = useState(ADDABLE_RELATIONS[0]!.key);
  const [target, setTarget] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, loading, error: loadError, refetch } = useQuery<IssueRelationsQueryData, IssueRelationsQueryVariables>(
    ISSUE_RELATIONS_QUERY,
    { variables: { id: issueId }, fetchPolicy: 'cache-and-network' },
  );
  // The board's blocked markers come from the same links, so refresh it too.
  const [createLink] = useMutation<WorkLinkMutationData, WorkLinkMutationVariables>(
    WORK_LINK_MUTATION,
    { refetchQueries: ['BoardPage'] },
  );
  const [deleteLink] = useMutation<WorkLinkDeleteMutationData, WorkLinkDeleteMutationVariables>(WORK_LINK_DELETE_MUTATION, {
    refetchQueries: ['BoardPage'],
  });

  const links = data?.issue?.id === issueId ? data.issue.links?.nodes ?? [] : [];
  const groups = groupRelations(issueId, links);

  /** `action` resolves to null on success, or the reason the server gave for refusing. */
  async function run(action: () => Promise<string | null>) {
    setError(null);
    setPending(true);
    try {
      const refusal = await action();
      if (refusal === null) {
        await refetch();
      } else {
        setError(refusal);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change the relation.');
    } finally {
      setPending(false);
    }
  }

  function submitAdd() {
    const relation = ADDABLE_RELATIONS.find((candidate) => candidate.key === relationKey);
    const other = target.trim().toUpperCase();
    if (!relation || !other) return;
    void run(async () => {
      const result = await createLink({
        variables: {
          fromId: relation.reverse ? other : issueId,
          toId: relation.reverse ? issueId : other,
          type: relation.type,
        },
      });
      const payload = result?.data?.workLink;
      if (!payload?.success) return refusalMessage(payload?.message);
      setTarget('');
      setAdding(false);
      return null;
    });
  }

  return (
    <div className="issue-panel__section issue-relations" aria-label="Relations">
      <div className="issue-relations__header">
        <span className="issue-panel__label">Relations</span>
        {!adding ? (
          <Btn variant="ghost" size="sm" disabled={disabled || pending} onClick={() => setAdding(true)}>
            Add relation
          </Btn>
        ) : null}
      </div>

      {loadError && links.length === 0 ? (
        <p className="issue-relations__error" role="alert">Could not load relations.</p>
      ) : loading && !data ? (
        <p className="issue-panel__empty-hint">Loading relations…</p>
      ) : groups.length === 0 && !adding ? (
        <p className="issue-panel__empty-hint">No blocking, related or duplicate links.</p>
      ) : null}

      {groups.map((group) => (
        <div key={group.key} className="issue-relations__group">
          <span className="issue-relations__group-label">
            {group.label} · {group.rows.length}
          </span>
          <div className="issue-children" role="list" aria-label={group.label}>
            {group.rows.map((row) => {
              const blocking = group.key === 'blocked-by' && isOpenBlocker(row.other);
              return (
                <div
                  key={row.linkId}
                  role="listitem"
                  className={`issue-relations__row${blocking ? ' issue-relations__row--open-blocker' : ''}`}
                >
                  <button
                    type="button"
                    className="issue-children__row issue-relations__open"
                    onClick={() => onOpen(row.other.id)}
                    aria-label={`Open ${row.other.identifier}`}
                  >
                    <span className="issue-children__id">{row.other.identifier}</span>
                    <StatusIcon stateName={row.other.state?.name ?? ''} size={12} />
                    <span className="issue-children__title">{row.other.title}</span>
                    <span className="issue-relations__state">
                      {row.other.commitmentStatus === 'CANDIDATE' ? 'Candidate' : row.other.state?.name ?? ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="issue-relations__remove"
                    aria-label={`Remove ${group.label.toLowerCase()} ${row.other.identifier}`}
                    title="Remove relation"
                    disabled={disabled || pending}
                    onClick={() =>
                      void run(async () => {
                        const result = await deleteLink({ variables: { id: row.linkId } });
                        const payload = result?.data?.workLinkDelete;
                        return payload?.success ? null : refusalMessage(payload?.message);
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {adding ? (
        <form
          className="issue-relations__form"
          onSubmit={(event) => {
            event.preventDefault();
            submitAdd();
          }}
        >
          <select
            aria-label="Relation type"
            value={relationKey}
            disabled={pending}
            onChange={(event) => setRelationKey(event.target.value)}
          >
            {ADDABLE_RELATIONS.map((relation) => (
              <option key={relation.key} value={relation.key}>
                {relation.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Related issue identifier"
            placeholder="INV-123"
            value={target}
            disabled={pending}
            autoFocus
            onChange={(event) => setTarget(event.target.value)}
          />
          <Btn variant="primary" size="sm" disabled={pending || !target.trim()} onClick={submitAdd}>
            Add
          </Btn>
          <Btn
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setAdding(false);
              setTarget('');
              setError(null);
            }}
          >
            Cancel
          </Btn>
        </form>
      ) : null}

      {error ? (
        <p className="issue-relations__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
