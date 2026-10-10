import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';

// INV-793: a project's GitHub repository and reference alias (LUM-398 for
// lumenbox) are edited on the Projects page, not through raw GraphQL.

beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.open = false; };
});

const project = {
  ...getIssue('issue-1'),
  id: 'proj-1',
  identifier: 'INV-96',
  kind: 'PROJECT' as const,
  title: 'LumenBox project',
  repository: 'fakechris/lumenbox',
  alias: null,
  webOrigins: ['https://lumen.example.com'],
  children: { nodes: [] },
};

const data = { ...boardQueryResult, issues: { ...boardQueryResult.issues, nodes: [...boardQueryResult.issues.nodes, project] } };

function mockMutations(handlers: Record<string, ReturnType<typeof vi.fn>>) {
  apolloMocks.useMutation.mockImplementation((document: { loc?: { source: { body: string } } }) => {
    const body = document?.loc?.source.body ?? '';
    const name = Object.keys(handlers).find((field) => body.includes(`${field}(`));
    return [name ? handlers[name] : vi.fn(), { loading: false }];
  });
}

async function openEdit() {
  renderApp({ data, loading: false }, ['/projects']);
  fireEvent.click(await screen.findByText('LumenBox project'));
  fireEvent.click(await screen.findByTitle('Project actions'));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return screen.getByRole('dialog', { hidden: true });
}

describe('project routing settings', () => {
  it('sets the alias and moves the repository without cascading when asked', async () => {
    const issueUpdate = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true, message: null, issue: null } } });
    mockMutations({ issueUpdate });
    const dialog = await openEdit();

    fireEvent.change(within(dialog).getByLabelText('Reference alias'), { target: { value: 'lum' } });
    expect(within(dialog).getByText('LUM-123')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('GitHub repository'), { target: { value: 'fakechris/lumenbox-next' } });
    fireEvent.click(within(dialog).getByLabelText(/Move the project/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));

    await waitFor(() => expect(issueUpdate).toHaveBeenCalled());
    expect(issueUpdate.mock.calls[0]![0].variables).toEqual({
      id: 'proj-1',
      input: expect.objectContaining({ alias: 'LUM', repository: 'fakechris/lumenbox-next', cascadeRepository: false }),
    });
  });

  it('keeps the dialog open with the reason when the server refuses', async () => {
    const issueUpdate = vi.fn().mockResolvedValue({
      data: { issueUpdate: { success: false, issue: null, message: "That alias is already a team key or another project's alias." } },
    });
    mockMutations({ issueUpdate });
    const dialog = await openEdit();

    fireEvent.change(within(dialog).getByLabelText('Reference alias'), { target: { value: 'INV' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));

    expect(await within(dialog).findByRole('alert', { hidden: true })).toHaveTextContent('already a team key');
    expect((dialog as HTMLDialogElement).open).toBe(true);
    // Unchanged fields are not sent.
    expect(issueUpdate.mock.calls[0]![0].variables.input).not.toHaveProperty('repository');
  });

  it('checks the format before saving', async () => {
    const issueUpdate = vi.fn();
    mockMutations({ issueUpdate });
    const dialog = await openEdit();

    fireEvent.change(within(dialog).getByLabelText('Reference alias'), { target: { value: 'L1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));

    expect(await within(dialog).findByRole('alert', { hidden: true })).toHaveTextContent('2 to 10 letters');
    expect(issueUpdate).not.toHaveBeenCalled();
  });

  it('creates a project with its repository, then sets the alias', async () => {
    const issueCreate = vi.fn().mockResolvedValue({ data: { issueCreate: { success: true, message: null, issue: { ...project, id: 'proj-new' } } } });
    const issueUpdate = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true, message: null, issue: null } } });
    mockMutations({ issueCreate, issueUpdate });
    renderApp({ data, loading: false }, ['/projects']);

    fireEvent.click((await screen.findAllByRole('button', { name: /New project/ }))[0]!);
    const dialog = screen.getByRole('dialog', { hidden: true });
    fireEvent.change(within(dialog).getByPlaceholderText('Project name'), { target: { value: 'fakechris/widgets' } });
    fireEvent.change(within(dialog).getByLabelText('GitHub repository'), { target: { value: 'fakechris/widgets' } });
    fireEvent.change(within(dialog).getByLabelText('Reference alias'), { target: { value: 'wid' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create', hidden: true }));

    await waitFor(() => expect(issueUpdate).toHaveBeenCalled());
    expect(issueCreate.mock.calls[0]![0].variables.input).toMatchObject({ kind: 'PROJECT', repository: 'fakechris/widgets' });
    expect(issueUpdate.mock.calls[0]![0].variables).toEqual({ id: 'proj-new', input: { alias: 'WID' } });
  });

  it('sets the web origins the capture extension routes by (INV-1146)', async () => {
    const issueUpdate = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true, message: null, issue: null } } });
    mockMutations({ issueUpdate });
    const dialog = await openEdit();

    fireEvent.change(within(dialog).getByLabelText('Web origins'), { target: { value: 'https://lumen.example.com,\nhttp://localhost:5173' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));

    await waitFor(() => expect(issueUpdate).toHaveBeenCalled());
    expect(issueUpdate.mock.calls[0]![0].variables.input).toMatchObject({ webOrigins: ['https://lumen.example.com', 'http://localhost:5173'] });
    expect(issueUpdate.mock.calls[0]![0].variables.input).not.toHaveProperty('alias');
  });

  it('shows the server refusal of a web origin and keeps the dialog open', async () => {
    const issueUpdate = vi.fn().mockResolvedValue({
      data: { issueUpdate: { success: false, issue: null, message: 'That web origin already belongs to another project.' } },
    });
    mockMutations({ issueUpdate });
    const dialog = await openEdit();

    fireEvent.change(within(dialog).getByLabelText('Web origins'), { target: { value: 'https://taken.example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));

    expect(await within(dialog).findByRole('alert', { hidden: true })).toHaveTextContent('already belongs to another project');
    expect((dialog as HTMLDialogElement).open).toBe(true);
  });

  it('leaves unchanged web origins out of the save', async () => {
    const issueUpdate = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true, message: null, issue: null } } });
    mockMutations({ issueUpdate });
    const dialog = await openEdit();
    expect(within(dialog).getByLabelText('Web origins')).toHaveValue('https://lumen.example.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));
    await waitFor(() => expect(issueUpdate).toHaveBeenCalled());
    expect(issueUpdate.mock.calls[0]![0].variables.input).not.toHaveProperty('webOrigins');
  });

  it('turns on auto-accept of verified bug fixes for the project (INV-1075)', async () => {
    const issueUpdate = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true, message: null, issue: null } } });
    mockMutations({ issueUpdate });
    const dialog = await openEdit();
    const toggle = within(dialog).getByLabelText('Auto-accept verified bug fixes');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));
    await waitFor(() => expect(issueUpdate).toHaveBeenCalled());
    expect(issueUpdate.mock.calls[0]![0].variables.input).toMatchObject({ autoAcceptBugs: true });
  });
});
