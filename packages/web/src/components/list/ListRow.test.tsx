import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IssueRow, ListRow } from './ListRow';

afterEach(cleanup);

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function inRouter(node: ReactNode, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<>{node}<Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ListRow (INV-1315)', () => {
  it('lays out leading, id, title, meta, trailing and detail slots', () => {
    inRouter(
      <ul>
        <ListRow
          leading={<span data-testid="lead">L</span>}
          id="INV-1"
          title="A very long title"
          meta="3d"
          trailing={<button type="button">Act</button>}
          detail="snippet"
        />
      </ul>,
    );
    const row = screen.getByRole('listitem');
    expect(row).toHaveClass('list-row', 'list-row--multiline');
    expect(row.querySelector('.list-row__leading')).toContainElement(screen.getByTestId('lead'));
    const id = row.querySelector('.list-row__id');
    expect(id).toHaveTextContent('INV-1');
    expect(id).toHaveClass('mono');
    expect(row.querySelector('.list-row__title')).toHaveAttribute('title', 'A very long title');
    expect(row.querySelector('.list-row__meta')).toHaveTextContent('3d');
    expect(within(row.querySelector('.list-row__trailing') as HTMLElement).getByRole('button', { name: 'Act' })).toBeInTheDocument();
    expect(row.querySelector('.list-row__detail')).toHaveTextContent('snippet');
  });

  it('makes id + title one link that covers the row when given a route', () => {
    inRouter(
      <ul>
        <ListRow id="INV-2" title="Open me" to="/issue/INV-2" openLabel="Open issue INV-2" />
      </ul>,
    );
    const link = screen.getByRole('link', { name: 'Open issue INV-2' });
    expect(link).toHaveAttribute('href', '/issue/INV-2');
    expect(link).toHaveClass('list-row__main');
    expect(screen.getByRole('listitem')).toHaveClass('list-row--opens');
    fireEvent.click(link);
    expect(screen.getByTestId('where')).toHaveTextContent('/issue/INV-2');
  });

  it('uses a button when given onOpen, and marks current / unread / alert', () => {
    const onOpen = vi.fn();
    inRouter(<ListRow as="div" id="INV-3" title="T" onOpen={onOpen} current unread alert variant="divided" />);
    fireEvent.click(screen.getByRole('button', { name: 'INV-3 T' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const row = document.querySelector('.list-row') as HTMLElement;
    expect(row.tagName).toBe('DIV');
    expect(row).toHaveClass('list-row--divided', 'is-current', 'is-unread', 'is-alert');
  });

  it('a compact reference does not cover its container', () => {
    inRouter(<ListRow as="div" variant="compact" id="INV-4" title="T" to="/issue/INV-4" />);
    const row = document.querySelector('.list-row') as HTMLElement;
    expect(row).toHaveClass('list-row--compact');
    expect(row).not.toHaveClass('list-row--opens');
  });
});

describe('IssueRow', () => {
  const issue = {
    id: 'issue-9',
    identifier: 'INV-9',
    title: 'Fix the thing',
    priority: 2,
    state: { name: 'In Progress', type: 'STARTED' },
    labels: { nodes: [{ id: 'l1', name: 'bug', color: 'var(--danger)' }] },
    repository: 'acme/web',
  };

  it('shows icons, identifier, title, state, labels, project and age, and opens the issue page', () => {
    inRouter(
      <ul>
        <IssueRow issue={issue} showState showLabels showProject age="3d" sla={<span>SLA 4h</span>} />
      </ul>,
    );
    const row = screen.getByRole('listitem');
    expect(within(row).getByRole('img', { name: 'Status: In Progress' })).toBeInTheDocument();
    const link = within(row).getByRole('link', { name: /INV-9/ });
    expect(link).toHaveAttribute('href', '/issue/INV-9');
    const meta = row.querySelector('.list-row__meta') as HTMLElement;
    expect(meta).toHaveTextContent('bug');
    expect(meta).toHaveTextContent('In Progress');
    expect(within(meta).getByText('acme/web')).toHaveClass('badge', 'badge--mono');
    expect(meta).toHaveTextContent('SLA 4h');
    expect(meta).toHaveTextContent('3d');
  });

  it('opens the drawer on the current route with open="drawer"', () => {
    inRouter(
      <ul>
        <IssueRow issue={issue} open="drawer" />
      </ul>,
      '/board?view=list',
    );
    const link = screen.getByRole('link', { name: /INV-9/ });
    // The href is the full page, so the browser opens it on ⌘/Ctrl/middle click (INV-1387) …
    expect(link).toHaveAttribute('href', '/issue/INV-9');
    // … a modified click is left to the browser …
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(screen.getByTestId('where')).toHaveTextContent('/board?view=list');
    expect(screen.getByTestId('where')).not.toHaveTextContent('issue=');
    // … and a plain click opens the drawer on this route, keeping its params.
    fireEvent.click(link);
    expect(screen.getByTestId('where')).toHaveTextContent('/board?view=list&issue=INV-9');
  });

  it('is not a link with open="none"', () => {
    inRouter(
      <ul>
        <IssueRow issue={issue} open="none" />
      </ul>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Fix the thing')).toBeInTheDocument();
  });
});
