import { DndContext } from '@dnd-kit/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KanbanView } from './KanbanView';

afterEach(() => cleanup());

const payload = JSON.stringify({ issueId: 'issue-1', stateId: 'state-ready' });

function dropOn(region: HTMLElement) {
  const body = region.querySelector('.kanban-column-body')!;
  fireEvent.drop(body, {
    dataTransfer: {
      types: ['application/x-involute-issue'],
      getData: (type: string) => (type === 'application/x-involute-issue' ? payload : ''),
    },
  });
}

describe('dropping a card on a group (INV-791)', () => {
  it('sets the priority when the board is grouped by priority', () => {
    const onPriority = vi.fn();
    const onState = vi.fn();
    render(
      <DndContext>
        <KanbanView
          groups={[{ id: 'priority-2', label: 'High', issues: [], meta: { priority: 2 } }]}
          focusedIssueId={null}
          selectedIssueIds={[]}
          onSelectIssue={vi.fn()}
          onToggleIssueSelection={vi.fn()}
          onInlineCreate={vi.fn()}
          onNativeDropIssue={onState}
          onNativeDropPriority={onPriority}
        />
      </DndContext>,
    );
    dropOn(screen.getByRole('region', { name: 'High column' }));
    expect(onPriority).toHaveBeenCalledWith({ issueId: 'issue-1', stateId: 'state-ready' }, 2);
    expect(onState).not.toHaveBeenCalled();
  });

  it('still moves the state when grouped by status', () => {
    const onPriority = vi.fn();
    const onState = vi.fn();
    render(
      <DndContext>
        <KanbanView
          groups={[{ id: 'state-done', label: 'Done', issues: [], meta: { stateId: 'state-done' } }]}
          focusedIssueId={null}
          selectedIssueIds={[]}
          onSelectIssue={vi.fn()}
          onToggleIssueSelection={vi.fn()}
          onInlineCreate={vi.fn()}
          onNativeDropIssue={onState}
          onNativeDropPriority={onPriority}
        />
      </DndContext>,
    );
    dropOn(screen.getByRole('region', { name: 'Done column' }));
    expect(onState).toHaveBeenCalledWith({ issueId: 'issue-1', stateId: 'state-ready' }, 'state-done');
    expect(onPriority).not.toHaveBeenCalled();
  });
});
