import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
