import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdminsTab,
  EmailNotificationsField,
  LabelsTab,
  ServerFeaturesTab,
  ServiceActorForm,
  WorkflowStatesTab,
} from './WorkspaceSettingsTabs';

// INV-797: workspace settings that used to need SQL, env edits or the CLI.

const mutations: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(
  [
    'LabelCreate', 'LabelUpdate', 'LabelDelete', 'WorkflowStateCreate', 'WorkflowStateUpdate', 'WorkflowStateDelete',
    'UserSetGlobalRole', 'ServiceActorCreate', 'NotificationPreferencesUpdate',
  ].map((name) => [name, vi.fn()]),
);
const refetch = vi.fn().mockResolvedValue(undefined);

const queryData: Record<string, unknown> = {
  SettingsLabels: {
    issueLabels: {
      nodes: [
        { id: 'l-bug', name: 'Bug', issueCount: 4 },
        { id: 'l-web', name: 'web', issueCount: 2 },
      ],
    },
  },
  SettingsStates: {
    teams: {
      nodes: [
        {
          id: 'team-1',
          name: 'Involute',
          states: {
            nodes: [
              { id: 's-ready', name: 'Ready', type: 'UNSTARTED', position: 1, issueCount: 3 },
              { id: 's-progress', name: 'In Progress', type: 'STARTED', position: 2, issueCount: 1 },
            ],
          },
        },
      ],
    },
  },
  SettingsPeople: {
    users: {
      nodes: [
        { id: 'u-ana', name: 'Ana', email: 'ana@x', actorKind: 'HUMAN', globalRole: 'ADMIN', deactivatedAt: null },
        { id: 'u-bo', name: 'Bo', email: 'bo@x', actorKind: 'HUMAN', globalRole: 'USER', deactivatedAt: null },
        { id: 'u-bot', name: 'Bot', email: 'bot@x', actorKind: 'AGENT', globalRole: 'USER', deactivatedAt: null },
      ],
    },
  },
  ServerFeatures: {
    serverFeatures: [
      { key: 'githubSync', label: 'GitHub sync', enabled: true, detail: 'Periodic reconciliation (GITHUB_TOKEN).' },
      { key: 'emailNotifications', label: 'Email notifications', enabled: false, detail: 'Sends email.' },
    ],
  },
  EmailNotifications: { viewer: { id: 'u-ana', emailNotifications: true } },
};

const operationName = (doc: { definitions: Array<{ name?: { value: string } }> }) => doc.definitions[0]?.name?.value ?? '';

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((doc) => ({ data: queryData[operationName(doc)], loading: false, error: undefined, refetch })),
  useMutation: vi.fn((doc) => {
    const name = operationName(doc);
    mutations[name] ??= vi.fn();
    return [mutations[name], { loading: false }];
  }),
}));

vi.mock('../board/utils', () => ({ readStoredTeamKey: () => 'INV' }));

afterEach(() => cleanup());
beforeEach(() => {
  for (const mock of Object.values(mutations)) mock.mockReset();
  refetch.mockClear();
});

const payload = (field: string, extra: Record<string, unknown> = {}) => ({ data: { [field]: { success: true, message: null, ...extra } } });
const refused = (field: string, message: string) => ({ data: { [field]: { success: false, message } } });

