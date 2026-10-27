import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

import { ProjectFilterCombobox, type AvailableProject } from './ProjectFilterCombobox';

const mockProjects: AvailableProject[] = [
  { id: 'proj-1', identifier: 'INV-2', name: 'fakechris/Involute', key: 'INV-2', issueCount: 42 },
  { id: 'proj-2', identifier: 'INV-5', name: 'fakechris/lumenbox', key: 'INV-5', issueCount: 15 },
  { id: 'proj-3', identifier: 'INV-9', name: 'fakechris/orchestrator', key: 'INV-9', issueCount: 7 },
];

describe('ProjectFilterCombobox', () => {
  it('renders default All Projects state when no project is selected', () => {
    render(
      <ProjectFilterCombobox
        projects={mockProjects}
        selectedProjectKey={null}
        totalCount={64}
        onSelectProject={vi.fn()}
      />,
    );

    expect(screen.getByText('Project:')).toBeInTheDocument();
    expect(screen.getByText('All Projects')).toBeInTheDocument();
    expect(screen.getByText('64')).toBeInTheDocument();
  });

  it('renders active project identifier and name with clear button when selected', () => {
    const onSelect = vi.fn();
    render(
      <ProjectFilterCombobox
        projects={mockProjects}
        selectedProjectKey="fakechris/Involute"
        totalCount={64}
        onSelectProject={onSelect}
      />,
    );

    expect(screen.getByText('INV-2')).toBeInTheDocument();
    expect(screen.getByText('fakechris/Involute')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();

    const clearBtn = screen.getByLabelText('Clear project filter');
    expect(clearBtn).toBeInTheDocument();
    fireEvent.click(clearBtn);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('opens popover on trigger click, filters by typing, and selects on click', () => {
    const onSelect = vi.fn();
    render(
      <ProjectFilterCombobox
        projects={mockProjects}
        selectedProjectKey={null}
        totalCount={64}
        onSelectProject={onSelect}
      />,
    );

    const trigger = screen.getByRole('button', { name: /filter by project/i });
    fireEvent.click(trigger);

    // Popover is open
    expect(screen.getByPlaceholderText('Filter projects...')).toBeInTheDocument();

    // Type "lumen"
    const input = screen.getByPlaceholderText('Filter projects...');
    fireEvent.change(input, { target: { value: 'lumen' } });

    expect(screen.getByText('fakechris/lumenbox')).toBeInTheDocument();
    expect(screen.queryByText('fakechris/Involute')).not.toBeInTheDocument();

    // Click lumenbox
    fireEvent.click(screen.getByText('fakechris/lumenbox'));
    expect(onSelect).toHaveBeenCalledWith('fakechris/lumenbox');
  });

  it('navigates options via keyboard ArrowDown, ArrowUp and selects with Enter', () => {
    const onSelect = vi.fn();
    render(
      <ProjectFilterCombobox
        projects={mockProjects}
        selectedProjectKey={null}
        totalCount={64}
        onSelectProject={onSelect}
      />,
    );

    const trigger = screen.getByRole('button', { name: /filter by project/i });
    fireEvent.click(trigger);

    const input = screen.getByPlaceholderText('Filter projects...');
    // ArrowDown moves from 0 ("All Projects") to 1 ("fakechris/Involute")
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('fakechris/Involute');
  });

  it('handles two-stage Escape: first clears search input, second closes popover', () => {
    render(
      <ProjectFilterCombobox
        projects={mockProjects}
        selectedProjectKey={null}
        totalCount={64}
        onSelectProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /filter by project/i }));
    const input = screen.getByPlaceholderText('Filter projects...');

    // Type query
    fireEvent.change(input, { target: { value: 'inv' } });
    expect((input as HTMLInputElement).value).toBe('inv');

    // First Escape clears input
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByPlaceholderText('Filter projects...')).toBeInTheDocument();

    // Second Escape closes popover
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Filter projects...')).not.toBeInTheDocument();
  });
});

