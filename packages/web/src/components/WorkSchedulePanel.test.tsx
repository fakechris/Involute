import { MockedProvider } from '@apollo/client/testing/react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WORK_SCHEDULE_CLEAR_MUTATION, WORK_SCHEDULE_SET_MUTATION } from '../work/queries';
import { WorkSchedulePanel } from './WorkSchedulePanel';

const schedule = {
  id: 's1',
  cron: '0 9 * * 1-5',
  timezone: 'Asia/Shanghai',
  active: true,
  nextRunAt: '2026-11-05T01:00:00.000Z',
  lastFiredAt: null,
  round: 2,
  missedRounds: 1,
  agent: { id: 'a1', name: 'Claude Code', handle: 'claude-code' },
};

describe('WorkSchedulePanel (INV-1582)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the clock, the agent, the rounds and the misses', () => {
    render(
      <MockedProvider mocks={[]}>
        <WorkSchedulePanel workId="w1" schedule={schedule} canEdit={false} onChanged={() => {}} />
      </MockedProvider>,
    );
    expect(screen.getByText(/0 9 \* \* 1-5 · Asia\/Shanghai/)).toBeInTheDocument();
    expect(screen.getByText('@claude-code')).toBeInTheDocument();
    expect(screen.getByText(/2 fired/)).toBeInTheDocument();
    expect(screen.getByText(/1 in a row with no run/)).toBeInTheDocument();
    expect(screen.queryByText('Add schedule')).not.toBeInTheDocument();
  });

  it('saves a schedule a person fills in and tells the page', async () => {
    const onChanged = vi.fn();
    const mocks = [
      {
        request: {
          query: WORK_SCHEDULE_SET_MUTATION,
          variables: { input: { workId: 'w1', cron: '0 9 * * 1-5', timezone: 'UTC', agent: '@claude-code' } },
        },
        result: { data: { workScheduleSet: { success: true, message: null, schedule: { ...schedule, timezone: 'UTC' } } } },
      },
    ];
    render(
      <MockedProvider mocks={mocks}>
        <WorkSchedulePanel workId="w1" schedule={null} canEdit onChanged={onChanged} />
      </MockedProvider>,
    );
    fireEvent.click(screen.getByText('Add schedule'));
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: '@claude-code' } });
    fireEvent.click(screen.getByText('Save schedule'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows the server refusal instead of pretending it saved', async () => {
    const onChanged = vi.fn();
    const mocks = [
      {
        request: {
          query: WORK_SCHEDULE_SET_MUTATION,
          variables: { input: { workId: 'w1', cron: 'bad', timezone: 'UTC', agent: '@claude-code' } },
        },
        result: { data: { workScheduleSet: { success: false, message: 'Cron needs five fields.', schedule: null } } },
      },
    ];
    render(
      <MockedProvider mocks={mocks}>
        <WorkSchedulePanel workId="w1" schedule={null} canEdit onChanged={onChanged} />
      </MockedProvider>,
    );
    fireEvent.click(screen.getByText('Add schedule'));
    fireEvent.change(screen.getByLabelText('Cron'), { target: { value: 'bad' } });
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: '@claude-code' } });
    fireEvent.click(screen.getByText('Save schedule'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cron needs five fields.');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('removes the schedule after the person confirms', async () => {
    const onChanged = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const mocks = [
      {
        request: { query: WORK_SCHEDULE_CLEAR_MUTATION, variables: { workId: 'w1' } },
        result: { data: { workScheduleClear: { success: true, message: null, cleared: true } } },
      },
    ];
    render(
      <MockedProvider mocks={mocks}>
        <WorkSchedulePanel workId="w1" schedule={schedule} canEdit onChanged={onChanged} />
      </MockedProvider>,
    );
    fireEvent.click(screen.getByText('Remove schedule'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
