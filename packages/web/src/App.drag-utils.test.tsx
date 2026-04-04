import { fireEvent, screen } from '@testing-library/react';
import { MouseSensor, PointerSensor, TouchSensor, type DragEndEvent } from '@dnd-kit/core';
import { describe, expect, it, vi } from 'vitest';

import {
  boardQueryResult,
  dndMocks,
  renderApp,
  type IssueSummary,
} from './test/app-test-helpers';
import {
  createHtml5BoardDragPayload,
  DND_ACTIVATION_DISTANCE,
  getDropTargetStateId,
  kanbanCollisionDetection,
  moveIssueToState,
  parseHtml5DragPayload,
} from './routes/BoardPage';
import {
  getAuthToken,
  getAuthTokenDetails,
  getGraphqlUrl,
  getGraphqlUrlDetails,
} from './lib/apollo';

describe('App drag utils', () => {
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

  it('parses a valid html5 board drag payload', () => {
    expect(parseHtml5DragPayload(JSON.stringify({ issueId: 'issue-1', stateId: 'state-ready' }))).toEqual({
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
    expect(parseHtml5DragPayload('not-json')).toBeNull();
    expect(parseHtml5DragPayload(JSON.stringify({ issueId: 'issue-1' }))).toBeNull();
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

  it('uses the runtime API URL override from the query param without persisting it', () => {
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

  it('falls back safely when localStorage access throws in restricted contexts', () => {
    const originalGetItem = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new DOMException('Access denied', 'SecurityError');
    };

    try {
      expect(getAuthToken()).toBe('changeme-set-your-token');
      expect(getGraphqlUrl()).toBe('http://localhost:4200/graphql');
    } finally {
      window.localStorage.getItem = originalGetItem;
    }
  });

  it('ignores disallowed runtime API URL overrides from the query param', () => {
    window.history.replaceState({}, '', '/?involuteApiUrl=https%3A%2F%2Fevil.example%2Fgraphql');

    expect(getGraphqlUrl()).toBe('http://localhost:4200/graphql');
    expect(getGraphqlUrlDetails()).toEqual({
      url: 'http://localhost:4200/graphql',
      source: 'default',
    });
  });

  it('keeps the normal env/default API URL path when no runtime override is set', () => {
    expect(getGraphqlUrl()).toBe('http://localhost:4200/graphql');
    expect(getGraphqlUrlDetails()).toEqual({
      url: 'http://localhost:4200/graphql',
      source: 'default',
    });
  });

  it('registers PointerSensor, MouseSensor, and TouchSensor for drag-and-drop', () => {
    renderApp();

    const sensorTypes = (dndMocks.useSensor.mock.calls as unknown[][]).map(
      (call) => call[0],
    );

    expect(sensorTypes).toContain(PointerSensor);
    expect(sensorTypes).toContain(MouseSensor);
    expect(sensorTypes).toContain(TouchSensor);
    expect(dndMocks.useSensors).toHaveBeenCalled();
  });

  it('configures each sensor with a distance activation constraint', () => {
    renderApp();

    for (const call of dndMocks.useSensor.mock.calls as unknown as [unknown, Record<string, unknown>][]) {
      const options = call[1];
      expect(options).toHaveProperty('activationConstraint');
      expect((options.activationConstraint as { distance: number }).distance).toBe(DND_ACTIVATION_DISTANCE);
    }
  });

  it('prefers pointerWithin collisions for live kanban dragging', async () => {
    const core = await import('@dnd-kit/core');
    const args = {} as Parameters<typeof kanbanCollisionDetection>[0];
    const pointerMatch = [{ id: 'state-ready' }];
    const rectMatch = [{ id: 'state-progress' }];
    const closestMatch = [{ id: 'state-done' }];
    const pointerWithinSpy = vi.spyOn(core, 'pointerWithin');
    const rectIntersectionSpy = vi.spyOn(core, 'rectIntersection');
    const closestCornersSpy = vi.spyOn(core, 'closestCorners');

    pointerWithinSpy.mockReturnValue(pointerMatch as never);
    rectIntersectionSpy.mockReturnValue(rectMatch as never);
    closestCornersSpy.mockReturnValue(closestMatch as never);

    expect(kanbanCollisionDetection(args)).toEqual(pointerMatch);
    expect(pointerWithinSpy).toHaveBeenCalledWith(args);
    expect(rectIntersectionSpy).not.toHaveBeenCalled();
    expect(closestCornersSpy).not.toHaveBeenCalled();
  });

  it('falls back to rectIntersection before closestCorners when no pointer collision exists', async () => {
    const core = await import('@dnd-kit/core');
    const args = {} as Parameters<typeof kanbanCollisionDetection>[0];
    const rectMatch = [{ id: 'state-progress' }];
    const closestMatch = [{ id: 'state-done' }];
    const pointerWithinSpy = vi.spyOn(core, 'pointerWithin');
    const rectIntersectionSpy = vi.spyOn(core, 'rectIntersection');
    const closestCornersSpy = vi.spyOn(core, 'closestCorners');

    pointerWithinSpy.mockReturnValue([] as never);
    rectIntersectionSpy.mockReturnValue(rectMatch as never);
    closestCornersSpy.mockReturnValue(closestMatch as never);

    expect(kanbanCollisionDetection(args)).toEqual(rectMatch);
    expect(pointerWithinSpy).toHaveBeenCalledWith(args);
    expect(rectIntersectionSpy).toHaveBeenCalledWith(args);
    expect(closestCornersSpy).not.toHaveBeenCalled();
  });

  it('uses closestCorners as the final collision fallback', async () => {
    const core = await import('@dnd-kit/core');
    const args = {} as Parameters<typeof kanbanCollisionDetection>[0];
    const closestMatch = [{ id: 'state-done' }];
    const pointerWithinSpy = vi.spyOn(core, 'pointerWithin');
    const rectIntersectionSpy = vi.spyOn(core, 'rectIntersection');
    const closestCornersSpy = vi.spyOn(core, 'closestCorners');

    pointerWithinSpy.mockReturnValue([] as never);
    rectIntersectionSpy.mockReturnValue([] as never);
    closestCornersSpy.mockReturnValue(closestMatch as never);

    expect(kanbanCollisionDetection(args)).toEqual(closestMatch);
    expect(pointerWithinSpy).toHaveBeenCalledWith(args);
    expect(rectIntersectionSpy).toHaveBeenCalledWith(args);
    expect(closestCornersSpy).toHaveBeenCalledWith(args);
  });
});