describe('ProjectFilterCombobox quick pills (INV-1386)', () => {
  const many: AvailableProject[] = [
    { id: 'p1', identifier: 'INV-1', name: 'fakechris/alpha', key: 'INV-1', issueCount: 10 },
    { id: 'p2', identifier: 'INV-2', name: 'fakechris/bravo', key: 'INV-2', issueCount: 60 },
    { id: 'p3', identifier: 'INV-3', name: 'fakechris/charlie', key: 'INV-3', issueCount: 30 },
    { id: 'p4', identifier: 'INV-4', name: 'fakechris/delta', key: 'INV-4', issueCount: 50 },
    { id: 'p5', identifier: 'INV-5', name: 'fakechris/echo', key: 'INV-5', issueCount: 40 },
    { id: 'p6', identifier: 'INV-6', name: 'fakechris/foxtrot', key: 'INV-6', issueCount: 20 },
    { id: 'p7', identifier: 'INV-7', name: 'fakechris/golf-with-a-very-long-repository-name', key: 'INV-7', issueCount: 1 },
  ];
  const busiest = ['fakechris/bravo', 'fakechris/delta', 'fakechris/echo', 'fakechris/charlie', 'fakechris/foxtrot'];

  afterEach(() => {
    window.localStorage.clear();
  });

  function pillNames() {
    const group = screen.getByRole('group', { name: 'Quick project filters' });
    return within(group)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
  }

  it('shows All projects plus the five busiest projects when nothing was used yet', () => {
    render(<ProjectFilterCombobox projects={many} selectedProjectKey={null} onSelectProject={vi.fn()} showQuickPills teamKey="INV" />);
    expect(pillNames()).toEqual(['All projects', ...busiest]);
    // The pill shows the name after owner/; the full name stays the accessible name.
    expect(screen.getByRole('button', { name: 'fakechris/bravo' })).toHaveTextContent('bravo60');
    expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('pins projects picked from the dropdown, newest first, and keeps teams apart', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<ProjectFilterCombobox projects={many} selectedProjectKey={null} onSelectProject={onSelect} showQuickPills teamKey="INV" />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter by project' }));
    fireEvent.click(screen.getByRole('option', { name: /golf-with/ }));
    expect(onSelect).toHaveBeenLastCalledWith('fakechris/golf-with-a-very-long-repository-name');
    fireEvent.click(screen.getByRole('button', { name: 'Filter by project' }));
    fireEvent.click(screen.getByRole('option', { name: /alpha/ }));
    expect(pillNames()).toEqual([
      'All projects',
      'fakechris/alpha',
      'fakechris/golf-with-a-very-long-repository-name',
      'fakechris/bravo',
      'fakechris/delta',
      'fakechris/echo',
    ]);

    rerender(<ProjectFilterCombobox projects={many} selectedProjectKey={null} onSelectProject={onSelect} showQuickPills teamKey="OPS" />);
    expect(pillNames()).toEqual(['All projects', ...busiest]);
    rerender(<ProjectFilterCombobox projects={many} selectedProjectKey={null} onSelectProject={onSelect} showQuickPills teamKey="INV" />);
    expect(pillNames()[1]).toBe('fakechris/alpha');
  });

  it('reads the active team from storage when no team is passed', () => {
    window.localStorage.setItem('involute.activeTeamKey', 'OPS');
    window.localStorage.setItem('involute.projectRecents.OPS', JSON.stringify(['fakechris/alpha']));
    render(<ProjectFilterCombobox projects={many} selectedProjectKey={null} onSelectProject={vi.fn()} showQuickPills />);
    expect(pillNames().slice(0, 3)).toEqual(['All projects', 'fakechris/alpha', 'fakechris/bravo']);
  });

  it('moves a clicked pill to the front of the recents', () => {
    const onSelect = vi.fn();
    render(<ProjectFilterCombobox projects={many} selectedProjectKey={null} onSelectProject={onSelect} showQuickPills teamKey="INV" />);
    fireEvent.click(screen.getByRole('button', { name: 'fakechris/foxtrot' }));
    expect(onSelect).toHaveBeenCalledWith('fakechris/foxtrot');
    expect(pillNames()[1]).toBe('fakechris/foxtrot');
  });

  it('adds the selected project as a highlighted pill when it is not pinned', () => {
    render(<ProjectFilterCombobox projects={many} selectedProjectKey="fakechris/alpha" onSelectProject={vi.fn()} showQuickPills teamKey="INV" />);
    expect(pillNames()).toEqual(['All projects', ...busiest, 'fakechris/alpha']);
    expect(screen.getByRole('button', { name: 'fakechris/alpha' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps extra scopes such as No repository in the dropdown only', () => {
    const onSelect = vi.fn();
    render(
      <ProjectFilterCombobox
        projects={many}
        selectedProjectKey={null}
        onSelectProject={onSelect}
        showQuickPills
        teamKey="INV"
        extraOptions={[{ key: '__none__', label: 'No repository', count: 3 }]}
      />,
    );
    expect(pillNames()).not.toContain('No repository');
    fireEvent.click(screen.getByRole('button', { name: 'Filter by project' }));
    fireEvent.click(screen.getByRole('option', { name: /No repository/ }));
    expect(onSelect).toHaveBeenCalledWith('__none__');
    expect(window.localStorage.getItem('involute.projectRecents.INV')).toBeNull();
  });

  it('All projects clears the filter', () => {
    const onSelect = vi.fn();
    render(<ProjectFilterCombobox projects={many} selectedProjectKey="fakechris/bravo" onSelectProject={onSelect} showQuickPills teamKey="INV" />);
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
