import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DataTable, dataTableTemplate } from './DataTable';

afterEach(cleanup);

interface Person { id: string; name: string; role: string }

const columns = [
  { key: 'person', header: 'Person', render: (row: Person) => row.name },
  { key: 'role', header: 'Role', width: '110px', render: (row: Person) => row.role },
  { key: 'actions', header: '', align: 'end' as const, render: (row: Person) => <button type="button">Suspend {row.name}</button> },
];

describe('DataTable (INV-1313)', () => {
  it('builds the grid tracks from the column widths', () => {
    expect(dataTableTemplate(columns)).toBe('minmax(0, 1fr) 110px max-content');
  });

  it('renders a header row and one row per item with every cell in its column', () => {
    render(<DataTable label="Members" columns={columns} rows={[{ id: 'a', name: 'Ada', role: 'Admin' }, { id: 'b', name: 'Bo', role: 'Member' }]} rowKey={(row) => row.id} />);
    const table = screen.getByRole('table', { name: 'Members' });
    expect(table.style.getPropertyValue('--data-table-columns')).toBe('minmax(0, 1fr) 110px max-content');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Person', 'Role', '']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const cells = within(rows[1]!).getAllByRole('cell');
    expect(cells).toHaveLength(3);
    expect(cells[2]).toHaveClass('data-table__cell--end');
    expect(within(cells[2]!).getByRole('button', { name: 'Suspend Bo' })).toBeInTheDocument();
    expect(cells[0]).toHaveAttribute('data-label', 'Person');
  });

  it('shows the empty message when there are no rows', () => {
    render(<DataTable label="Labels" columns={columns} rows={[]} rowKey={(row) => row.id} empty="No labels yet." />);
    expect(screen.getByText('No labels yet.')).toBeInTheDocument();
  });
});
