import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownRenderer } from './MarkdownRenderer';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { PREVIEW_FRESH_MS, WorkReference, WorkReferenceProvider, WorkReferenceText } from './WorkReference';

const { mockUseQuery, previews } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  previews: [
    {
      id: 'work-1446',
      reference: 'INV-1446',
      identifier: 'INV-1446',
      title: 'Fact window filter for the timeline',
      stateName: 'In Progress',
      stateType: 'STARTED',
      commitmentStatus: 'COMMITTED',
      priority: 3,
      kind: 'ISSUE',
      repository: 'fakechris/Involute',
      teamKey: 'INV',
      typeLabel: 'Feature',
      excerpt: 'The timeline narrows by the events it has recorded.',
      updatedAt: '2026-10-31T00:00:00.000Z',
    },
    {
      id: 'work-267',
      reference: 'INV-267',
      identifier: 'INV-267',
      title: 'Event replay and latency',
      stateName: 'In Review',
      stateType: 'REVIEW',
      commitmentStatus: 'COMMITTED',
      priority: 2,
      kind: 'ISSUE',
      repository: 'fakechris/Involute',
      teamKey: 'INV',
      typeLabel: null,
      excerpt: 'The window, the time zone and the boundary are written down.',
      updatedAt: '2026-10-30T00:00:00.000Z',
    },
  ],
}));

vi.mock('@apollo/client/react', () => {
  const client = {
    query: (options: { variables?: { identifiers?: string[] } }) => {
      mockUseQuery(options.variables?.identifiers ?? []);
      const requested = options.variables?.identifiers ?? [];
      return Promise.resolve({
        data: { issuePreviews: previews.filter((preview) => requested.includes(preview.reference)) },
      });
    },
  };
  return { useApolloClient: () => client };
});

beforeEach(() => {
  mockUseQuery.mockClear();
});

afterEach(cleanup);

function renderWithProvider(children: React.ReactNode) {
  return render(<WorkReferenceProvider>{children}</WorkReferenceProvider>);
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderInRouter(entry: string, children: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <WorkReferenceProvider>
        {children}
        <LocationProbe />
      </WorkReferenceProvider>
    </MemoryRouter>,
  );
}

/** The calls the provider made that actually asked the server something. */
function askedFor(): string[][] {
  return mockUseQuery.mock.calls.map(([identifiers]) => identifiers as string[]);
}

describe('work references in prose (INV-1466)', () => {
  it('turns a reference into a link to the work item', async () => {
    renderWithProvider(<WorkReference reference="INV-1446" />);

    const link = await screen.findByRole('link', { name: 'INV-1446' });
    expect(link).toHaveAttribute('href', '/issue/INV-1446');
    expect(link).not.toHaveAttribute('target');
  });

  it('opens the drawer over the current page on a plain click and leaves modified clicks to the browser (INV-1536)', async () => {
    renderInRouter('/inbox?tab=all', <WorkReference reference="INV-1446" />);
    const link = await screen.findByRole('link', { name: 'INV-1446' });

    const modified = fireEvent.click(link, { metaKey: true });
    expect(modified).toBe(true);
    expect(screen.getByTestId('location')).toHaveTextContent('/inbox?tab=all');

    const plain = fireEvent.click(link);
    expect(plain).toBe(false);
    expect(screen.getByTestId('location')).toHaveTextContent('/inbox?tab=all&issue=INV-1446');
  });

  it('opens the issue page from a page that shows an issue itself (INV-1536)', async () => {
    renderInRouter('/issue/INV-1', <WorkReference reference="INV-1446" />);
    fireEvent.click(await screen.findByRole('link', { name: 'INV-1446' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/issue/INV-1446');
  });

  it('asks again about a reference whose answer is old, so the card shows the state now (INV-1536)', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      renderWithProvider(<WorkReference reference="INV-1446" />);
      const link = await screen.findByRole('link', { name: 'INV-1446' });
      expect(askedFor()).toEqual([['INV-1446']]);

      fireEvent.mouseEnter(link);
      fireEvent.mouseLeave(link);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(askedFor()).toHaveLength(1);

      now.mockReturnValue(1_000_000 + PREVIEW_FRESH_MS + 1);
      previews[0]!.stateName = 'Done';
      fireEvent.mouseEnter(link);
      await waitFor(() => expect(askedFor()).toHaveLength(2));
      await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Done'));
    } finally {
      previews[0]!.stateName = 'In Progress';
      now.mockRestore();
    }
  });

  it('shows what the reference points at when the reader hovers it', async () => {
    renderWithProvider(<WorkReference reference="INV-1446" />);

    const link = await screen.findByRole('link', { name: 'INV-1446' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseEnter(link);

    const card = await screen.findByRole('tooltip');
    expect(card).toHaveTextContent('Fact window filter for the timeline');
    expect(card).toHaveTextContent('INV-1446');
    expect(card).toHaveTextContent('In Progress');
    expect(card).toHaveTextContent('fakechris/Involute');
  });

  it('leaves a name that is not a work item as plain text', async () => {
    renderWithProvider(<WorkReference reference="UTF-8" />);

    await waitFor(() => expect(askedFor().length).toBeGreaterThan(0));
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('UTF-8')).toBeInTheDocument();
  });

  it('links the references inside a description', async () => {
    renderWithProvider(<MarkdownRenderer content="依赖 INV-1446 落地后再做。" />);

    const link = await screen.findByRole('link', { name: 'INV-1446' });
    expect(link).toHaveAttribute('href', '/issue/INV-1446');
  });

  it('links the references inside plain text', async () => {
    renderWithProvider(<WorkReferenceText text="依赖 INV-1446 落地后再做。" />);

    const link = await screen.findByRole('link', { name: 'INV-1446' });
    expect(link).toHaveAttribute('href', '/issue/INV-1446');
  });

  it('asks the server about the whole page in one request', async () => {
    renderWithProvider(
      <>
        <WorkReference reference="INV-1446" />
        <WorkReference reference="INV-267" />
        <WorkReference reference="INV-1446" />
      </>,
    );

    await screen.findAllByRole('link', { name: 'INV-1446' });
    await screen.findByRole('link', { name: 'INV-267' });

    // One batch, each reference named once.
    expect(askedFor().at(-1)).toEqual(['INV-1446', 'INV-267']);
    expect(new Set(askedFor().map((identifiers) => identifiers.join(',')))).toEqual(new Set(['INV-1446,INV-267']));
  });
  it('asks only about new references, at most 100 at a time, however many the session has met (INV-1537)', async () => {
    const many = Array.from({ length: 120 }, (_, index) => `ZZ-${index + 1}`).join(' ');
    const { rerender } = renderWithProvider(<WorkReferenceText text={many} />);
    await waitFor(() => expect(askedFor().flat()).toHaveLength(120));
    expect(askedFor().every((identifiers) => identifiers.length <= 100)).toBe(true);

    rerender(
      <WorkReferenceProvider>
        <WorkReferenceText text={many} />
        <WorkReference reference="INV-1446" />
      </WorkReferenceProvider>,
    );
    expect(await screen.findByRole('link', { name: 'INV-1446' })).toHaveAttribute('href', '/issue/INV-1446');
    expect(askedFor().at(-1)).toEqual(['INV-1446']);
  });
});
