import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkStructureEditor } from './WorkStructureEditor';

type StructuredWork = Parameters<typeof WorkStructureEditor>[0]['work'];

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((document: { loc?: { source?: { body?: string } } }, options?: { skip?: boolean; variables?: { repository?: string } }) => {
    const body = document.loc?.source?.body ?? '';
    if (body.includes('query GraphProjects')) {
      return {
        data: {
          projectSummary: {
            totalCount: 2,
            projects: [
              { repository: 'acme/app', name: 'App', identifier: 'INV-10', totalCount: 3 },
              { repository: 'acme/other', name: 'Other', identifier: 'INV-20', totalCount: 1 },
            ],
          },
        },
        loading: false,
      };
    }
    if (body.includes('query PlacementOptions') && !options?.skip) {
      const repo = options?.variables?.repository;
      return {
        data: {
          projects: { nodes: [] },
          milestones: {
            nodes: repo === 'acme/app'
              ? [
                  { id: 'm-1', identifier: 'INV-11', title: 'M1', kind: 'MILESTONE', state: { type: 'STARTED' } },
                  { id: 'm-done', identifier: 'INV-12', title: 'Old', kind: 'MILESTONE', state: { type: 'COMPLETED' } },
                ]
              : [],
          },
          epics: { nodes: repo === 'acme/app' ? [{ id: 'e-1', identifier: 'INV-13', title: 'Search', kind: 'EPIC', state: { type: 'UNSTARTED' } }] : [] },
        },
        loading: false,
      };
    }
    return { data: undefined, loading: false };
  }),
}));

afterEach(() => cleanup());

const issue: StructuredWork = {
  id: 'w-1',
  kind: 'ISSUE',
  priority: 0,
  repository: 'acme/app',
  parent: { id: 'p-10', identifier: 'INV-10', title: 'acme/app', kind: 'PROJECT' },
};

function renderEditor(work: StructuredWork = issue) {
  const onUpdate = vi.fn();
  render(
    <MemoryRouter>
      <WorkStructureEditor work={work} onUpdate={onUpdate} />
    </MemoryRouter>,
  );
  return onUpdate;
}

describe('structure editing of committed work (INV-791)', () => {
  it('moves the work to a milestone, and across projects with its repository', () => {
    const onUpdate = renderEditor();
    const location = screen.getByLabelText('Location') as HTMLSelectElement;
    expect(location.value).toBe('INV-10');
    expect(within(location).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'No milestone',
      'INV-11 — M1',
      'Epic · INV-13 — Search',
    ]);
    fireEvent.change(location, { target: { value: 'm-1' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ parentId: 'm-1' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'acme/other' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ parentId: 'INV-20', repository: 'acme/other' });
  });

  it('changes priority and kind', () => {
    const onUpdate = renderEditor();
    fireEvent.change(screen.getByLabelText('Issue priority'), { target: { value: '2' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ priority: 2 });
    fireEvent.change(screen.getByLabelText('Issue kind'), { target: { value: 'EPIC' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ kind: 'EPIC' });
  });

  it('sets and clears severity, apart from priority (INV-1115)', () => {
    const onUpdate = renderEditor({ ...issue, severity: 'SEV2' });
    const severity = screen.getByLabelText('Issue severity') as HTMLSelectElement;
    expect(severity.value).toBe('SEV2');
    expect(within(severity).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'No severity',
      'SEV1 Critical',
      'SEV2 Major',
      'SEV3 Minor',
    ]);
    fireEvent.change(severity, { target: { value: 'SEV1' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ severity: 'SEV1' });
    fireEvent.change(severity, { target: { value: '' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ severity: null });
  });

  it('offers only legal parents for the kind', () => {
    renderEditor({ ...issue, kind: 'EPIC' });
    expect(within(screen.getByLabelText('Location')).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'No milestone',
      'INV-11 — M1',
    ]);
    cleanup();
    renderEditor({ ...issue, kind: 'DECISION' });
    expect(within(screen.getByLabelText('Location')).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Directly in the project',
    ]);
  });

  it('shows a finished milestone as the current place and never moves the work by itself', () => {
    const onUpdate = renderEditor({ ...issue, parent: { id: 'm-done', identifier: 'INV-12', title: 'Old', kind: 'MILESTONE' } });
    const location = screen.getByLabelText('Location') as HTMLSelectElement;
    expect(location.value).toBe('m-done');
    expect(location.selectedOptions[0]?.textContent).toBe('In INV-12 — Old');
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
