import { describe, expect, it } from 'vitest';

import {
  applyPeekSave,
  beginPeekEdit,
  cancelPeekEdit,
  changePeekText,
  closePeek,
  discardPeekDraft,
  emptyPeekSession,
  followPeekRelation,
  openPeek,
  peekSnap,
  requestPeekReapply,
  requestPeekSave,
  returnPeek,
  type PeekSession,
} from './issue-peek-edit';

const issueA = { id: 'a', identifier: 'INV-1', description: 'alpha', revision: 3 };
const issueB = { id: 'b', identifier: 'INV-2', description: 'beta', revision: 1 };

function editing(text: string, base: PeekSession = openPeek(emptyPeekSession(), issueA)): PeekSession {
  return changePeekText(beginPeekEdit(base), text);
}

describe('peekSnap', () => {
  it('waits until a body exists, then keeps the newer revision', () => {
    const issue = { id: 'a', identifier: 'INV-1', revision: 6 };
    expect(peekSnap(issue, null)).toBeNull();
    expect(peekSnap(issue, { description: 'from the server', revision: 5 })).toEqual({
      id: 'a',
      identifier: 'INV-1',
      description: 'from the server',
      revision: 6,
    });
    expect(peekSnap({ ...issue, description: 'on the card' }, { description: 'newer', revision: 7 })).toMatchObject({
      description: 'newer',
      revision: 7,
    });
  });
});

describe('peek draft state machine', () => {
  it('ignores a slow save after the preview has moved to another issue', () => {
    const started = requestPeekSave(editing('from A'));
    const switched = openPeek(started.session, issueB);
    const late = applyPeekSave(switched, 'a', started.request!.generation, { ok: true, revision: 4, description: 'from A' });

    expect(late.openIssueId).toBe('b');
    expect(late.drafts.b?.text).toBe('beta');
    expect(late.drafts.a?.savedText).toBe('from A');
    expect(late.drafts.a?.baseRevision).toBe(4);
    expect(late.drafts.a?.kept).toBe(false);
  });

  it('drops a stale response once a newer save has been asked for', () => {
    const first = requestPeekSave(editing('one'));
    const edited = changePeekText({ ...first.session, drafts: { ...first.session.drafts, a: { ...first.session.drafts.a!, phase: 'error' } } }, 'two');
    const second = requestPeekSave(edited);
    const stale = applyPeekSave(second.session, 'a', first.request!.generation, { ok: true, revision: 4, description: 'one' });

    expect(stale.drafts.a?.phase).toBe('saving');
    expect(stale.drafts.a?.text).toBe('two');
    expect(stale.drafts.a?.generation).toBe(second.request!.generation);
  });

  it('keeps the local draft on a conflict and does not save again until asked', () => {
    const started = requestPeekSave(editing('mine'));
    const conflict = applyPeekSave(started.session, 'a', started.request!.generation, {
      ok: false,
      conflict: true,
      message: 'Work revision does not match expected_revision.',
      server: { description: 'theirs', revision: 8 },
    });

    expect(conflict.drafts.a?.phase).toBe('conflict');
    expect(conflict.drafts.a?.text).toBe('mine');
    expect(conflict.drafts.a?.serverText).toBe('theirs');
    expect(conflict.drafts.a?.kept).toBe(false);
    expect(requestPeekSave(conflict).request).toBeNull();

    const again = requestPeekReapply(conflict);
    expect(again.request).toEqual({ issueId: 'a', text: 'mine', expectedRevision: 8, generation: 2 });
  });

  it('keeps the typed text when the network fails', () => {
    const started = requestPeekSave(editing('still here'));
    const failed = applyPeekSave(started.session, 'a', started.request!.generation, {
      ok: false,
      conflict: false,
      message: 'Failed to fetch',
      server: null,
    });

    expect(failed.drafts.a?.phase).toBe('error');
    expect(failed.drafts.a?.text).toBe('still here');
    expect(failed.drafts.a?.kept).toBe(false);
  });

  it('keeps a dirty draft across close and reopen, and cancel restores the saved text', () => {
    const dirty = editing('unsaved');
    const closed = closePeek(dirty);
    expect(closed.openIssueId).toBeNull();
    expect(closed.drafts.a?.kept).toBe(true);
    expect(closed.drafts.a?.text).toBe('unsaved');

    const reopened = openPeek(closed, issueA);
    expect(reopened.drafts.a?.text).toBe('unsaved');
    expect(reopened.drafts.a?.kept).toBe(true);

    const canceled = cancelPeekEdit(changePeekText(beginPeekEdit(openPeek(emptyPeekSession(), issueA)), 'gone'));
    expect(canceled.drafts.a?.text).toBe('alpha');
    expect(canceled.drafts.a?.phase).toBe('idle');
  });

  it('two windows: the second save conflicts, then discard takes the server text', () => {
    const left = requestPeekSave(editing('left'));
    const leftSaved = applyPeekSave(left.session, 'a', left.request!.generation, { ok: true, revision: 4, description: 'left' });
    const right = requestPeekSave(editing('right'));
    const conflict = applyPeekSave(right.session, 'a', right.request!.generation, {
      ok: false,
      conflict: true,
      message: 'Work revision does not match expected_revision.',
      server: { description: leftSaved.drafts.a!.savedText, revision: 4 },
    });

    expect(conflict.drafts.a?.text).toBe('right');
    expect(conflict.drafts.a?.serverText).toBe('left');
    expect(discardPeekDraft(conflict).drafts.a).toMatchObject({ text: 'left', savedText: 'left', baseRevision: 4, phase: 'idle' });
  });

  it('follows a relation and returns to the draft that was left behind', () => {
    const dirty = editing('hold');
    const followed = followPeekRelation(dirty, issueB);
    expect(followed.openIssueId).toBe('b');
    expect(followed.drafts.a?.kept).toBe(true);
    expect(followed.returnStack).toEqual([{ id: 'a', identifier: 'INV-1' }]);

    const back = returnPeek(followed);
    expect(back.openIssueId).toBe('a');
    expect(back.drafts.a?.text).toBe('hold');
    expect(back.returnStack).toEqual([]);
  });
});
