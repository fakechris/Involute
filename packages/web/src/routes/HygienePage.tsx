import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';

import { readStoredTeamKey } from '../board/utils';
import { WORK_LINK_MUTATION, WORK_HYGIENE_QUERY } from '../work/queries';
import type { WorkHygieneQueryData, HygieneRef } from '../work/types';
import type { WorkLinkMutationData, WorkLinkMutationVariables } from '../board/types';
import { PageBody, PageHeader } from '../components/layout';
import { Btn } from '../components/Primitives';
import { IssueRow } from '../components/list';
import { Badge, EmptyState, InlineError, LoadingState, StatRow, StatTile } from '../components/status';

/**
 * Where the team's work graph falls short of norm v1 (INV-718/721): the
 * numbers to watch go to zero, with each item one click away. Recording a
 * worded dependency is offered inline; everything else is fixed on the item.
 */
export function HygienePage() {
  const teamKey = readStoredTeamKey() ?? 'INV';
  const { data, loading, error, refetch } = useQuery<WorkHygieneQueryData, { teamKey: string }>(WORK_HYGIENE_QUERY, {
    variables: { teamKey },
  });
  const [runLink] = useMutation<WorkLinkMutationData, WorkLinkMutationVariables>(WORK_LINK_MUTATION);
  const [linkError, setLinkError] = useState<string | null>(null);
  const hygiene = data?.workHygiene;
  /** "A mentions B": the second item as an inline reference. */
  const itemRef = (ref: HygieneRef) => <IssueRow as="div" variant="compact" issue={ref} open="drawer" />;

  return (
    <div className="observation-page">
      <PageHeader title="Work graph health" hint={`Team ${teamKey} · committed work against norm v1`} />
      <PageBody width="wide">
        {error ? (
          <div role="alert">
            <EmptyState
              title="Could not load the health check"
              body={error.message}
              action={<Btn variant="subtle" onClick={() => void refetch()}>Retry</Btn>}
            />
          </div>
        ) : loading && !hygiene ? (
          <LoadingState />
        ) : hygiene ? (
          <div className="hygiene">
            <StatRow aria-label="Summary">
              {[
                ['Not in any project tree', hygiene.unplacedCount],
                ['Mentions without a link', hygiene.unlinkedMentionCount],
                ['Dependencies without BLOCKS', hygiene.dependencyWithoutBlocksCount],
                ['Research with nothing derived', hygiene.researchWithoutDownstreamCount],
                ['Research ready to close', hygiene.researchClosableCount],
                ['Research without an attachment', hygiene.researchWithoutAttachmentCount],
                ['Incidents without follow-ups', hygiene.incidentsWithoutDownstreamCount],
                ['Incidents without a postmortem', hygiene.incidentsWithoutPostmortemCount],
                ['Overdue incident follow-ups', hygiene.overdueFollowUpCount],
              ].map(([label, count]) => (
                <StatTile key={label as string} tone={count ? 'warn' : 'success'} value={count} label={label} />
              ))}
            </StatRow>

            <section aria-label="Not in any project tree">
              <h2>Not in any project tree · {hygiene.unplacedCount}</h2>
              <p className="observation-hint">No parent chain reaches a PROJECT of the same repository. Give each a parent (it may sit directly under the project as "No milestone").</p>
              <ul className="list-rows">
                {hygiene.unplaced.map((item) => (
                  <IssueRow open="drawer" key={item.id} issue={item} meta={`${item.kind} · ${item.repository ?? 'no repository'}`} />
                ))}
              </ul>
            </section>

            <section aria-label="Dependencies without BLOCKS">
              <h2>Dependencies without BLOCKS · {hygiene.dependencyWithoutBlocksCount}</h2>
              <p className="observation-hint">The text reads like one depends on the other. Record it if it is true; ignore it if the mention is only an example.</p>
              {linkError ? <InlineError>{linkError}</InlineError> : null}
              <ul className="list-rows">
                {hygiene.dependencyWithoutBlocks.map((pair) => (
                  <IssueRow
                    open="drawer"
                    key={`${pair.from.id}>${pair.to.id}`}
                    issue={pair.from}
                    meta={<>mentions {itemRef(pair.to)}</>}
                    trailing={
                    <button
                      type="button"
                      className="ui-action"
                      onClick={async () => {
                        setLinkError(null);
                        try {
                          const result = await runLink({ variables: { fromId: pair.to.id, toId: pair.from.id, type: 'BLOCKS' } });
                          if (!result.data?.workLink.success) {
                            setLinkError(result.data?.workLink.message ?? `Could not record ${pair.to.identifier} blocks ${pair.from.identifier}.`);
                            return;
                          }
                        } catch (linkFailure) {
                          setLinkError(linkFailure instanceof Error ? linkFailure.message : String(linkFailure));
                          return;
                        }
                        await refetch();
                      }}
                    >
                      {pair.to.identifier} blocks {pair.from.identifier}
                    </button>
                    }
                  />
                ))}
              </ul>
            </section>

            <section aria-label="Research with nothing derived">
              <h2>Research with nothing derived · {hygiene.researchWithoutDownstreamCount}</h2>
              <p className="observation-hint">Finished research should lead somewhere: propose its actionable points and "won't do" decisions DERIVED_FROM it, or state "no actionable points".</p>
              <ul className="list-rows">
                {hygiene.researchWithoutDownstream.map((item) => (
                  <IssueRow open="drawer" key={item.id} issue={item} />
                ))}
              </ul>
            </section>

            <section aria-label="Research ready to close">
              <h2>Research ready to close · {hygiene.researchClosableCount}</h2>
              <p className="observation-hint">Everything derived from this research is committed; nothing is left to wait for. Its proposer closes it (an agent may, for Type: Research), or accept it here.</p>
              <ul className="list-rows">
                {hygiene.researchClosable.map((item) => (
                  <IssueRow open="drawer" key={item.id} issue={item} />
                ))}
              </ul>
            </section>

            <section aria-label="Research without an attachment">
              <h2>Research without an attachment · {hygiene.researchWithoutAttachmentCount}</h2>
              <p className="observation-hint">Finished research keeps its report as a file on the item, so others can check it: attach it from the item's Files (agents: work_attach_file). It leaves this list once a file is attached.</p>
              <ul className="list-rows">
                {hygiene.researchWithoutAttachment.map((item) => (
                  <IssueRow open="drawer" key={item.id} issue={item} />
                ))}
              </ul>
            </section>

            <section aria-label="Overdue incident follow-ups">
              <h2>Overdue incident follow-ups · {hygiene.overdueFollowUpCount}</h2>
              <p className="observation-hint">Committed work derived from an incident, past its deadline (Urgent 7 days, High 14, otherwise 30 from commitment; paused in Review). Finish it, or decline it with a reason.</p>
              <ul className="list-rows">
                {hygiene.overdueFollowUps.map((item) => (
                  <IssueRow open="drawer" key={item.id} issue={item} />
                ))}
              </ul>
            </section>

            <section aria-label="Incidents without follow-ups">
              <h2>Incidents without follow-ups · {hygiene.incidentsWithoutDownstreamCount}</h2>
              <p className="observation-hint">An incident closes once it led somewhere: propose its follow-ups DERIVED_FROM it, or state "无可执行点" in its description. Until then it cannot move to Done.</p>
              <ul className="list-rows">
                {hygiene.incidentsWithoutDownstream.map((item) => (
                  <IssueRow open="drawer" key={item.id} issue={item} meta={<Badge mono>{item.severity ?? 'no severity'}</Badge>} />
                ))}
              </ul>
            </section>

            <section aria-label="Incidents without a postmortem">
              <h2>Incidents without a postmortem · {hygiene.incidentsWithoutPostmortemCount}</h2>
              <p className="observation-hint">A SEV1 or SEV2 incident closes with its postmortem attached (docs/postmortem.md): attach it from the incident's Files.</p>
              <ul className="list-rows">
                {hygiene.incidentsWithoutPostmortem.map((item) => (
                  <IssueRow open="drawer" key={item.id} issue={item} meta={<Badge mono>{item.severity}</Badge>} />
                ))}
              </ul>
            </section>

            <section aria-label="Mentions without a link">
              <h2>Mentions without a link · {hygiene.unlinkedMentionCount}</h2>
              <p className="observation-hint">Written before mentions were linked automatically. New mentions link themselves.</p>
              <ul className="list-rows">
                {hygiene.unlinkedMentions.map((pair) => (
                  <IssueRow open="drawer" key={`${pair.from.id}>${pair.to.id}`} issue={pair.from} meta={<>mentions {itemRef(pair.to)}</>} />
                ))}
              </ul>
            </section>
          </div>
        ) : null}
      </PageBody>
    </div>
  );
}
