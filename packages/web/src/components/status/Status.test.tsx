import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BulkActionBar, EmptyState, InlineError, LoadingState, SegmentedControl, StatRow, StatTile } from './Status';

afterEach(cleanup);

describe('state displays (INV-1314)', () => {
  it('EmptyState renders title, body and action; inline size is one dim line', () => {
    const { rerender } = render(<EmptyState title="No bugs" body="Nothing open." action={<button type="button">Report bug</button>} />);
    expect(screen.getByRole('heading', { name: 'No bugs' })).toBeInTheDocument();
    expect(screen.getByText('Nothing open.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
    rerender(<EmptyState size="inline" title="Nothing here" />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('Nothing here').closest('.empty-state')).toHaveClass('empty-state--inline');
  });

  it('LoadingState and InlineError announce themselves', () => {
    render(<><LoadingState>Loading bugs…</LoadingState><InlineError>Could not load</InlineError></>);
    expect(screen.getByText('Loading bugs…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
  });

  it('StatTile shows value and label, colours by tone, and links when given a target', () => {
    render(
      <MemoryRouter>
        <StatRow aria-label="Summary">
          <StatTile label="Open" value={3} />
          <StatTile label="Past SLA" value={1} tone="alert" to="/bugs?sla=breached" />
        </StatRow>
      </MemoryRouter>,
    );
    expect(screen.getByRole('group', { name: 'Summary' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Past SLA/ });
    expect(link).toHaveAttribute('href', '/bugs?sla=breached');
    expect(link).toHaveClass('stat-tile', 'stat-tile--alert');
  });

  it('SegmentedControl reports the picked value; buttons by default, tabs on request', () => {
    const onChange = vi.fn();
    const options = [{ value: 'list', label: 'List' }, { value: 'board', label: 'Board' }] as const;
    const { rerender } = render(<SegmentedControl aria-label="View" options={options} value="list" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(onChange).toHaveBeenCalledWith('board');
    rerender(<SegmentedControl aria-label="View" options={options} value="board" onChange={onChange} semantics="tabs" />);
    expect(screen.getByRole('tablist', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
  });

  it('BulkActionBar hides at zero and wires Select all / Clear / actions', () => {
    const onSelectAll = vi.fn();
    const onClear = vi.fn();
    const { rerender } = render(<BulkActionBar count={0} onClear={onClear} />);
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
    rerender(
      <BulkActionBar count={2} onSelectAll={onSelectAll} onClear={onClear} status="Done">
        <button type="button">Commit</button>
      </BulkActionBar>,
    );
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toHaveTextContent('2 selected');
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Commit' })).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});
