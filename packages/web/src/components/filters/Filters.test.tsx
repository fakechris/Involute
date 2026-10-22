import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilterChip, FilterMenu, FilterSearch, SavedViewControl, SortControl } from './Filters';

afterEach(cleanup);

describe('filter bar pieces (INV-1314)', () => {
  it('FilterMenu opens a checkbox popover, toggles values and closes on Escape', () => {
    const onToggle = vi.fn();
    render(
      <FilterMenu
        label="States"
        options={[{ value: 's1', label: 'Ready', count: 3 }, { value: 's2', label: 'Done' }]}
        selected={['s1']}
        onToggle={onToggle}
      />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByText('States'));
    expect(screen.getByRole('group', { name: 'States' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Ready/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(onToggle).toHaveBeenCalledWith('s2');
    fireEvent.keyDown(screen.getByRole('checkbox', { name: 'Done' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'States' })).toBeNull();
  });

  it('FilterMenu shows how many values are selected on its trigger', () => {
    render(<FilterMenu label="Labels" options={[]} selected={['a', 'b']} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /Labels/ })).toHaveTextContent('Labels2');
  });

  it('FilterChip removes itself under its accessible name', () => {
    const onRemove = vi.fn();
    render(<FilterChip removeLabel="Remove Label: Bug" onRemove={onRemove}>Label: Bug</FilterChip>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Label: Bug' }));
    expect(onRemove).toHaveBeenCalled();
  });

  it('FilterSearch clears on the first Escape', () => {
    const onChange = vi.fn();
    render(<FilterSearch aria-label="Search issues" value="abc" onChange={onChange} trailing={<span>all work</span>} />);
    expect(screen.getByText('all work')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Search issues'), { key: 'Escape' });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('SortControl and SavedViewControl forward changes', () => {
    const onSort = vi.fn();
    const onDirection = vi.fn();
    const onLoad = vi.fn();
    const onSave = vi.fn();
    const onClear = vi.fn();
    render(
      <>
        <SortControl
          sort={{ value: 'title', onChange: onSort, 'aria-label': 'Sort by', options: [{ value: 'title', label: 'Title' }, { value: 'id', label: 'ID' }] }}
          direction={{ value: 'asc', onChange: onDirection, 'aria-label': 'Sort direction' }}
        />
        <SavedViewControl aria-label="Saved view" views={[{ id: 'v1', name: 'Mine' }]} activeViewId="" onLoad={onLoad} onSave={onSave} onClear={onClear} />
      </>,
    );
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'id' } });
    fireEvent.change(screen.getByLabelText('Sort direction'), { target: { value: 'desc' } });
    fireEvent.change(screen.getByLabelText('Saved view'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSort).toHaveBeenCalledWith('id');
    expect(onDirection).toHaveBeenCalledWith('desc');
    expect(onLoad).toHaveBeenCalledWith('v1');
    expect(onSave).toHaveBeenCalled();
    expect(onClear).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Delete view' })).toBeNull();
  });
});
