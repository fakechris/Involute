import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownRenderer } from './MarkdownRenderer';
import { WorkReference, WorkReferenceProvider, WorkReferenceText } from './WorkReference';

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

vi.mock('@apollo/client/react', () => ({
  useQuery: (document: unknown, options?: { variables?: { identifiers?: string[] }; skip?: boolean }) => {
    mockUseQuery(document, options);
    if (options?.skip) return { data: undefined, loading: false };
    const requested = options?.variables?.identifiers ?? [];
    return {
      data: { issuePreviews: previews.filter((preview) => requested.includes(preview.reference)) },
      loading: false,
    };
  },
}));

beforeEach(() => {
  mockUseQuery.mockClear();
});

afterEach(cleanup);

function renderWithProvider(children: React.ReactNode) {
  return render(<WorkReferenceProvider>{children}</WorkReferenceProvider>);
}

/** The calls the provider made that actually asked the server something. */
function askedFor(): string[][] {
  return mockUseQuery.mock.calls
    .map(([, options]) => options?.variables?.identifiers ?? [])
    .filter((identifiers) => identifiers.length > 0);
}

describe('work references in prose (INV-1466)', () => {
  it('turns a reference into a link that opens the work item in a new tab', async () => {
    renderWithProvider(<WorkReference reference="INV-1446" />);

    const link = await screen.findByRole('link', { name: 'INV-1446' });
    expect(link).toHaveAttribute('href', '/issue/INV-1446');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
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
});
