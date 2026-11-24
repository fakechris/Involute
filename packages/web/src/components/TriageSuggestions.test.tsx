import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TriageSuggestions } from './TriageSuggestions';

const query = vi.fn();
const exposure = vi.fn();
const feedback = vi.fn();
vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => query(...args),
  useMutation: (document: { loc?: { source?: { body?: string } } }) => [document.loc?.source?.body?.includes('mutation TriageSuggestionExposure') ? exposure : feedback],
}));

const quote = '<img src=x onerror=alert(1)> **not bold** [not a link](javascript:alert(1))';
const candidate = { id: 'other', identifier: 'INV-649', title: 'Checkout failure', repository: 'org/elsewhere', stateType: 'COMPLETED', revision: 1, crossProject: false };
const similar = { checkId: 'similar_other', kind: 'similar', value: 'same_issue', quote, candidate };
function respond(overrides: Record<string, unknown> = {}) {
  query.mockReturnValue({ data: { workTriageSuggestions: { status: 'advice', degraded: false, observationId: 'obs', suggestions: [similar], ...overrides } } });
}
async function ready() { await waitFor(() => expect(screen.getAllByRole('button', { name: 'Right' })[0]).toBeEnabled()); }

beforeEach(() => {
  vi.clearAllMocks();
  exposure.mockResolvedValue({ data: { triageSuggestionExposure: { success: true, message: 'Exposure stored' } } });
  feedback.mockResolvedValue({ data: { triageSuggestionFeedback: { success: true, message: 'Feedback stored' } } });
  respond();
});
afterEach(cleanup);

