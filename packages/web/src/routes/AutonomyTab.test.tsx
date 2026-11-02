import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminAutonomyTab, ProjectAutonomyField, TeamAutonomySection } from './AutonomyTab';
import type { AutonomySettingsData } from './settings-queries';

// INV-1489: the three places a person sets autonomy (docs/autonomy-policy.md §2).

const LEVELS: AutonomySettingsData['autonomySettings']['levels'] = [0, 1, 2, 3].map((level) => ({
  level,
  name: ['L0 Review everything', 'L1 Low-risk pass-through', 'L2 Green-light accept', 'L3 Hands-off'][level]!,
  descriptionEn: `English for L${level} long enough to read`,
  descriptionZh: `L${level} 的中文说明`,
  gates: [
    { gate: 'candidate_commit', decider: level >= 1 ? 'auto' : 'human' },
    { gate: 'contract_amendment', decider: level >= 1 ? 'auto' : 'human' },
    { gate: 'review_accept', decider: level >= 2 ? 'auto' : 'human' },
    { gate: 'agent_delegation', decider: level >= 3 ? 'auto' : 'none' },
    { gate: 'merge_signal', decider: 'human' },
    { gate: 'spend_budget', decider: level >= 3 ? 'human' : 'none' },
  ],
}));

function settings(overrides: Partial<AutonomySettingsData['autonomySettings']> = {}): AutonomySettingsData {
  return {
    autonomySettings: {
      scope: 'WORKSPACE',
      scopeId: 'workspace',
      active: null,
      history: [],
      ceiling: 2,
      paused: false,
      defaultLevel: 0,
      templates: [{ name: 'Bugs on autopilot', level: 2 }, { name: 'Hands-off', level: 3 }],
      completionReply: null,
      levels: LEVELS,
      builtInLocks: [
        { id: 'sev1_sev2_done', gate: 'review_accept', reason: 'SEV1 / SEV2 incidents reach Done only through a person (INV-1126).' },
        { id: 'deploy_or_credentials', gate: 'review_accept', reason: 'Deploys wait for a person.' },
        { id: 'intermittent_bug', gate: 'review_accept', reason: 'A merged PR cannot prove an intermittent bug gone (INV-1122).' },
      ],
      gates: ['candidate_commit', 'contract_amendment', 'review_accept', 'agent_delegation', 'merge_signal', 'spend_budget'],
      conditionFields: ['type', 'priority', 'has_steps'],
      ...overrides,
    },
  };
}

let data: AutonomySettingsData = settings();
const mockSet = vi.fn();
const mockClear = vi.fn();
const mockRefetch = vi.fn().mockResolvedValue(undefined);

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({ data, loading: false, error: undefined, refetch: mockRefetch })),
  useMutation: vi.fn((doc: { definitions: Array<{ name?: { value: string } }> }) => {
    const name = doc.definitions.find((definition) => definition.name)?.name?.value ?? '';
    return [name === 'WorkflowPolicyClear' ? mockClear : mockSet, { loading: false }];
  }),
}));

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  data = settings();
  mockSet.mockResolvedValue({ data: { workflowPolicySet: { success: true, message: null } } });
  mockClear.mockResolvedValue({ data: { workflowPolicyClear: { success: true, message: null, cleared: true } } });
});

