import { useMutation, useQuery } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { WORK_LINK_MUTATION, WORK_HYGIENE_QUERY } from '../work/queries';
import type { WorkHygieneQueryData, HygieneRef } from '../work/types';
import type { WorkLinkMutationData, WorkLinkMutationVariables } from '../board/types';

/**
 * Where the team's work graph falls short of norm v1 (INV-718/721): the
 * numbers to watch go to zero, with each item one click away. Recording a
 * worded dependency is offered inline; everything else is fixed on the item.
 */
export function HygienePage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey() ?? 'INV';
  const { data, loading, error, refetch } = useQuery<WorkHygieneQueryData, { teamKey: string }>(WORK_HYGIENE_QUERY, {
    variables: { teamKey },
  });
  const [runLink] = useMutation<WorkLinkMutationData, WorkLinkMutationVariables>(WORK_LINK_MUTATION);
  const hygiene = data?.workHygiene;
  const open = (ref: HygieneRef) => navigate(`/issue/${ref.id}`);
  const itemButton = (ref: HygieneRef) => (
    <button type="button" className="hygiene-item" onClick={() => open(ref)} title={ref.title}>
      <span className="mono">{ref.identifier}</span>
      <span className="hygiene-item__title">{ref.title}</span>
    </button>
  );

  return (
    <div className="observation-page">
      <div className="page-header">
        <h1 className="page-header__title">Work graph health</h1>
        <span className="observation-hint">Team {teamKey} · committed work against norm v1</span>
      </div>
      <div className="page-content observation-content">
        {error ? (
          <div className="empty-state" role="alert">
            <h3>Could not load the health check</h3>
            <p>{error.message}</p>
            <button type="button" onClick={() => void refetch()}>Retry</button>
          </div>
        ) : loading && !hygiene ? (
          <p className="observation-empty" role="status">Loading…</p>
        ) : hygiene ? (
          <div className="hygiene">
            <div className="hygiene-summary" aria-label="Summary">
              {[
                ['Not in any project tree', hygiene.unplacedCount],
                ['Mentions without a link', hygiene.unlinkedMentionCount],
                ['Dependencies without BLOCKS', hygiene.dependencyWithoutBlocksCount],
                ['Research with nothing derived', hygiene.researchWithoutDownstream.length],
              ].map(([label, count]) => (
                <div key={label as string} className={`hygiene-stat${count ? ' hygiene-stat--open' : ''}`}>
                  <span className="hygiene-stat__count">{count}</span>
                  <span>{label}</span>
                </div>
              ))}
            </div>

            <section aria-label="Not in any project tree">
              <h2>Not in any project tree · {hygiene.unplacedCount}</h2>
              <p className="observation-hint">No parent chain reaches a PROJECT of the same repository. Give each a parent (it may sit directly under the project as "No milestone").</p>
              <ul className="hygiene-list">
                {hygiene.unplaced.map((item) => (
                  <li key={item.id}>
                    {itemButton(item)}
                    <span className="observation-card__meta">{item.kind} · {item.repository ?? 'no repository'}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-label="Dependencies without BLOCKS">
              <h2>Dependencies without BLOCKS · {hygiene.dependencyWithoutBlocksCount}</h2>
              <p className="observation-hint">The text reads like one depends on the other. Record it if it is true; ignore it if the mention is only an example.</p>
              <ul className="hygiene-list">
                {hygiene.dependencyWithoutBlocks.map((pair) => (
                  <li key={`${pair.from.id}>${pair.to.id}`}>
                    {itemButton(pair.from)}
                    <span className="observation-hint">mentions</span>
                    {itemButton(pair.to)}
                    <button
                      type="button"
                      className="ui-action"
                      onClick={async () => {
                        await runLink({ variables: { fromId: pair.to.id, toId: pair.from.id, type: 'BLOCKS' } });
                        await refetch();
                      }}
                    >
                      {pair.to.identifier} blocks {pair.from.identifier}
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-label="Research with nothing derived">
              <h2>Research with nothing derived · {hygiene.researchWithoutDownstream.length}</h2>
              <p className="observation-hint">Finished research should lead somewhere: propose its actionable points and "won't do" decisions DERIVED_FROM it, or state "no actionable points".</p>
              <ul className="hygiene-list">
                {hygiene.researchWithoutDownstream.map((item) => (
                  <li key={item.id}>{itemButton(item)}</li>
                ))}
              </ul>
            </section>

            <section aria-label="Mentions without a link">
              <h2>Mentions without a link · {hygiene.unlinkedMentionCount}</h2>
              <p className="observation-hint">Written before mentions were linked automatically. New mentions link themselves.</p>
              <ul className="hygiene-list">
                {hygiene.unlinkedMentions.map((pair) => (
                  <li key={`${pair.from.id}>${pair.to.id}`}>
                    {itemButton(pair.from)}
                    <span className="observation-hint">mentions</span>
                    {itemButton(pair.to)}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