describe('candidate triage suggestions', () => {
  it.each(['disabled', 'control', 'shadow', 'stale'])('hides %s without recording exposure', status => {
    respond({ status });
    const { container } = render(<TriageSuggestions workId="work" />);
    expect(container).toBeEmptyDOMElement();
    expect(exposure).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
  });
  it.each([{}, { error: new Error('Unavailable') }, { data: { workTriageSuggestions: null } }])('keeps the usual view on an empty or failed query', response => {
    query.mockReturnValue(response);
    const { container } = render(<TriageSuggestions workId="work" />);
    expect(container).toBeEmptyDOMElement();
    expect(exposure).not.toHaveBeenCalled();
  });
  it('renders only a muted unavailable line for degraded suggestions', () => {
    respond({ status: 'degraded', degraded: true });
    render(<TriageSuggestions workId="work" />);
    expect(screen.getByText('Suggestions unavailable; showing the usual view.')).toHaveClass('observation-card__meta');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByText(quote)).not.toBeInTheDocument();
    expect(exposure).not.toHaveBeenCalled();
  });
  it('does not expose an empty advice section', () => {
    respond({ suggestions: [] });
    const { container } = render(<TriageSuggestions workId="work" />);
    expect(container).toBeEmptyDOMElement();
    expect(exposure).not.toHaveBeenCalled();
  });
  it('renders advisory relations, work references, cross-project badges, plain-text quotes, missing info and abstention', async () => {
    respond({ suggestions: [{ ...similar, value: 'related_distinct', candidate: { ...candidate, crossProject: true } }, { checkId: 'steps', kind: 'missing_info', value: 'missing', quote: 'Original report', candidate: null }, { checkId: 'type', kind: 'type', value: 'abstained', quote: '', candidate: null }] });
    const { container } = render(<TriageSuggestions workId="work" />);
    await ready();
    expect(query).toHaveBeenCalledWith(expect.anything(), { variables: { workId: 'work' }, fetchPolicy: 'network-only' });
    expect(screen.getByText('Advisory')).toBeInTheDocument();
    expect(screen.getByText('Related but distinct')).toBeInTheDocument();
    expect(screen.getByText(/INV-649/)).toBeInTheDocument();
    expect(screen.getByText('Cross-project')).toBeInTheDocument();
    expect(screen.getByTitle('Project: org/elsewhere')).toHaveTextContent('elsewhere');
    expect(screen.getByText(quote)).toBeInTheDocument();
    expect(container.querySelector('img, strong, blockquote a')).toBeNull();
    expect(screen.getByText('Steps to reproduce:')).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
    expect(screen.getByText('No judgment')).toBeInTheDocument();
  });
  it('acknowledges triageSuggestionExposure exactly once after render, even under StrictMode and rerenders', async () => {
    exposure.mockImplementation(async () => {
      expect(screen.getByRole('region', { name: 'Triage suggestions' })).toBeInTheDocument();
      return { data: { triageSuggestionExposure: { success: true } } };
    });
    const { rerender } = render(<StrictMode><TriageSuggestions workId="work" /></StrictMode>);
    await ready();
    rerender(<StrictMode><TriageSuggestions workId="work" /></StrictMode>);
    expect(exposure).toHaveBeenCalledTimes(1);
    expect(exposure).toHaveBeenCalledWith({ variables: { observationId: 'obs' } });
    respond({ observationId: 'next' });
    rerender(<StrictMode><TriageSuggestions workId="work" /></StrictMode>);
    await ready();
    expect(exposure).toHaveBeenCalledTimes(2);
  });
  it.each([['Right', 'accepted', 'Right'], ['Wrong', 'rejected', 'Wrong']])('stores %s via triageSuggestionFeedback only, never links work', async (button, verdict, stored) => {
    render(<TriageSuggestions workId="work" />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`Saved: ${stored} — Same issue`));
    expect(feedback).toHaveBeenCalledOnce();
    expect(feedback).toHaveBeenCalledWith({ variables: { input: { observationId: 'obs', workId: 'work', checkId: 'similar_other', verdict } } });
    expect(screen.getByText(/Accepting feedback never links or changes work/)).toBeInTheDocument();
  });
  it('stores a different allowed correction and keeps the original judgment visible', async () => {
    render(<TriageSuggestions workId="work" />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
    expect(within(screen.getByRole('combobox')).queryByRole('option', { name: 'Same issue' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Correction'), { target: { value: 'possible_regression' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved: Corrected — Possible regression'));
    expect(feedback).toHaveBeenCalledWith({ variables: { input: { observationId: 'obs', workId: 'work', checkId: 'similar_other', verdict: 'corrected', correctedValue: 'possible_regression' } } });
    expect(screen.getByText('Same issue')).toBeInTheDocument();
  });
  it('never offers same_issue as a correction for cross-project suggestions', async () => {
    respond({ suggestions: [{ ...similar, value: 'related_distinct', candidate: { ...candidate, crossProject: true } }] });
    render(<TriageSuggestions workId="work" />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    expect(within(screen.getByRole('combobox')).queryByRole('option', { name: 'Same issue' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('combobox')).getByRole('option', { name: 'Possible regression' })).toBeInTheDocument();
  });
  it.each([
    { checkId: 'acceptance', kind: 'missing_info', value: 'missing', quote: '', candidate: null, replacement: 'present', option: 'Present', count: 2 },
    { checkId: 'type', kind: 'type', value: 'Bug', quote: '', candidate: null, replacement: 'Feature', option: 'Feature', count: 4 },
  ])('offers only allowed $kind corrections', async ({ replacement, option, count, ...suggestion }) => {
    respond({ suggestions: [suggestion] });
    render(<TriageSuggestions workId="work" />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    expect(screen.getAllByRole('option')).toHaveLength(count);
    fireEvent.change(screen.getByLabelText('Correction'), { target: { value: replacement } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`Saved: Corrected — ${option}`));
  });
  it('shows a refused feedback payload message without claiming it was stored', async () => {
    feedback.mockResolvedValue({ data: { triageSuggestionFeedback: { success: false, message: 'Observation is stale; reload suggestions.' } } });
    render(<TriageSuggestions workId="work" />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Observation is stale; reload suggestions.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('shows transport errors and leaves controls usable for a retry', async () => {
    feedback.mockRejectedValue(new Error('Connection lost'));
    render(<TriageSuggestions workId="work" />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
    expect(screen.getByRole('button', { name: 'Right' })).toBeEnabled();
  });
  it('shows exposure payload errors and prevents feedback without acknowledged exposure', async () => {
    exposure.mockResolvedValue({ data: { triageSuggestionExposure: { success: false, message: 'No longer readable' } } });
    render(<TriageSuggestions workId="work" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No longer readable');
    expect(screen.getByRole('button', { name: 'Right' })).toBeDisabled();
    expect(feedback).not.toHaveBeenCalled();
  });
});
