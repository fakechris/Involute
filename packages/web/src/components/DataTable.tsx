import type { CSSProperties, ReactNode } from 'react';

export interface DataTableColumn<Row> {
  key: string;
  header: ReactNode;
  /**
   * A `grid-template-columns` track: `1fr`, `220px`, `minmax(0, 2fr)`…
   * Defaults to `minmax(0, 1fr)`, or `max-content` for an end-aligned column.
   */
  width?: string | undefined;
  align?: 'start' | 'end' | undefined;
  render: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  columns: Array<DataTableColumn<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Accessible name of the table. */
  label: string;
  /** Shown in place of rows when there are none. */
  empty?: ReactNode | undefined;
  rowClassName?: (row: Row) => string | undefined;
  className?: string | undefined;
}

export function dataTableTemplate(columns: Array<Pick<DataTableColumn<unknown>, 'width' | 'align'>>): string {
  return columns.map((column) => column.width ?? (column.align === 'end' ? 'max-content' : 'minmax(0, 1fr)')).join(' ');
}

/**
 * A table on one CSS grid (docs/design-system.md §3.6): explicit column tracks,
 * a sunken header row, hairline rows and an end-aligned actions column; every
 * row is a subgrid, so `max-content` columns line up across rows. At ≤720px
 * each row stacks its cells, labelled with their header.
 */
export function DataTable<Row>({ columns, rows, rowKey, label, empty, rowClassName, className }: DataTableProps<Row>) {
  const style = { '--data-table-columns': dataTableTemplate(columns) } as CSSProperties;
  const cellClass = (column: DataTableColumn<Row>) =>
    ['data-table__cell', column.align === 'end' ? 'data-table__cell--end' : null].filter(Boolean).join(' ');

  return (
    <div className={['data-table', className].filter(Boolean).join(' ')} role="table" aria-label={label} style={style}>
      <div className="data-table__row data-table__row--head" role="row">
        {columns.map((column) => (
          <div key={column.key} className={cellClass(column)} role="columnheader">
            {column.header}
          </div>
        ))}
      </div>
      {rows.length === 0 && empty ? (
        <div className="data-table__empty" role="row">
          <div role="cell">{empty}</div>
        </div>
      ) : null}
      {rows.map((row) => (
        <div key={rowKey(row)} className={['data-table__row', rowClassName?.(row)].filter(Boolean).join(' ')} role="row">
          {columns.map((column) => (
            <div
              key={column.key}
              className={cellClass(column)}
              role="cell"
              data-label={typeof column.header === 'string' && column.header ? column.header : undefined}
            >
              {column.render(row)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
