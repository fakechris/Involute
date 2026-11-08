/** Draft-safe peek editing (INV-271). Pure so a slow response cannot land on the wrong issue. */

export type PeekPhase = 'idle' | 'editing' | 'saving' | 'saved' | 'error' | 'conflict';

export interface PeekDraft {
  issueId: string;
  identifier: string;
  text: string;
  savedText: string;
  baseRevision: number;
  phase: PeekPhase;
  /** Each save attempt takes the next number. An older response is ignored. */
  generation: number;
  serverText: string | null;
  serverRevision: number | null;
  message: string | null;
  fieldMessage: string | null;
  /** The draft outlived a close or a switch and has not been saved. */
  kept: boolean;
}

export interface PeekReturn {
  id: string;
  identifier: string;
}

export interface PeekSession {
  openIssueId: string | null;
  returnStack: PeekReturn[];
  drafts: Record<string, PeekDraft>;
}

export interface PeekIssueSnap {
  id: string;
  identifier: string;
  description: string;
  revision: number;
}

export interface PeekSaveRequest {
  issueId: string;
  text: string;
  expectedRevision: number;
  generation: number;
}

export function emptyPeekSession(): PeekSession {
  return { openIssueId: null, returnStack: [], drafts: {} };
}

/**
 * The body the preview may edit. The board list often has no description yet
 * (INV-1470); a missing detail means "still loading", and an empty string means
 * the server has answered with no body. A newer revision wins. A field save can
 * move the board revision ahead of a detail response that did not change the body.
 */
export function peekSnap(
  issue: { id: string; identifier: string; description?: string | null; revision: number },
  detail: { description?: string | null; revision: number } | null,
): PeekIssueSnap | null {
  const boardHasBody = issue.description != null;
  if (!boardHasBody && !detail) return null;
  if (detail && detail.revision >= issue.revision) {
    return {
      id: issue.id,
      identifier: issue.identifier,
      description: detail.description ?? issue.description ?? '',
      revision: detail.revision,
    };
  }
  if (boardHasBody) {
    return { id: issue.id, identifier: issue.identifier, description: issue.description ?? '', revision: issue.revision };
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    description: detail?.description ?? '',
    revision: issue.revision,
  };
}

export function isPeekDirty(draft: PeekDraft): boolean {
  return draft.text !== draft.savedText || draft.phase === 'conflict' || draft.phase === 'saving' || draft.phase === 'error';
}

function put(session: PeekSession, draft: PeekDraft): PeekSession {
  return { ...session, drafts: { ...session.drafts, [draft.issueId]: draft } };
}

function fresh(issue: PeekIssueSnap): PeekDraft {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    text: issue.description,
    savedText: issue.description,
    baseRevision: issue.revision,
    phase: 'idle',
    generation: 0,
    serverText: null,
    serverRevision: null,
    message: null,
    fieldMessage: null,
    kept: false,
  };
}

/** A clean draft follows the server. A dirty one never does. */
function adopt(draft: PeekDraft, issue: PeekIssueSnap): PeekDraft {
  if (draft.phase === 'saving' || draft.phase === 'conflict' || draft.text !== draft.savedText || draft.phase === 'error') {
    return draft;
  }
  if (draft.savedText === issue.description && draft.baseRevision === issue.revision) return draft;
  return { ...draft, identifier: issue.identifier, text: issue.description, savedText: issue.description, baseRevision: issue.revision, phase: 'idle', message: null, kept: false };
}

function markKept(session: PeekSession, issueId: string | null): PeekSession {
  if (!issueId) return session;
  const draft = session.drafts[issueId];
  if (!draft || !isPeekDirty(draft)) return session;
  return put(session, { ...draft, kept: true });
}

export function openPeek(session: PeekSession, issue: PeekIssueSnap): PeekSession {
  const previous = session.openIssueId;
  const marked = previous && previous !== issue.id ? markKept(session, previous) : session;
  const existing = marked.drafts[issue.id];
  const draft = existing ? adopt(existing.identifier === issue.identifier ? existing : { ...existing, identifier: issue.identifier }, issue) : fresh(issue);
  if (marked === session && draft === existing && session.openIssueId === issue.id) return session;
  return { ...marked, openIssueId: issue.id, drafts: draft === existing ? marked.drafts : { ...marked.drafts, [issue.id]: draft } };
}

export function closePeek(session: PeekSession): PeekSession {
  if (!session.openIssueId) return session;
  const marked = markKept(session, session.openIssueId);
  return { ...marked, openIssueId: null };
}

export function beginPeekEdit(session: PeekSession): PeekSession {
  const id = session.openIssueId;
  const draft = id ? session.drafts[id] : null;
  if (!draft || draft.phase === 'saving') return session;
  return put(session, { ...draft, phase: 'editing', message: null, kept: false });
}

export function changePeekText(session: PeekSession, text: string): PeekSession {
  const id = session.openIssueId;
  const draft = id ? session.drafts[id] : null;
  if (!draft || (draft.phase !== 'editing' && draft.phase !== 'error')) return session;
  return put(session, { ...draft, text, phase: 'editing', message: null });
}

