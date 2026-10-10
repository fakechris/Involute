import { useMutation } from '@apollo/client/react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { Btn } from '../components/Primitives';
import { allowedExtensionIds, type ExtensionConnectMessage } from '../extension/constants';
import { EXTENSION_TOKEN_CREATE_MUTATION, EXTENSION_TOKEN_REVOKE_MUTATION } from '../extension/queries';
import { fetchSessionState, type SessionViewer } from '../lib/session';

interface ChromeRuntime {
  sendMessage: (extensionId: string, message: unknown, callback: (response: unknown) => void) => void;
  lastError?: { message?: string };
}

function chromeRuntime(): ChromeRuntime | null {
  const runtime = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
  return runtime && typeof runtime.sendMessage === 'function' ? runtime : null;
}

/** Hand the token to the extension; resolves true only when it says it kept it. */
export function deliverToExtension(extensionId: string, message: ExtensionConnectMessage): Promise<boolean> {
  const runtime = chromeRuntime();
  if (!runtime) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      runtime.sendMessage(extensionId, message, (response) => {
        if (runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(Boolean(response && typeof response === 'object' && (response as { ok?: unknown }).ok === true));
      });
    } catch {
      resolve(false);
    }
  });
}

type Status = { kind: 'idle' } | { kind: 'working' } | { kind: 'connected' } | { kind: 'error'; message: string };

/**
 * /extension/connect (INV-1145): the signed-in person connects the Involute
 * Capture extension. The extension opens this page with its ID; only an
 * allowed ID receives a token, through Chrome's extension messaging (never
 * window.postMessage). A token the extension did not take is revoked at once.
 */
export function ExtensionConnectPage() {
  const [searchParams] = useSearchParams();
  const extensionId = searchParams.get('extension') ?? allowedExtensionIds()[0]!;
  const known = allowedExtensionIds().includes(extensionId);
  const [viewer, setViewer] = useState<SessionViewer | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [runCreate] = useMutation<{
    extensionTokenCreate: { success: boolean; message?: string | null; token: string | null; extensionToken: { id: string; expiresAt: string } | null };
  }>(EXTENSION_TOKEN_CREATE_MUTATION);
  const [runRevoke] = useMutation(EXTENSION_TOKEN_REVOKE_MUTATION);

  useEffect(() => {
    fetchSessionState().then((session) => setViewer(session.viewer)).catch(() => setViewer(null));
  }, []);

  async function connect() {
    if (!viewer) return;
    if (!chromeRuntime()) {
      setStatus({ kind: 'error', message: 'Open this page in Chrome with the Involute Capture extension installed.' });
      return;
    }
    setStatus({ kind: 'working' });
    try {
      const result = await runCreate({ variables: { name: 'Involute Capture' } });
      const created = result.data?.extensionTokenCreate;
      if (!created?.success || !created.token || !created.extensionToken) {
        setStatus({ kind: 'error', message: created?.message ?? 'The extension could not be connected.' });
        return;
      }
      const kept = await deliverToExtension(extensionId, {
        expiresAt: created.extensionToken.expiresAt,
        person: { email: viewer.email, id: viewer.id, name: viewer.name },
        server: window.location.origin,
        token: created.token,
        type: 'involute.connect',
      });
      if (!kept) {
        // Nobody holds it: do not leave a live token behind.
        await runRevoke({ variables: { id: created.extensionToken.id } }).catch(() => undefined);
        setStatus({ kind: 'error', message: 'The extension did not answer. Check that Involute Capture is installed and enabled, then try again.' });
        return;
      }
      setStatus({ kind: 'connected' });
    } catch {
      setStatus({ kind: 'error', message: 'The extension could not be connected.' });
    }
  }

  return (
    <div className="observation-page">
      <div className="page-header">
        <h1 className="page-header__title">Connect Involute Capture</h1>
      </div>
      <div className="page-content" style={{ maxWidth: 560 }}>
        {!known ? (
          <p className="issue-relations__error" role="alert">
            This page was opened by an extension Involute does not know ({extensionId}). Nothing will be sent to it.
          </p>
        ) : (
          <>
            <p>
              Involute Capture files bugs from any page with a screenshot and the page's context.
              Connecting gives it a token that can only report bugs as you, upload their screenshots
              and read where a bug can go. It expires in 90 days; disconnect it any time in{' '}
              <Link to="/settings?tab=extensions">Settings → Extensions</Link>.
            </p>
            {viewer ? <p className="observation-card__meta">Signed in as {viewer.name ?? viewer.email}</p> : null}
            {status.kind === 'connected' ? (
              <p role="status">Connected. You can close this tab and file bugs from the extension.</p>
            ) : (
              <Btn variant="accent" disabled={!viewer || status.kind === 'working'} onClick={() => void connect()}>
                {status.kind === 'working' ? 'Connecting…' : 'Connect extension'}
              </Btn>
            )}
            {status.kind === 'error' ? <p className="issue-relations__error" role="alert">{status.message}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
