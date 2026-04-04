import { beforeEach, describe, expect, it } from 'vitest';
import type { DragEndEvent } from '@dnd-kit/core';

import { boardQueryResult, getIssue } from './test/app-test-helpers';
import { getAuthToken, getAuthTokenDetails, getGraphqlUrl, getGraphqlUrlDetails } from './lib/apollo';
import {
  getDropTargetStateId,
  mergeIssueWithPreservedComments,
  moveIssueToState,
} from './routes/BoardPage';
import { createHtml5BoardDragPayload, parseHtml5BoardDragPayload } from './board/utils';
import type { IssueSummary } from './board/types';

describe('App drag helpers', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('resolves a drag-end drop target from the destination card column state', () => {
    const event = {
      active: { id: 'issue-1' },
      over: {
        id: 'issue-2',
        data: {
          current: {
            issue: boardQueryResult.issues.nodes[1],
            stateId: 'state-ready',
            type: 'issue-card',
          },
        },
      },
    } as unknown as DragEndEvent;

    expect(getDropTargetStateId(event)).toBe('state-ready');
  });

  it('falls back to the droppable column id when drag-end lands on a column body', () => {
    const event = {
      active: { id: 'issue-1' },
      over: {
        id: 'state-progress',
        data: {
          current: {
            stateId: 'state-progress',
            title: 'In Progress',
            type: 'column',
          },
        },
      },
    } as unknown as DragEndEvent;

    expect(getDropTargetStateId(event)).toBe('state-progress');
  });

  it('resolves a drag-over drop target from the hovered destination card state', () => {
    const event = {
      over: {
        id: 'issue-2',
        data: {
          current: {
            issue: boardQueryResult.issues.nodes[1],
            stateId: 'state-ready',
            type: 'issue-card',
          },
        },
      },
    } as unknown as Pick<DragEndEvent, 'over'>;

    expect(getDropTargetStateId(event)).toBe('state-ready');
  });

  it('moves an issue into the destination state during cross-column drag preview', () => {
    const nextState = { id: 'state-ready', name: 'Ready' };
    const movedIssues = moveIssueToState(boardQueryResult.issues.nodes as IssueSummary[], 'issue-1', nextState);

    expect(movedIssues.find((issue) => issue.id === 'issue-1')?.state).toEqual(nextState);
    expect(movedIssues.find((issue) => issue.id === 'issue-2')?.state).toEqual(
      boardQueryResult.issues.nodes[1]?.state,
    );
  });

  it('shows moved issue data in the destination column grouping after a cross-column preview move', () => {
    const movedIssues = moveIssueToState(
      boardQueryResult.issues.nodes as IssueSummary[],
      'issue-1',
      { id: 'state-ready', name: 'Ready' },
    );

    const groupedIssues = movedIssues.reduce<Record<string, string[]>>((groups, issue) => {
      const key = issue.state.name;
      groups[key] = [...(groups[key] ?? []), issue.identifier];
      return groups;
    }, {});

    expect(groupedIssues.Ready).toContain('INV-1');
    expect(groupedIssues.Backlog ?? []).not.toContain('INV-1');
  });

  it('parses a valid html5 board drag payload', () => {
    expect(parseHtml5BoardDragPayload(JSON.stringify({ issueId: 'issue-1', stateId: 'state-ready' }))).toEqual({
      issueId: 'issue-1',
      stateId: 'state-ready',
    });
  });

  it('creates a stable html5 board drag payload string', () => {
    expect(createHtml5BoardDragPayload('issue-1', 'state-ready')).toBe(
      '{"issueId":"issue-1","stateId":"state-ready"}',
    );
  });

  it('rejects malformed html5 board drag payloads', () => {
    expect(parseHtml5BoardDragPayload('not-json')).toBeNull();
    expect(parseHtml5BoardDragPayload(JSON.stringify({ issueId: 'issue-1' }))).toBeNull();
  });

  it('prefers the runtime localStorage auth token when creating Apollo requests', () => {
    window.localStorage.setItem('involute.authToken', 'runtime-token');
    expect(getAuthToken()).toBe('runtime-token');
    expect(getAuthTokenDetails()).toEqual({
      token: 'runtime-token',
      source: 'localStorage',
    });
  });

  it('falls back to the default dev auth token when no runtime token is configured', () => {
    expect(getAuthToken()).toBe('changeme-set-your-token');
    expect(getAuthTokenDetails()).toEqual({
      token: 'changeme-set-your-token',
      source: 'dev-default',
    });
  });

  it('uses the runtime API URL override from the query param and persists it for the browser session', () => {
    window.history.replaceState({}, '', '/?involuteApiUrl=http%3A%2F%2F127.0.0.1%3A9%2Fgraphql');

    expect(getGraphqlUrl()).toBe('http://127.0.0.1:9/graphql');
    expect(getGraphqlUrlDetails()).toEqual({
      url: 'http://127.0.0.1:9/graphql',
      source: 'query-param',
    });
    expect(window.localStorage.getItem('involute.graphqlUrl')).toBeNull();
  });

  it('uses the runtime API URL override from localStorage when present', () => {
    window.localStorage.setItem('involute.graphqlUrl', 'http://127.0.0.1:19/graphql');

    expect(getGraphqlUrl()).toBe('http://127.0.0.1:19/graphql');
    expect(getGraphqlUrlDetails()).toEqual({
      url: 'http://127.0.0.1:19/graphql',
      source: 'localStorage',
    });
  });

  it('keeps the normal env/default API URL path when no runtime override is set', () => {
    expect(getGraphqlUrl()).toBe('http://localhost:4200/graphql');
    expect(getGraphqlUrlDetails()).toEqual({
      url: 'http://localhost:4200/graphql',
      source: 'default',
    });
  });

  it('mergeIssueWithPreservedComments handles undefined comments gracefully', () => {
    const previousIssue: IssueSummary = {
      ...getIssue('issue-1'),
      comments: {
        nodes: [
          {
            id: 'comment-1',
            body: 'Previous comment',
            createdAt: '2026-04-02T10:00:00.000Z',
            user: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
          },
        ],
      },
    };
    const nextIssue = {
      ...getIssue('issue-1'),
      title: 'Updated title',
    } as IssueSummary;
    delete (nextIssue as unknown as Record<string, unknown>).comments;

    const merged = mergeIssueWithPreservedComments(previousIssue, nextIssue);
    expect(merged.comments.nodes).toHaveLength(1);
    expect(merged.comments.nodes[0]!.body).toBe('Previous comment');
    expect(merged.title).toBe('Updated title');
  });

  it('mergeIssueWithPreservedComments handles undefined children gracefully', () => {
    const previousIssue: IssueSummary = {
      ...getIssue('issue-1'),
      children: {
        nodes: [{ id: 'child-1', identifier: 'INV-10', title: 'Child issue' }],
      },
    };
    const nextIssue = {
      ...getIssue('issue-1'),
      title: 'Updated title',
    } as IssueSummary;
    delete (nextIssue as unknown as Record<string, unknown>).children;

    const merged = mergeIssueWithPreservedComments(previousIssue, nextIssue);
    expect(merged.children.nodes).toHaveLength(1);
    expect(merged.children.nodes[0]!.identifier).toBe('INV-10');
  });
});
