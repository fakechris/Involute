import { DndContext } from '@dnd-kit/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Column } from './Column';

// INV-1516: a column whose items are on a later page says so instead of looking empty.
afterEach(() => cleanup());

function renderColumn(props: Partial<Parameters<typeof Column>[0]> = {}) {
  return render(
    <DndContext>
      <Column title="Canceled" stateId="state-canceled" issues={[]} {...props} />
    </DndContext>,
  );
}

it('keeps focus on the native column toggle when collapsing and expanding (INV-2117)', () => {
  function ToggleableColumn() {
    const [collapsed, setCollapsed] = useState(false);
    return <Column title="Canceled" stateId="state-canceled" issues={[]} collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)} />;
  }
  render(<DndContext><ToggleableColumn /></DndContext>);

  const toggle = screen.getByRole<HTMLButtonElement>('button', { name: 'Collapse Canceled column' });
  expect(toggle.tagName).toBe('BUTTON');
  expect(toggle.tabIndex).toBe(0);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  toggle.focus();
  fireEvent.click(toggle);

  expect(screen.getByRole('button', { name: 'Expand Canceled column' })).toBe(toggle);
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('No issues in Canceled yet.')).not.toBeInTheDocument();

  fireEvent.click(toggle);
  expect(screen.getByRole('button', { name: 'Collapse Canceled column' })).toHaveFocus();
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('No issues in Canceled yet.')).toBeInTheDocument();
});

describe('Column unloaded items (INV-1516)', () => {
  it('counts unloaded items in the header and offers Load more instead of "No issues"', () => {
    const onLoadMore = vi.fn();
    renderColumn({ unloadedCount: 3, onLoadMore });
    expect(screen.getByText('3')).toHaveAttribute('title', '0 loaded, 3 more not loaded yet');
    expect(screen.queryByText('No issues in Canceled yet.')).toBeNull();
    const note = screen.getByRole('note', { name: 'Canceled not loaded' });
    expect(note).toHaveTextContent('3 more not loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('shows the empty message only when nothing is waiting', () => {
    renderColumn();
    expect(screen.getByText('No issues in Canceled yet.')).toBeInTheDocument();
    expect(screen.queryByRole('note', { name: 'Canceled not loaded' })).toBeNull();
  });

  it('says it is loading while the next page comes in', () => {
    renderColumn({ unloadedCount: 2, loadingMore: true, onLoadMore: vi.fn() });
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
  });
});