describe('labels', () => {
  it('adds, renames and deletes labels, and keeps built-in labels read only', async () => {
    render(<LabelsTab />);
    const list = screen.getByRole('list', { name: 'Label list' });
    const bugRow = within(list).getByText('Bug').closest('[role="listitem"]') as HTMLElement;
    expect(within(bugRow).getByText('built in')).toBeInTheDocument();
    expect(within(bugRow).queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();

    mutations.LabelCreate!.mockResolvedValue(payload('labelCreate', { label: { id: 'l-new', name: 'api', issueCount: 0 } }));
    fireEvent.change(screen.getByLabelText('New label name'), { target: { value: 'api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
    await waitFor(() => expect(mutations.LabelCreate).toHaveBeenCalledWith({ variables: { name: 'api' } }));
    expect(await screen.findByText('Created api.')).toBeInTheDocument();

    mutations.LabelUpdate!.mockResolvedValue(refused('labelUpdate', 'A label with that name already exists (names ignore case).'));
    const webRow = within(list).getByText('web').closest('[role="listitem"]') as HTMLElement;
    fireEvent.click(within(webRow).getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Rename web'), { target: { value: 'API' } });
    fireEvent.click(within(webRow).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A label with that name already exists');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mutations.LabelDelete!.mockResolvedValue(payload('labelDelete', { labelId: 'l-web' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete label web' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('removed from 2 items'));
    await waitFor(() => expect(mutations.LabelDelete).toHaveBeenCalledWith({ variables: { id: 'l-web' } }));
  });
});

describe('workflow states', () => {
  it('adds a typed state, renames, reorders by swapping positions, and shows why a delete was refused', async () => {
    render(<WorkflowStatesTab />);
    mutations.WorkflowStateCreate!.mockResolvedValue(payload('workflowStateCreate'));
    fireEvent.change(screen.getByLabelText('New state name'), { target: { value: 'Blocked' } });
    fireEvent.change(screen.getByLabelText('New state type'), { target: { value: 'STARTED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add state' }));
    await waitFor(() =>
      expect(mutations.WorkflowStateCreate).toHaveBeenCalledWith({ variables: { input: { teamId: 'team-1', name: 'Blocked', type: 'STARTED' } } }),
    );

    mutations.WorkflowStateUpdate!.mockResolvedValue(payload('workflowStateUpdate'));
    fireEvent.click(screen.getByRole('button', { name: 'Move In Progress up' }));
    await waitFor(() => expect(mutations.WorkflowStateUpdate).toHaveBeenCalledTimes(2));
    expect(mutations.WorkflowStateUpdate).toHaveBeenNthCalledWith(1, { variables: { id: 's-progress', input: { position: 1 } } });
    expect(mutations.WorkflowStateUpdate).toHaveBeenNthCalledWith(2, { variables: { id: 's-ready', input: { position: 2 } } });

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mutations.WorkflowStateDelete!.mockResolvedValue(refused('workflowStateDelete', 'This state still holds work; move that work to another state first.'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete state Ready' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still holds work');
  });
});

describe('admins', () => {
  it('lists people only and records a reason with each change', async () => {
    render(<AdminsTab />);
    const people = screen.getByRole('list', { name: 'People' });
    expect(within(people).queryByText('Bot')).not.toBeInTheDocument();

    vi.spyOn(window, 'prompt').mockReturnValue('covers on-call');
    mutations.UserSetGlobalRole!.mockResolvedValue(payload('userSetGlobalRole'));
    const boRow = within(people).getByText('Bo').closest('[role="listitem"]') as HTMLElement;
    fireEvent.click(within(boRow).getByRole('button', { name: 'Make admin' }));
    await waitFor(() =>
      expect(mutations.UserSetGlobalRole).toHaveBeenCalledWith({ variables: { userId: 'u-bo', role: 'ADMIN', reason: 'covers on-call' } }),
    );
    expect(await screen.findByText('Bo is now an admin.')).toBeInTheDocument();
  });
});

describe('server features, service actors and email', () => {
  it('shows each feature as on or off', () => {
    render(<ServerFeaturesTab />);
    const list = screen.getByRole('list', { name: 'Feature list' });
    expect(within(list).getByText('GitHub sync').parentElement).toHaveTextContent('On');
    expect(within(list).getByText('Email notifications').parentElement).toHaveTextContent('Off');
  });

  it('creates a service actor', async () => {
    const onCreated = vi.fn();
    mutations.ServiceActorCreate!.mockResolvedValue(payload('serviceActorCreate', { actor: { id: 'svc', handle: 'ci' } }));
    render(<ServiceActorForm onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Service name'), { target: { value: 'CI' } });
    fireEvent.change(screen.getByLabelText('Service handle'), { target: { value: 'ci' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create service' }));
    await waitFor(() =>
      expect(mutations.ServiceActorCreate).toHaveBeenCalledWith({ variables: { input: { name: 'CI', handle: 'ci', description: null } } }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('turns email notifications off', async () => {
    mutations.NotificationPreferencesUpdate!.mockResolvedValue(payload('notificationPreferencesUpdate', { emailNotifications: false }));
    render(<EmailNotificationsField />);
    fireEvent.click(screen.getByLabelText('Email notifications'));
    await waitFor(() =>
      expect(mutations.NotificationPreferencesUpdate).toHaveBeenCalledWith({ variables: { emailNotifications: false } }),
    );
    expect(await screen.findByText('Email notifications are off.')).toBeInTheDocument();
  });
});
