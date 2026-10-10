import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Btn } from '../components/Primitives';
import { EXTENSION_TOKEN_REVOKE_MUTATION, EXTENSION_TOKENS_QUERY, type ExtensionTokenRow } from '../extension/queries';

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/** Settings → Extensions (INV-1145): your Involute Capture connections, and Disconnect. */
export function ExtensionsTab() {
  const { data, loading, refetch } = useQuery<{ extensionTokens: ExtensionTokenRow[] }>(EXTENSION_TOKENS_QUERY, { fetchPolicy: 'network-only' });
  const [runRevoke] = useMutation<{ extensionTokenRevoke: { success: boolean; message?: string | null } }>(EXTENSION_TOKEN_REVOKE_MUTATION);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  const rows = data?.extensionTokens ?? [];

  async function disconnect(id: string) {
    setError(null);
    const result = await runRevoke({ variables: { id } }).catch(() => null);
    if (!result?.data?.extensionTokenRevoke.success) {
      setError(result?.data?.extensionTokenRevoke.message ?? 'Could not disconnect. Try again.');
      return;
    }
    await refetch();
  }

  return (
    <section aria-label="Extensions">
      <h2>Involute Capture</h2>
      <p className="observation-card__meta">
        Browser extensions you connected to file bugs from any page. <Link to="/extension/connect">Connect another</Link>.
      </p>
      {loading && rows.length === 0 ? <p className="observation-empty">Loading…</p> : null}
      {!loading && rows.length === 0 ? <p className="observation-empty">No extension is connected.</p> : null}
      {rows.length > 0 ? (
        <table className="bugs-table">
          <thead>
            <tr><th>Name</th><th>Connected</th><th>Last used</th><th>Expires</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const live = !row.revokedAt && new Date(row.expiresAt).getTime() > now;
              return (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{when(row.createdAt)}</td>
                  <td>{when(row.lastUsedAt)}</td>
                  <td>{row.revokedAt ? 'Disconnected' : when(row.expiresAt)}</td>
                  <td>
                    {live ? (
                      <Btn variant="danger" onClick={() => void disconnect(row.id)}>Disconnect</Btn>
                    ) : (
                      <span className="observation-card__meta">{row.revokedAt ? 'Disconnected' : 'Expired'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {error ? <p className="issue-relations__error" role="alert">{error}</p> : null}
    </section>
  );
}
