import { useEffect, useState } from 'react';
import { useLazyQuery, useMutation, useQuery } from '@apollo/client/react';
import { Link, useLocation } from 'react-router-dom';

import {
  OPS_INBOUND_REPLAY_MUTATION,
  OPS_OVERVIEW_QUERY,
  OPS_SYNC_DEAD_LETTER_CLEAR_MUTATION,
  TRACEABILITY_AUDIT_QUERY,
  WEBHOOK_CREATE_MUTATION,
  WEBHOOK_DELETE_MUTATION,
  WEBHOOK_ROTATE_SECRET_MUTATION,
  WEBHOOK_UPDATE_MUTATION,
  type MutationResult,
  type OpsOverviewData,
  type OpsWebhook,
  type TraceabilityAuditData,
} from '../ops/queries';

const REFETCH = ['OpsOverview'];

function isForbidden(error: unknown): boolean {
  const graphQLErrors = (error as { errors?: Array<{ extensions?: { code?: unknown } }> } | undefined)?.errors ?? [];
  return graphQLErrors.some((graphQLError) => graphQLError.extensions?.code === 'FORBIDDEN');
}

function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/**
 * The ops page (INV-796): the checks and recoveries of AGENTS.md §9 — sync
 * watermarks and dead letters, the inbound GitHub queue, failed outbox events,
 * webhooks and the traceability audit — for workspace admins. Every action
 * asks why and lands on the ops audit at the bottom of the page.
 */