describe('Administration → Autonomy (INV-1489)', () => {
  it('shows every level in both languages, keeps built-in locks checked and disabled, and saves with a reason', async () => {
    render(<AdminAutonomyTab />);
    expect(screen.getByText('L2 的中文说明')).toBeInTheDocument();
    expect(screen.getByText('English for L3 long enough to read')).toBeInTheDocument();
    const lock = screen.getByLabelText('Lock sev1_sev2_done');
    expect(lock).toBeChecked();
    expect(lock).toBeDisabled();
    const save = screen.getByRole('button', { name: 'Save autonomy' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'L3 Hands-off' }));
    fireEvent.click(screen.getByLabelText('Lock contract_amendment'));
    fireEvent.change(screen.getByLabelText('Reason for the autonomy change'), { target: { value: 'raise after 30 days' } });
    fireEvent.click(save);
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));
    const input = mockSet.mock.calls[0]![0].variables.input;
    expect(input).toMatchObject({ scope: 'WORKSPACE', scopeId: 'workspace', level: 3, locked: ['contract_amendment'], reason: 'raise after 30 days', completionReply: '' });
    expect(input.templates).toEqual([{ name: 'Bugs on autopilot', level: 2 }, { name: 'Hands-off', level: 3 }]);
    expect(await screen.findByText('Autonomy settings saved.')).toBeInTheDocument();
  });

  it('pauses all autonomy with a reason and shows the server reason when refused', async () => {
    render(<AdminAutonomyTab />);
    fireEvent.change(screen.getByLabelText('Reason for the autonomy change'), { target: { value: 'incident' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pause all autonomy' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ variables: { input: expect.objectContaining({ paused: true, reason: 'incident' }) } })));
    mockSet.mockResolvedValueOnce({ data: { workflowPolicySet: { success: false, message: 'Only a workspace Admin sets the workspace autonomy policy (INV-1488).' } } });
    fireEvent.change(screen.getByLabelText('Reason for the autonomy change'), { target: { value: 'again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save autonomy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a workspace Admin');
  });

  it('adds and removes templates', () => {
    render(<AdminAutonomyTab />);
    fireEvent.change(screen.getByLabelText('New template name'), { target: { value: 'Features reviewed' } });
    fireEvent.change(screen.getByLabelText('New template level'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add template' }));
    const list = screen.getByRole('list', { name: 'Templates' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Remove template Hands-off' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('Team settings → Autonomy (INV-1489)', () => {
  it('locks levels above the ceiling, lets a step be tightened but not loosened, and turns on now', async () => {
    data = settings({ scope: 'TEAM', scopeId: 'team-1' });
    render(<TeamAutonomySection teamId="team-1" />);
    const l3 = screen.getByRole('radio', { name: 'L3 Hands-off' });
    expect(l3).toBeDisabled();
    expect(screen.getByText(/Above the workspace ceiling \(L2\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'L2 Green-light accept' }));
    fireEvent.click(screen.getByText('Advanced: per step'));
    const review = screen.getByLabelText('Decider for review_accept') as HTMLSelectElement;
    expect(within(review).getAllByRole('option').map((option) => option.textContent)).toEqual(['Automatic when the condition holds', 'A person']);
    fireEvent.change(review, { target: { value: 'human' } });
    expect(screen.getByLabelText('Decider for agent_delegation')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for the autonomy change'), { target: { value: 'bugs first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on now' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));
    expect(mockSet.mock.calls[0]![0].variables.input).toEqual({ scope: 'TEAM', scopeId: 'team-1', level: 2, reason: 'bugs first', gates: { review_accept: { decider: 'human' } }, observeDays: 0 });
    expect(await screen.findByText('Autonomy set to L2.')).toBeInTheDocument();
  });

  it('offers observe as an option, never a requirement, and builds an L3 intake rule from typed fields', async () => {
    data = settings({ scope: 'TEAM', scopeId: 'team-1', ceiling: 3 });
    render(<TeamAutonomySection teamId="team-1" />);
    fireEvent.click(screen.getByRole('radio', { name: 'L3 Hands-off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    fireEvent.change(screen.getByLabelText('Intake field 1'), { target: { value: 'type' } });
    fireEvent.change(screen.getByLabelText('Intake operator 1'), { target: { value: 'in' } });
    fireEvent.change(screen.getByLabelText('Intake value 1'), { target: { value: 'bug, improvement' } });
    fireEvent.change(screen.getByLabelText('Observe for days'), { target: { value: '14' } });
    fireEvent.change(screen.getByLabelText('Reason for the autonomy change'), { target: { value: 'trial' } });
    fireEvent.click(screen.getByRole('button', { name: 'Observe for 14 days' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));
    expect(mockSet.mock.calls[0]![0].variables.input).toMatchObject({ level: 3, observeDays: 14, intake: { all: [{ field: 'type', in: ['bug', 'improvement'] }] } });
    expect(await screen.findByText(/Observing L3 for 14 days/)).toBeInTheDocument();
  });

  it('a template click selects its level', () => {
    data = settings({ scope: 'TEAM', scopeId: 'team-1', ceiling: 3 });
    render(<TeamAutonomySection teamId="team-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugs on autopilot · L2' }));
    expect(screen.getByRole('radio', { name: 'L2 Green-light accept' })).toBeChecked();
  });
});

describe('Projects → Edit → Autonomy (INV-1489)', () => {
  it('switches a project from inheriting to an override with a reason, and back', async () => {
    data = settings({ scope: 'PROJECT', scopeId: 'project-1' });
    const onChanged = vi.fn();
    render(<ProjectAutonomyField projectId="project-1" autonomy={{ level: 1, source: 'team', name: 'L1 Low-risk pass-through', requested: 1, requestedBy: 'team' }} onChanged={onChanged} />);
    expect(screen.getByRole('radio', { name: 'Inherit from team' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Apply autonomy' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Override for this project' }));
    fireEvent.change(screen.getByLabelText('Project autonomy level'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Reason for the project autonomy change'), { target: { value: 'sensitive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply autonomy' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith({ variables: { input: { scope: 'PROJECT', scopeId: 'project-1', level: 0, reason: 'sensitive' } } }));
    expect(onChanged).toHaveBeenCalled();

    cleanup();
    render(<ProjectAutonomyField projectId="project-1" autonomy={{ level: 0, source: 'project', name: 'L0 Review everything', requested: 0, requestedBy: 'project' }} onChanged={onChanged} />);
    expect(screen.getByRole('radio', { name: 'Override for this project' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Inherit from team' }));
    fireEvent.change(screen.getByLabelText('Reason for the project autonomy change'), { target: { value: 'trust the team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply autonomy' }));
    await waitFor(() => expect(mockClear).toHaveBeenCalledWith({ variables: { input: { scope: 'PROJECT', scopeId: 'project-1', reason: 'trust the team' } } }));
    expect(await screen.findByText('The project inherits its team again.')).toBeInTheDocument();
  });
});
