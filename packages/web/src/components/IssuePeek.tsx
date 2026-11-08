import { useEffect } from 'react';

import type { PeekSaveRequest, PeekSession } from '../board/issue-peek-edit';
import {
  applyPeekSave,
  beginPeekEdit,
  cancelPeekEdit,
  changePeekText,
  discardPeekDraft,
  notePeekRevision,
  requestPeekReapply,
  requestPeekSave,
  setPeekFieldMessage,
} from '../board/issue-peek-edit';
import { Select, TextArea } from './controls';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Btn } from './Primitives';

export type PeekSaveResult = {
  ok: true;
  revision: number;
  description: string;
} | {
  ok: false;
  conflict: boolean;
  message: string;
  server: { description: string; revision: number } | null;
};

type PeekUpdate = PeekSession | ((current: PeekSession) => PeekSession);

interface PeekStateOption {
  id: string;
  name: string;
  type: string;
}

interface PeekUserOption {
  id: string;
  name?: string | null;
  email?: string | null;
}

export function IssuePeek({
  issue,
  parent,
  session,
  onSession,
  canWrite,
  ready,
  states,
  users,
  returnTo,
  asideNote,
  saveDescription,
  saveField,
  onFollow,
  onBack,
  onOpenAside,
  onClose,
}: {
  issue: {
    id: string;
    identifier: string;
    title: string;
    revision: number;
    description?: string | null;
    priority: number;
    state: { id: string; name: string; type: string };
    assignee: { id: string; name?: string | null } | null;
    labels: { nodes: Array<{ id: string; name: string }> };
  };
  parent: { id: string; identifier: string; title: string } | null;
  session: PeekSession;
  /** Called once per update. A function reads the latest session, including one a slow save has not rendered yet. */
  onSession: (update: PeekUpdate) => void;
  canWrite: boolean;
  /** False until this issue's description has arrived. An empty body is ready. */
  ready: boolean;
  states: PeekStateOption[];
  users: PeekUserOption[];
  returnTo: { identifier: string } | null;
  asideNote: string | null;
  saveDescription: (request: PeekSaveRequest) => Promise<PeekSaveResult>;
  saveField: (patch: { stateId?: string; assigneeId?: string | null }) => Promise<{ revision: number; description: string } | { message: string }>;
  onFollow: () => void;
  onBack: () => void;
  onOpenAside: () => void;
  onClose: () => void;
}) {
  const draft = session.drafts[issue.id] ?? null;
  // Closing the preview puts the keyboard focus and the scroll position back
  // where they were when it opened. Switching issues does not unmount this.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    return () => {
      window.scrollTo(scrollX, scrollY);
      previous?.focus();
    };
  }, []);

  async function commit(produce: (current: PeekSession) => { session: PeekSession; request: PeekSaveRequest | null }) {
    // The assignment happens inside the session update, which TypeScript does
    // not see, so the holder is read back as the full union.
    const pending: { request: PeekSaveRequest | null } = { request: null };
    onSession((current) => {
      const produced = produce(current);
      pending.request = produced.request;
      return produced.session;
    });
    const sent = pending.request as PeekSaveRequest | null;
    if (!sent) return;
    let result: PeekSaveResult;
    try {
      result = await saveDescription(sent);
    } catch (error) {
      result = { ok: false, conflict: false, message: error instanceof Error ? error.message : 'Could not save.', server: null };
    }
    onSession((current) => applyPeekSave(current, sent.issueId, sent.generation, result));
  }

  async function changeField(patch: { stateId?: string; assigneeId?: string | null }) {
    if (!canWrite || draft?.phase === 'saving') return;
    const result = await saveField(patch);
    if ('message' in result) {
      onSession((current) => setPeekFieldMessage(current, issue.id, result.message));
      return;
    }
    onSession((current) => notePeekRevision(current, issue.id, result.revision, result.description));
  }

  const phase = draft?.phase ?? 'idle';
  const editing = phase === 'editing' || phase === 'saving' || phase === 'error' || phase === 'conflict';
  const stateOptions = states.filter((state) => state.type !== 'CANCELED' || state.id === issue.state.id);
  const meta = [
    issue.state.name,
    issue.assignee?.name ?? 'Unassigned',
    ['No priority', 'Urgent', 'High', 'Medium', 'Low'][issue.priority] ?? '',
    ...issue.labels.nodes.map((label) => label.name),
  ].filter(Boolean).join(' · ');
  const body = draft?.text ?? issue.description ?? '';

  return (
    <aside className="issue-peek" role="dialog" aria-label={`Peek ${issue.identifier}`}>
      <div className="mono issue-peek__id">{issue.identifier}</div>
      <strong>{issue.title}</strong>
      <div className="issue-peek__meta">{meta}</div>
      <div className="issue-peek__fields">
        <label className="issue-peek__field">
          Status
          <Select
            className="issue-peek__select"
            size="sm"
            aria-label="Status"
            disabled={!canWrite || phase === 'saving'}
            value={issue.state.id}
            onChange={(event) => {
              if (event.target.value !== issue.state.id) void changeField({ stateId: event.target.value });
            }}
          >
            {stateOptions.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
          </Select>
        </label>
        <label className="issue-peek__field">
          Assignee
          <Select
            className="issue-peek__select"
            size="sm"
            aria-label="Assignee"
            disabled={!canWrite || phase === 'saving'}
            value={issue.assignee?.id ?? ''}
            onChange={(event) => {
              const assigneeId = event.target.value || null;
              if (assigneeId !== (issue.assignee?.id ?? null)) void changeField({ assigneeId });
            }}
          >
            <option value="">Unassigned</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name ?? user.email ?? user.id}</option>)}
          </Select>
        </label>
      </div>
      {draft?.fieldMessage ? <p className="issue-peek__note" role="alert">{draft.fieldMessage}</p> : null}
      {!canWrite ? <p className="issue-peek__note">Read only</p> : null}
      {draft?.kept && phase !== 'saving' ? <p className="issue-peek__note">Draft kept from before this preview was closed or switched.</p> : null}
      {asideNote ? <p className="issue-peek__note">{asideNote}</p> : null}
      {editing && draft ? (
        <>
          <TextArea
            className="issue-peek__input"
            size="sm"
            aria-label="Description"
            value={draft.text}
            disabled={phase === 'saving'}
            onChange={(event) => onSession((current) => changePeekText(current, event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
          />
          {phase === 'conflict' ? (
            <div className="issue-peek__conflict" role="alert">
              <p className="issue-peek__note">{draft.message ?? 'The server has a newer copy. Your draft is still here.'}</p>
              <p className="issue-peek__label">Server</p>
              <pre className="issue-peek__diff">{draft.serverText ?? 'The server text could not be loaded. Your draft is unchanged.'}</pre>
              <p className="issue-peek__label">Your draft</p>
              <pre className="issue-peek__diff">{draft.text}</pre>
              <div className="issue-peek__actions">
                <Btn variant="accent" disabled={draft.serverRevision == null} onClick={() => void commit(requestPeekReapply)}>Apply my draft</Btn>
                <Btn variant="ghost" disabled={draft.serverText == null} onClick={() => onSession(discardPeekDraft)}>Discard my draft</Btn>
              </div>
            </div>
          ) : (
            <div className="issue-peek__actions">
              <Btn variant="accent" loading={phase === 'saving'} disabled={!canWrite} onClick={() => void commit(requestPeekSave)}>Save</Btn>
              <Btn variant="ghost" disabled={phase === 'saving'} onClick={() => onSession(cancelPeekEdit)}>Cancel</Btn>
            </div>
          )}
          {phase === 'error' && draft.message ? <p className="issue-peek__note" role="alert">{draft.message} Your draft is still here.</p> : null}
        </>
      ) : (
        <>
          {draft?.phase === 'saved' ? <p className="issue-peek__note">Saved</p> : null}
          {ready ? (body ? <MarkdownRenderer content={body} clamp={12} size="sm" className="issue-peek__body" /> : null) : <p className="issue-peek__note">Loading description…</p>}
          {canWrite && ready ? <div className="issue-peek__actions"><Btn variant="subtle" onClick={() => onSession(beginPeekEdit)}>Edit description</Btn></div> : null}
        </>
      )}
      <div className="issue-peek__actions">
        {returnTo ? <Btn variant="ghost" onClick={onBack}>Back to {returnTo.identifier}</Btn> : null}
        {parent ? (
          <Btn variant="ghost" onClick={onFollow}>Parent {parent.identifier}</Btn>
        ) : null}
        <Btn variant="ghost" onClick={onOpenAside}>Open</Btn>
      </div>
      <div className="issue-peek__meta">Space or Esc to close · Enter to open</div>
    </aside>
  );
}
