import { describe, expect, it } from 'vitest';

import { orderWorkflowStates } from './workflow-state-order.js';

function state(name: string, type: string, position = 0) {
  return { name, type, position };
}

describe('orderWorkflowStates', () => {
  it('orders by state group before name', () => {
    const ordered = orderWorkflowStates([
      state('Shipped', 'COMPLETED', 9),
      state('UAT', 'REVIEW', 0),
      state('In Development', 'STARTED', 3),
      state('Idea', 'BACKLOG', 0),
      state('Archived', 'CANCELED', 0),
    ]);

    expect(ordered.map((s) => s.name)).toEqual([
      'Idea',
      'In Development',
      'UAT',
      'Shipped',
      'Archived',
    ]);
  });

  it('orders by position then name inside the same group', () => {
    const ordered = orderWorkflowStates([
      state('Beta', 'STARTED', 2),
      state('Charlie', 'STARTED', 2),
      state('Alpha', 'STARTED', 1),
    ]);

    expect(ordered.map((s) => s.name)).toEqual(['Alpha', 'Beta', 'Charlie']);
  });

  it('keeps canonical state order stable', () => {
    const ordered = orderWorkflowStates([
      state('Done', 'COMPLETED', 4),
      state('In Review', 'REVIEW', 3),
      state('Backlog', 'BACKLOG', 0),
      state('Canceled', 'CANCELED', 5),
      state('In Progress', 'STARTED', 2),
      state('Ready', 'UNSTARTED', 1),
    ]);

    expect(ordered.map((s) => s.name)).toEqual([
      'Backlog',
      'Ready',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
    ]);
  });
});
