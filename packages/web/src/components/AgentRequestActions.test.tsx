import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_REQUEST_ANSWER_MUTATION } from '../board/queries';
import type { WorkContextRequest } from '../work/types';
import { AgentRequestActions } from './AgentRequestActions';
import { ActorSuccessorControl } from './ActorSuccessorControl';
import { RespondToAgent } from './RespondToAgent';

const mockAnswer = vi.fn();
const mockReply = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn((doc: unknown) => [doc === AGENT_REQUEST_ANSWER_MUTATION ? mockAnswer : mockReply, { loading: false }]),
  useQuery: vi.fn(() => ({
    data: {
      users: {
        nodes: [
          { id: 'agent-1', name: 'Mia', email: null, actorKind: 'AGENT', deactivatedAt: null },
          { id: 'agent-2', name: 'Codex', email: null, actorKind: 'AGENT', deactivatedAt: null },
          { id: 'agent-3', name: 'Retired', email: null, actorKind: 'AGENT', deactivatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    },
  })),
}));

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mockAnswer.mockResolvedValue({ data: { agentRequestAnswer: { success: true, message: null } } });
  mockReply.mockResolvedValue({ data: { agentRequestReply: { success: true, message: null } } });
});

const person = { id: 'u-1', name: 'Asker', email: 'a@x', globalRole: 'USER' as const };
const admin = { id: 'u-9', name: 'Admin', email: 'admin@x', globalRole: 'ADMIN' as const };

function request(state: string, targetId = 'u-1'): WorkContextRequest {
  return {
    id: 'req-1',
    state,
    presence: 'online',
    deadlineAt: '2026-09-28T00:00:00.000Z',
    hopCount: 0,
    rootRequestId: null,
    handedOffFromId: null,
    failureReason: null,
    answeredCommentId: null,
    targetActor: { id: targetId, name: 'Target', handle: 'target', actorKind: 'HUMAN' },
    requestedByActor: { id: 'u-1', name: 'Asker', handle: null, actorKind: 'HUMAN' },
  };
}

describe('acting on a request from the work page (INV-794)', () => {
  it('lets the person it is addressed to answer, choosing to ask back', async () => {
    render(<AgentRequestActions request={request('SUBMITTED')} viewer={person} />);
    fireEvent.change(screen.getByLabelText('Answer request req-1'), { target: { value: 'Which one?' } });
    fireEvent.change(screen.getByLabelText('Answer as'), { target: { value: 'input-required' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() =>
      expect(mockAnswer).toHaveBeenCalledWith({
        variables: { input: { requestId: 'req-1', body: 'Which one?', state: 'input-required', overrideReason: null } },
      }),
    );
  });

  it('lets the asker reply once it was asked back, and an admin only with a reason', async () => {
    const { unmount } = render(<AgentRequestActions request={request('input-required', 'agent-1')} viewer={person} />);
    fireEvent.change(screen.getByLabelText('Reply to request req-1'), { target: { value: 'Option B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply to agent' }));
    await waitFor(() => expect(mockReply).toHaveBeenCalledWith({ variables: { requestId: 'req-1', body: 'Option B', overrideReason: null } }));
    unmount();

    render(<AgentRequestActions request={request('INPUT_REQUIRED', 'agent-1')} viewer={admin} />);
    fireEvent.change(screen.getByLabelText('Reply to request req-1'), { target: { value: 'B' } });
    const button = screen.getByRole('button', { name: 'Reply to agent on their behalf' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Why you are acting on their behalf'), { target: { value: 'Asker is away' } });
    expect(button).toBeEnabled();
  });

  it('shows nothing to anyone else, or once the request is closed', () => {
    const other = { ...person, id: 'u-2' };
    const { container, rerender } = render(<AgentRequestActions request={request('SUBMITTED')} viewer={other} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AgentRequestActions request={request('COMPLETED')} viewer={person} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the refusal the server gives', async () => {
    mockAnswer.mockResolvedValueOnce({ data: { agentRequestAnswer: { success: false, message: 'This request is no longer open.' } } });
    render(<AgentRequestActions request={request('SUBMITTED')} viewer={person} />);
    fireEvent.change(screen.getByLabelText('Answer request req-1'), { target: { value: 'Done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This request is no longer open.');
  });
});

describe('responding to an agent that asked for a decision (INV-794)', () => {
  it('sends a comment that mentions the agent', async () => {
    mockReply.mockResolvedValueOnce({ data: { commentCreate: { success: true } } });
    render(<RespondToAgent workId="work-1" agent={{ id: 'agent-1', handle: 'mia', name: 'Mia' }} />);
    fireEvent.change(screen.getByLabelText('Respond to @mia'), { target: { value: 'Go with B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Respond to the agent' }));
    await waitFor(() => expect(mockReply).toHaveBeenCalledWith({ variables: { input: { issueId: 'work-1', body: '@mia Go with B' } } }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sent to @mia.');
  });
});

describe('declaring a successor (INV-794)', () => {
  it('offers active actors other than itself and saves the choice', async () => {
    mockReply.mockResolvedValueOnce({ data: { actorSetSuccessor: { success: true } } });
    render(<ActorSuccessorControl actor={{ id: 'agent-1', successorActor: null }} />);
    const select = screen.getByLabelText('Successor');
    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['None declared', 'Codex']);
    fireEvent.change(select, { target: { value: 'agent-2' } });
    await waitFor(() => expect(mockReply).toHaveBeenCalledWith({ variables: { id: 'agent-1', successorId: 'agent-2' } }));
  });
});

describe('a refused successor (INV-794)', () => {
  it('goes back to what is still set', async () => {
    mockReply.mockResolvedValueOnce({ data: { actorSetSuccessor: { success: false, message: 'Pick an active actor.' } } });
    render(<ActorSuccessorControl actor={{ id: 'agent-1', successorActor: null }} />);
    const select = screen.getByLabelText('Successor') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'agent-2' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick an active actor.');
    expect(select.value).toBe('');
  });
});
