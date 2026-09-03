import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentStatisticsResponse } from 'librechat-data-provider';
import StatisticsPanel from './Panel';

const mockSetActivePanel = jest.fn();
const mockUseAgentStatisticsQuery = jest.fn();

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ agent_id: 'agent_1', setActivePanel: mockSetActivePanel }),
}));
jest.mock('~/data-provider', () => ({
  useAgentStatisticsQuery: (...args: unknown[]) => mockUseAgentStatisticsQuery(...args),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const data: AgentStatisticsResponse = {
  range: { from: '2026-09-01', to: '2026-09-01', days: 1 },
  summary: {
    conversations: 2,
    responses: 3,
    successfulResponses: 2,
    failedResponses: 1,
    interruptedResponses: 0,
    successRate: 2 / 3,
    thumbsUp: 1,
    thumbsDown: 1,
    ratedResponses: 2,
    ratingCoverage: 2 / 3,
    feedbackTags: { accurate_reliable: 1 },
    inputTokens: 10,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    outputTokens: 5,
    totalTokens: 18,
    costAvailable: true,
    costUSD: 0.01,
    averageDailyUniqueUsers: 2,
    lastUsedAt: '2026-09-01T10:00:00.000Z',
  },
  daily: [
    {
      date: '2026-09-01',
      conversations: 2,
      successfulResponses: 2,
      failedResponses: 1,
      interruptedResponses: 0,
      responses: 3,
      thumbsUp: 1,
      thumbsDown: 1,
      feedbackTags: { accurate_reliable: 1 },
      inputTokens: 10,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      outputTokens: 5,
      totalTokens: 18,
      costAvailable: true,
      costUSD: 0.01,
      uniqueUsers: 2,
      lastUsedAt: '2026-09-01T10:00:00.000Z',
    },
  ],
  recentFailures: [
    {
      occurredAt: '2026-09-01T09:00:00.000Z',
      source: 'tool',
      message: 'MCP server did not respond',
    },
  ],
};

describe('StatisticsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAgentStatisticsQuery.mockReturnValue({
      data,
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it('renders the summary, daily trend, feedback, and failures', () => {
    render(<StatisticsPanel />);
    expect(screen.getByText('com_ui_agent_statistics_unique_users')).toBeInTheDocument();
    expect(screen.getByText('com_ui_feedback_tag_accurate_reliable')).toBeInTheDocument();
    expect(screen.getByText('MCP server did not respond')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(screen.getAllByText('2026-09-01').length).toBeGreaterThan(0);
  });

  it('hides previous-range data while the requested range loads', () => {
    mockUseAgentStatisticsQuery.mockReturnValue({
      data,
      isLoading: false,
      isPreviousData: true,
      isError: false,
      error: null,
    });

    render(<StatisticsPanel />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('does not round a sub-cent cost down to zero', () => {
    mockUseAgentStatisticsQuery.mockReturnValue({
      data: {
        ...data,
        summary: { ...data.summary, costUSD: 0.004 },
        daily: data.daily.map((day) => ({ ...day, costUSD: 0.004 })),
      },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<StatisticsPanel />);

    expect(screen.getAllByText('<$0.01')).toHaveLength(3);
  });

  it('supports preset, single-day, and custom range queries', () => {
    render(<StatisticsPanel />);
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    expect(mockUseAgentStatisticsQuery).toHaveBeenLastCalledWith(
      'agent_1',
      { range: '7d' },
      { enabled: true },
    );

    fireEvent.change(screen.getByLabelText('com_ui_agent_statistics_single_day_utc'), {
      target: { value: '2026-09-01' },
    });
    expect(mockUseAgentStatisticsQuery).toHaveBeenLastCalledWith(
      'agent_1',
      { date: '2026-09-01' },
      { enabled: true },
    );

    fireEvent.change(screen.getByLabelText('com_ui_agent_statistics_from_utc'), {
      target: { value: '2026-08-30' },
    });
    fireEvent.change(screen.getByLabelText('com_ui_agent_statistics_to_utc'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_statistics_apply_range' }));
    expect(mockUseAgentStatisticsQuery).toHaveBeenLastCalledWith(
      'agent_1',
      { from: '2026-08-30', to: '2026-09-01' },
      { enabled: true },
    );
  });

  it.each([
    [{ isLoading: true, isError: false, data: undefined, error: null }, 'status'],
    [
      {
        isLoading: false,
        isError: false,
        data: {
          ...data,
          summary: {
            ...data.summary,
            conversations: 0,
            responses: 0,
            thumbsUp: 0,
            thumbsDown: 0,
            totalTokens: 0,
            costUSD: 0,
            averageDailyUniqueUsers: 0,
          },
        },
        error: null,
      },
      'com_ui_agent_statistics_empty',
    ],
    [
      { isLoading: false, isError: true, data: undefined, error: new Error('failed') },
      'com_ui_agent_statistics_error',
    ],
  ])('renders distinct loading, empty, and error states', (result, expected) => {
    mockUseAgentStatisticsQuery.mockReturnValue(result);
    render(<StatisticsPanel />);
    if (expected === 'status') expect(screen.getByRole('status')).toBeInTheDocument();
    else expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
