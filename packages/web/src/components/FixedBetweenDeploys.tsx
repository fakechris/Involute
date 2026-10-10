import { useState, type FormEvent } from 'react';
import { useLazyQuery, useQuery } from '@apollo/client/react';
import { Link } from 'react-router-dom';

import { BUGS_FIXED_BETWEEN_QUERY, SERVER_BUILD_QUERY } from '../board/queries';
import type { BugsFixedBetweenQueryData, ServerBuildQueryData } from '../board/types';

const SHA = /^(sha-)?[0-9a-f]{7,40}$/i;

const SOURCE_LABEL: Record<string, string> = {
  MERGE_EVENT: 'merged PR',
  VERIFIED_EVIDENCE: 'verified PR',
  BUG_GATE: 'bug gate',
};

/**
 * Bugs fixed between two deploys (INV-1121): a simple changelog. Involute
 * deploys by SHA and has no version numbers (decision INV-1130), so a range
 * is two deploy SHAs; "to" starts as the build this server runs. A range
 * GitHub cannot list is shown as unknown with the reason — never as "no bugs".
 */
export function FixedBetweenDeploys({ repositories }: { repositories: string[] }) {
  const build = useQuery<ServerBuildQueryData>(SERVER_BUILD_QUERY);
  const runningBuildSha = build.data?.serverBuild?.buildSha ?? null;
  const [repository, setRepository] = useState<string | null>(null);
  const [fromSha, setFromSha] = useState('');
  // null: not edited, so it follows the running build.
  const [toSha, setToSha] = useState<string | null>(null);
  const [run, { data, loading, error }] = useLazyQuery<BugsFixedBetweenQueryData, { repository: string; fromSha: string; toSha: string }>(
    BUGS_FIXED_BETWEEN_QUERY,
    { fetchPolicy: 'network-only' },
  );

  const repo = repository ?? repositories[0] ?? '';
  const to = (toSha ?? runningBuildSha ?? '').trim();
  const from = fromSha.trim();
  const valid = Boolean(repo) && SHA.test(from) && SHA.test(to);
  const result = data?.bugsFixedBetween;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid) void run({ variables: { repository: repo, fromSha: from, toSha: to } });
  }

  return (
    <section className="bugs-panel" aria-label="Bugs fixed between deploys">
      <h2 className="bugs-panel__title">Fixed between deploys</h2>
      <form className="request-actions" onSubmit={submit}>
        <select aria-label="Changelog project" value={repo} onChange={(event) => setRepository(event.target.value)} disabled={repositories.length === 0}>
          {repositories.length === 0 ? <option value="">No project</option> : null}
          {repositories.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <input aria-label="From deploy SHA" placeholder="From SHA (older)" spellCheck={false} value={fromSha} onChange={(event) => setFromSha(event.target.value)} />
        <input aria-label="To deploy SHA" placeholder="To SHA (newer)" spellCheck={false} value={toSha ?? runningBuildSha ?? ''} onChange={(event) => setToSha(event.target.value)} />
        <button type="submit" className="ui-action ui-action--accent" disabled={!valid || loading}>
          List fixes
        </button>
      </form>
      {error ? <p role="alert" className="issue-relations__error">{error.message}</p> : null}
      {result && !result.known ? (
        <p role="alert" className="issue-relations__error">
          Unknown range: {result.message ?? 'GitHub could not list the commits between these SHAs.'} ({result.failureCode})
        </p>
      ) : null}
      {result?.known ? (
        result.bugs.length === 0 ? (
          <p className="bugs-panel__empty">
            No bug fix merged in {result.commitCount ?? 0} commit(s) from {result.fromSha.slice(0, 12)} to {result.toSha.slice(0, 12)}.
          </p>
        ) : (
          <table className="bugs-table">
            <thead>
              <tr>
                <th>Bug</th>
                <th>Status</th>
                <th>Fix</th>
              </tr>
            </thead>
            <tbody>
              {result.bugs.map((bug) => (
                <tr key={bug.issue.id}>
                  <td>
                    <Link className="mono" to={`/issue/${encodeURIComponent(bug.issue.identifier)}`}>{bug.issue.identifier}</Link> {bug.issue.title}
                  </td>
                  <td>{bug.issue.state.name}</td>
                  <td className="mono" title={`${bug.fixSha} (${SOURCE_LABEL[bug.source] ?? bug.source})`}>
                    {bug.fixSha.slice(0, 12)}{bug.prNumber ? ` · #${bug.prNumber}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </section>
  );
}
