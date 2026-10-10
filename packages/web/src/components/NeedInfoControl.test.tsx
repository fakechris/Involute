import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NEED_INFO_REQUEST_MUTATION } from '../board/queries';
import type { AgentRequestSummary } from '../board/types';
import { NeedInfoControl, NeedInfoWithdrawButton } from './NeedInfoControl';

const mockRequest = vi.fn();
const mockWithdraw = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn((doc: unknown) => [doc === NEED_INFO_REQUEST_MUTATION ? mockRequest : mockWithdraw, { loading: false }]),
}));

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mockRequest.mockResolvedValue({ data: { needInfoRequest: { success: true, message: null } } });
  mockWithdraw.mockResolvedValue({ data: { needInfoWithdraw: { success: true, message: null } } });
});

const viewer = { id: 'u-1', name: 'Asker', email: 'a@x', globalRole: 'USER' as const };
const people = [
  { id: 'u-1', name: 'Asker', email: 'a@x', actorKind: 'HUMAN' as const },
  { id: 'u-2', name: 'Rita', email: 'rita@x', actorKind: 'HUMAN' as const },
  { id: 'a-1', name: 'Fixer', email: null, actorKind: 'AGENT' as const },
  { id: 's-1', name: 'CI', email: null, actorKind: 'SERVICE' as const },
];

function needInfo(state: string, requesterId = 'u-1'): AgentRequestSummary {
  return {
    id: 'req-1',
    state,
    presence: 'waiting',
    presenceDetail: '',
    deadlineAt: '2026-10-17T00:00:00.000Z',
    hopCount: 0,
    rootRequestId: null,
    handedOffFromId: null,
    failureReason: null,
    answeredCommentId: null,
    needInfo: true,
    body: 'Which browser?',
    targetActor: { id: 'u-2', name: 'Rita', email: null, actorKind: 'HUMAN' },
    requestedByActor: { id: requesterId, name: 'Asker' },
  };
}

describe('needinfo on the issue page (INV-1119)', () => {
  it('asks a chosen person a question, offering people and agents but not yourself or services', async () => {
    const onChanged = vi.fn();
    render(<NeedInfoControl issueId="issue-1" people={people} viewer={viewer} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask for info' }));
    const select = screen.getByLabelText('Who should answer');
    const options = Array.from(select.querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toEqual(['Choose who should answer', 'Rita', 'Fixer (agent)']);
    fireEvent.change(select, { target: { value: 'u-2' } });
    fireEvent.change(screen.getByLabelText('What do you need to know'), { target: { value: ' Which browser? ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send needinfo' }));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith({ variables: { input: { workId: 'issue-1', targetId: 'u-2', question: 'Which browser?' } } }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows the server refusal', async () => {
    mockRequest.mockResolvedValue({ data: { needInfoRequest: { success: false, message: 'There is already an open needinfo to that target on this work.' } } });
    render(<NeedInfoControl issueId="issue-1" people={people} viewer={viewer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask for info' }));
    fireEvent.change(screen.getByLabelText('Who should answer'), { target: { value: 'a-1' } });
    fireEvent.change(screen.getByLabelText('What do you need to know'), { target: { value: 'Regression?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send needinfo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already an open needinfo');
  });

  it('lets whoever asked withdraw an open needinfo, and nobody else but an admin', async () => {
    render(<NeedInfoWithdrawButton request={needInfo('SUBMITTED')} viewer={viewer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw needinfo' }));
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledWith({ variables: { requestId: 'req-1', reason: null } }));
    cleanup();

    render(<NeedInfoWithdrawButton request={needInfo('SUBMITTED', 'someone-else')} viewer={viewer} />);
    expect(screen.queryByRole('button', { name: 'Withdraw needinfo' })).toBeNull();
    cleanup();

    render(<NeedInfoWithdrawButton request={needInfo('COMPLETED')} viewer={viewer} />);
    expect(screen.queryByRole('button', { name: 'Withdraw needinfo' })).toBeNull();
    cleanup();

    vi.spyOn(window, 'prompt').mockReturnValue('Reporter left');
    render(<NeedInfoWithdrawButton request={needInfo('SUBMITTED', 'someone-else')} viewer={{ ...viewer, globalRole: 'ADMIN' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw needinfo' }));
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledWith({ variables: { requestId: 'req-1', reason: 'Reporter left' } }));
  });
});