/** Explicit cancel. Restores the last saved text. Does not run while a save is in flight. */
export function cancelPeekEdit(session: PeekSession): PeekSession {
  const id = session.openIssueId;
  const draft = id ? session.drafts[id] : null;
  if (!draft || draft.phase === 'saving' || draft.phase === 'conflict') return session;
  return put(session, { ...draft, text: draft.savedText, phase: 'idle', message: null, serverText: null, serverRevision: null, kept: false });
}

export function requestPeekSave(session: PeekSession): { session: PeekSession; request: PeekSaveRequest | null } {
  const id = session.openIssueId;
  const draft = id ? session.drafts[id] : null;
  if (!draft || draft.phase === 'saving' || draft.phase === 'conflict') return { session, request: null };
  if (draft.text === draft.savedText) {
    return { session: put(session, { ...draft, phase: 'saved', message: null, kept: false }), request: null };
  }
  const generation = draft.generation + 1;
  const next = { ...draft, phase: 'saving' as const, generation, message: null };
  return {
    session: put(session, next),
    request: { issueId: draft.issueId, text: draft.text, expectedRevision: draft.baseRevision, generation },
  };
}

/**
 * The person chose to send their draft again, against the revision the server just reported.
 * This is a new save, not a retry of the refused one.
 */
export function requestPeekReapply(session: PeekSession): { session: PeekSession; request: PeekSaveRequest | null } {
  const id = session.openIssueId;
  const draft = id ? session.drafts[id] : null;
  if (!draft || draft.phase !== 'conflict' || draft.serverRevision == null) return { session, request: null };
  const generation = draft.generation + 1;
  const next = { ...draft, phase: 'saving' as const, generation, baseRevision: draft.serverRevision, message: null };
  return {
    session: put(session, next),
    request: { issueId: draft.issueId, text: draft.text, expectedRevision: draft.serverRevision, generation },
  };
}

export function discardPeekDraft(session: PeekSession): PeekSession {
  const id = session.openIssueId;
  const draft = id ? session.drafts[id] : null;
  if (!draft || draft.phase !== 'conflict' || draft.serverText == null || draft.serverRevision == null) return session;
  return put(session, {
    ...draft,
    text: draft.serverText,
    savedText: draft.serverText,
    baseRevision: draft.serverRevision,
    phase: 'idle',
    serverText: null,
    serverRevision: null,
    message: null,
    kept: false,
  });
}

export function applyPeekSave(
  session: PeekSession,
  issueId: string,
  generation: number,
  result:
    | { ok: true; revision: number; description: string }
    | { ok: false; conflict: boolean; message: string; server: { description: string; revision: number } | null },
): PeekSession {
  const draft = session.drafts[issueId];
  if (!draft || draft.generation !== generation) return session;
  if (result.ok) {
    return put(session, {
      ...draft,
      text: result.description,
      savedText: result.description,
      baseRevision: result.revision,
      phase: 'saved',
      serverText: null,
      serverRevision: null,
      message: null,
      kept: false,
    });
  }
  if (result.conflict) {
    return put(session, {
      ...draft,
      phase: 'conflict',
      message: result.message,
      serverText: result.server?.description ?? draft.serverText,
      serverRevision: result.server?.revision ?? draft.serverRevision,
      kept: false,
    });
  }
  return put(session, { ...draft, phase: 'error', message: result.message, kept: false });
}

/** A status or assignee write moved the revision and did not change the description. */
export function notePeekRevision(session: PeekSession, issueId: string, revision: number, serverText: string): PeekSession {
  const draft = session.drafts[issueId];
  if (!draft || draft.phase === 'saving') return session;
  if (serverText !== draft.savedText && draft.text !== draft.savedText) {
    return put(session, { ...draft, phase: 'conflict', serverText, serverRevision: revision, message: 'The server copy changed.', kept: false });
  }
  if (serverText !== draft.savedText) {
    return put(session, { ...draft, text: serverText, savedText: serverText, baseRevision: revision, phase: 'idle', message: null, fieldMessage: null });
  }
  return put(session, { ...draft, baseRevision: revision, fieldMessage: null });
}

export function setPeekFieldMessage(session: PeekSession, issueId: string, message: string): PeekSession {
  const draft = session.drafts[issueId];
  if (!draft) return session;
  return put(session, { ...draft, fieldMessage: message });
}

export function followPeekRelation(session: PeekSession, target: PeekIssueSnap): PeekSession {
  const currentId = session.openIssueId;
  const current = currentId ? session.drafts[currentId] : null;
  const marked = markKept(session, currentId);
  const stack = [...marked.returnStack];
  if (current && !stack.some((item) => item.id === current.issueId)) {
    stack.push({ id: current.issueId, identifier: current.identifier });
  }
  return openPeek({ ...marked, returnStack: stack }, target);
}

export function returnPeek(session: PeekSession): PeekSession {
  const stack = [...session.returnStack];
  const target = stack.pop();
  if (!target) return session;
  const existing = session.drafts[target.id];
  return openPeek(
    { ...session, returnStack: stack },
    {
      id: target.id,
      identifier: target.identifier,
      description: existing?.savedText ?? '',
      revision: existing?.baseRevision ?? 0,
    },
  );
}