export function OpsPage() {
  // The server decides who is an admin; a refusal is shown as such.
  const { data, loading, error, refetch } = useQuery<OpsOverviewData>(OPS_OVERVIEW_QUERY);
  const forbidden = isForbidden(error);
  const overview = data?.opsOverview;
  const { hash } = useLocation();
  // An ops notification links to its section; scroll there once it renders.
  useEffect(() => {
    if (overview && hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [overview, hash]);

  if (forbidden) {
    return (
      <div className="observation-page">
        <div className="page-header"><h1 className="page-header__title">Ops</h1></div>
        <div className="page-content observation-content">
          <p className="observation-empty">The ops page is for workspace admins.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="observation-page">
      <div className="page-header">
        <h1 className="page-header__title">Ops</h1>
        <span className="observation-hint">Sync, inbound queue, outbox, webhooks and traceability · admins only</span>
      </div>
      <div className="page-content observation-content ops">
        {error ? (
          <div className="empty-state" role="alert">
            <h3>Could not load ops</h3>
            <p>{error.message}</p>
            <button type="button" onClick={() => void refetch()}>Retry</button>
          </div>
        ) : loading && !overview ? (
          <p className="observation-empty" role="status">Loading…</p>
        ) : overview ? (
          <>
            <section id="sync" className="work-context__section">
              <h2>GitHub sync</h2>
              {overview.watermarks.length === 0 ? (
                <p className="observation-empty">No repository has synced yet.</p>
              ) : (
                <table className="ops-table" aria-label="Sync watermarks">
                  <thead><tr><th>Repository</th><th>Synced up to</th><th>Last run</th></tr></thead>
                  <tbody>
                    {overview.watermarks.map((row) => (
                      <tr key={row.key}><td className="mono">{row.repository}</td><td>{when(row.watermark)}</td><td>{when(row.updatedAt)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section id="sync-dead-letters" className="work-context__section">
              <h2>Sync dead letters</h2>
              <p className="observation-hint">PRs that failed three times. Clearing one makes the next sync (within 10 minutes) retry it.</p>
              {overview.syncDeadLetters.length === 0 ? (
                <p className="observation-empty">None.</p>
              ) : (
                <ul className="work-context__timeline">
                  {overview.syncDeadLetters.map((row) => (
                    <li key={row.id} className="observation-card">
                      <span className="mono">{row.repository} {row.itemRef}</span>
                      <span>{row.attempts} attempts · last {when(row.lastFailedAt)}</span>
                      <p className="observation-card__body mono">{row.error}</p>
                      <ReasonAction
                        label="Clear and retry"
                        mutation={OPS_SYNC_DEAD_LETTER_CLEAR_MUTATION}
                        field="opsSyncDeadLetterClear"
                        variables={{ id: row.id }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section id="inbound" className="work-context__section">
              <h2>Inbound GitHub deliveries</h2>
              <p aria-label="Inbound counts">
                {overview.inbound.counts.length === 0
                  ? 'No deliveries recorded.'
                  : overview.inbound.counts.map((row) => `${row.status.toLowerCase()} ${row.count}`).join(' · ')}
                {overview.inbound.oldestPendingAt ? ` · oldest waiting since ${when(overview.inbound.oldestPendingAt)}` : ''}
              </p>
              {overview.inbound.dead.length === 0 ? null : (
                <ul className="work-context__timeline">
                  {overview.inbound.dead.map((row) => (
                    <li key={row.id} className="observation-card">
                      <span className="mono">{row.repository}</span>
                      <span>{row.eventType} · {row.deliveryId}</span>
                      <span>{row.attempts} attempts{row.lastErrorCode ? ` · ${row.lastErrorCode}` : ''}</span>
                      <span className="observation-card__meta">received {when(row.receivedAt)}</span>
                      {row.replayable ? (
                        <ReasonAction
                          label="Replay"
                          mutation={OPS_INBOUND_REPLAY_MUTATION}
                          field="opsInboundReplay"
                          variables={{ id: row.id, expectedAttempts: row.attempts }}
                        />
                      ) : (
                        <span className="observation-card__meta">payload compacted; cannot replay</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section id="outbox" className="work-context__section">
              <h2>Outbox failures</h2>
              <p className="observation-hint">Events not yet delivered that failed, newest first.</p>
              {overview.outboxFailures.length === 0 ? (
                <p className="observation-empty">None.</p>
              ) : (
                <table className="ops-table" aria-label="Outbox failures">
                  <thead><tr><th>Event</th><th>Attempts</th><th>Last error</th><th>Created</th><th>Dead-lettered</th></tr></thead>
                  <tbody>
                    {overview.outboxFailures.map((row) => (
                      <tr key={row.id}>
                        <td className="mono">{row.type}</td>
                        <td>{row.attempts}</td>
                        <td className="mono">{row.lastError ?? '—'}</td>
                        <td>{when(row.createdAt)}</td>
                        <td>{when(row.deadLetteredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section id="webhooks" className="work-context__section">
              <h2>Webhooks</h2>
              <WebhookCreateForm />
              {overview.webhooks.length === 0 ? (
                <p className="observation-empty">No subscriptions.</p>
              ) : (
                <ul className="work-context__timeline">
                  {overview.webhooks.map((webhook) => <WebhookRow key={webhook.id} webhook={webhook} />)}
                </ul>
              )}
            </section>

            <section id="traceability" className="work-context__section">
              <h2>Traceability audit</h2>
              <TraceabilityAudit />
            </section>

            <section id="audit" className="work-context__section">
              <h2>Ops audit</h2>
              {overview.audits.length === 0 ? (
                <p className="observation-empty">No ops actions yet.</p>
              ) : (
                <ul className="work-context__timeline" aria-label="Ops audit">
                  {overview.audits.map((audit) => (
                    <li key={audit.id}>
                      <span className="mono">{audit.action}</span>
                      <span>{audit.subject}</span>
                      {audit.reason ? <span>“{audit.reason}”</span> : null}
                      <span className="observation-card__meta">{audit.byActor?.name ?? 'system'} · {when(audit.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A recovery action that asks why before it runs; the reason goes on the ops audit. */
function ReasonAction({
  label,
  mutation,
  field,
  variables,
}: {
  label: string;
  mutation: typeof OPS_SYNC_DEAD_LETTER_CLEAR_MUTATION;
  field: 'opsSyncDeadLetterClear' | 'opsInboundReplay';
  variables: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [run, state] = useMutation<Record<string, MutationResult>>(mutation, { refetchQueries: REFETCH });

  async function submit() {
    setError(null);
    try {
      const result = (await run({ variables: { ...variables, reason: reason.trim() } })).data?.[field];
      if (!result?.success) {
        setError(result?.message ?? `Could not ${label.toLowerCase()}.`);
        return;
      }
      setOpen(false);
      setReason('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${label.toLowerCase()}.`);
    }
  }

  if (!open) {
    return <button type="button" className="ui-action" onClick={() => setOpen(true)}>{label}</button>;
  }
  return (
    <div className="request-actions">
      <input aria-label={`Why: ${label}`} placeholder="Why (kept on the ops audit)" value={reason} onChange={(event) => setReason(event.target.value)} />
      <button type="button" className="ui-action ui-action--accent" disabled={!reason.trim() || state?.loading} onClick={() => void submit()}>
        {label}
      </button>
      <button type="button" className="ui-action" onClick={() => setOpen(false)}>Cancel</button>
      {error ? <span role="alert" className="issue-relations__error">{error}</span> : null}
    </div>
  );
}

function parseEventTypes(text: string): string[] {
  return text.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
}

function WebhookCreateForm() {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [team, setTeam] = useState('');
  const [eventTypes, setEventTypes] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, state] = useMutation<{ webhookCreate: MutationResult & { secret: string | null } }>(WEBHOOK_CREATE_MUTATION, { refetchQueries: REFETCH });

  async function submit() {
    setError(null);
    setSecret(null);
    try {
      const result = (
        await run({
          variables: {
            input: {
              url: url.trim(),
              label: label.trim() || null,
              team: team.trim() || null,
              eventTypes: parseEventTypes(eventTypes),
            },
          },
        })
      ).data?.webhookCreate;
      if (!result?.success) {
        setError(result?.message ?? 'Could not add the webhook.');
        return;
      }
      setSecret(result.secret);
      setUrl('');
      setLabel('');
      setEventTypes('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add the webhook.');
    }
  }

  return (
    <div className="request-actions" aria-label="Add a webhook">
      <input aria-label="Webhook URL" placeholder="https://…" value={url} onChange={(event) => setUrl(event.target.value)} />
      <input aria-label="Webhook label" placeholder="Label" value={label} onChange={(event) => setLabel(event.target.value)} />
      <input aria-label="Webhook team" placeholder="Team key (blank: all teams)" value={team} onChange={(event) => setTeam(event.target.value)} />
      <input
        aria-label="Webhook events"
        placeholder="Events, comma separated (blank: all)"
        value={eventTypes}
        onChange={(event) => setEventTypes(event.target.value)}
      />
      <button type="button" className="ui-action ui-action--accent" disabled={!url.trim() || state?.loading} onClick={() => void submit()}>
        Add webhook
      </button>
      {secret ? <SecretOnce secret={secret} /> : null}
      {error ? <span role="alert" className="issue-relations__error">{error}</span> : null}
    </div>
  );
}

function SecretOnce({ secret }: { secret: string }) {
  return (
    <p role="status" className="ops-secret">
      Signing secret, shown once — copy it now: <code>{secret}</code>
    </p>
  );
}

function WebhookRow({ webhook }: { webhook: OpsWebhook }) {
  const [events, setEvents] = useState(webhook.eventTypes.join(', '));
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runUpdate, updateState] = useMutation<{ webhookUpdate: MutationResult }>(WEBHOOK_UPDATE_MUTATION, { refetchQueries: REFETCH });
  const [runRotate] = useMutation<{ webhookRotateSecret: MutationResult & { secret: string | null } }>(WEBHOOK_ROTATE_SECRET_MUTATION, {
    refetchQueries: REFETCH,
  });
  const [runDelete] = useMutation<{ webhookDelete: MutationResult }>(WEBHOOK_DELETE_MUTATION, { refetchQueries: REFETCH });

  async function attempt(action: () => Promise<MutationResult | undefined>, fallback: string) {
    setError(null);
    try {
      const result = await action();
      if (!result?.success) setError(result?.message ?? fallback);
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
      return undefined;
    }
  }

  const update = (input: Record<string, unknown>) =>
    attempt(async () => (await runUpdate({ variables: { id: webhook.id, input } })).data?.webhookUpdate, 'Could not update the webhook.');

  return (
    <li className="observation-card" aria-label={`Webhook ${webhook.label ?? webhook.url}`}>
      <span>{webhook.label ?? 'Unlabelled'}</span>
      <span className="mono">{webhook.url}</span>
      <span>{webhook.teamId ? 'one team' : 'all teams'}</span>
      <span className={webhook.enabled ? '' : 'issue-relations__error'}>
        {webhook.enabled ? 'enabled' : `disabled${webhook.consecutiveFailures ? ` after ${webhook.consecutiveFailures} failures` : ''}`}
      </span>
      <div className="request-actions">
        <input aria-label={`Events for ${webhook.url}`} placeholder="All events" value={events} onChange={(event) => setEvents(event.target.value)} />
        <button type="button" className="ui-action" disabled={updateState?.loading} onClick={() => void update({ eventTypes: parseEventTypes(events) })}>
          Save events
        </button>
        <button type="button" className="ui-action" onClick={() => void update({ enabled: !webhook.enabled })}>
          {webhook.enabled ? 'Disable' : 'Re-enable'}
        </button>
        <button
          type="button"
          className="ui-action"
          onClick={() =>
            void attempt(async () => {
              const result = (await runRotate({ variables: { id: webhook.id } })).data?.webhookRotateSecret;
              if (result?.success) setSecret(result.secret);
              return result;
            }, 'Could not rotate the secret.')
          }
        >
          Rotate secret
        </button>
        <button
          type="button"
          className="ui-action"
          onClick={() => {
            if (!window.confirm(`Delete the webhook to ${webhook.url}?`)) return;
            void attempt(async () => (await runDelete({ variables: { id: webhook.id } })).data?.webhookDelete, 'Could not delete the webhook.');
          }}
        >
          Delete webhook
        </button>
      </div>
      {secret ? <SecretOnce secret={secret} /> : null}
      {error ? <span role="alert" className="issue-relations__error">{error}</span> : null}
    </li>
  );
}

const ANOMALY_HELP: Record<string, string> = {
  'no-identifier': 'No work reference: record it as evidence on the right item.',
  'unknown-identifier': 'The referenced item does not exist: find the real one and record the PR there.',
  'team-mismatch': 'The item belongs to another team: check the route or the reference.',
  'project-mismatch': 'The alias claims a project the item is not in.',
  'no-evidence': 'Merged but never recorded: attach the PR as evidence on the item.',
};

function TraceabilityAudit() {
  const [days, setDays] = useState(7);
  const [runAudit, { data, loading, error }] = useLazyQuery<TraceabilityAuditData, { days: number }>(TRACEABILITY_AUDIT_QUERY, {
    fetchPolicy: 'network-only',
  });
  const audit = data?.traceabilityAudit;

  return (
    <div>
      <div className="request-actions">
        <label>
          Merged in the last{' '}
          <input
            aria-label="Days to audit"
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(event) => setDays(Math.min(90, Math.max(1, Number(event.target.value) || 1)))}
          />{' '}
          days
        </label>
        <button type="button" className="ui-action ui-action--accent" disabled={loading} onClick={() => void runAudit({ variables: { days } })}>
          Run audit
        </button>
      </div>
      {error ? <p role="alert" className="issue-relations__error">{error.message}</p> : null}
      {audit ? (
        <>
          <p role="status">
            {audit.scannedPrCount} merged PRs in {audit.days} days · {audit.anomalies.length} to look at
          </p>
          {audit.repoErrors.map((repoError) => (
            <p key={repoError.repository} className="issue-relations__error">
              {repoError.repository} not scanned: {repoError.message}
            </p>
          ))}
          <ul className="work-context__timeline" aria-label="Traceability anomalies">
            {audit.anomalies.map((anomaly) => (
              <li key={`${anomaly.repository}#${anomaly.prNumber}-${anomaly.reason}`} className="observation-card">
                <span className="mono">{anomaly.reason}</span>
                <a href={anomaly.prUrl} target="_blank" rel="noreferrer">
                  {anomaly.repository}#{anomaly.prNumber}
                </a>
                <span>{anomaly.prTitle}</span>
                {anomaly.identifier ? <Link to={`/work/${anomaly.identifier}`}>{anomaly.identifier}</Link> : null}
                <span className="observation-card__meta">{ANOMALY_HELP[anomaly.reason] ?? ''}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
