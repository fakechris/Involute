import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoverageHints } from './CoverageHints';

let response: { data?: { workCoverageHints: unknown }; error?: Error };
vi.mock('@apollo/client/react', () => ({ useQuery: () => response }));
vi.mock('./MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
afterEach(cleanup);
describe('review coverage hints', () => {
  it.each(['disabled', 'control', 'shadow', 'fallback', 'stale'])('hides %s entirely', status => {
    response = { data: { workCoverageHints: { status, criteria: [] } } };
    const { container } = render(<CoverageHints workId="work" />);
    expect(container).toBeEmptyDOMElement();
  });
  it.each(['advice', 'abstained'])('labels %s as advisory with criterion, source and code findings', status => {
    response = { data: { workCoverageHints: { status, criteria: [{ id: 'c1', text: 'Deploy production', judgment: 'insufficient', sources: [{ id: 'e1', url: 'https://github.com/org/repo/pull/1', summary: '10 tests passed', origin: 'fixture' }], codeFindings: [{ evidenceId: 'e1', message: 'test evidence cannot prove deployment' }] }] } } };
    render(<CoverageHints workId="work" />);
    expect(screen.getByText(/Advisory — not verification/)).toBeInTheDocument();
    expect(screen.getByText('Deploy production')).toBeInTheDocument();
    expect(screen.getByText('test evidence cannot prove deployment')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'e1' })).toHaveAttribute('href', 'https://github.com/org/repo/pull/1');
  });
  it.each([{}, { error: new Error('refused') }, { data: { workCoverageHints: null } }])('hides empty and failed reads', value => {
    response = value;
    const { container } = render(<CoverageHints workId="work" />);
    expect(container).toBeEmptyDOMElement();
  });
});
