const mockGetAgentStatistics = jest.fn();
const mockGetAgent = jest.fn();
const mockGetAgentMetricDailyRange = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@librechat/api', () => ({ getAgentStatistics: mockGetAgentStatistics }));
jest.mock('@librechat/data-schemas', () => ({ logger: { error: mockLoggerError } }));
jest.mock('~/models', () => ({
  getAgent: mockGetAgent,
  getAgentMetricDailyRange: mockGetAgentMetricDailyRange,
}));

const statistics = require('./statistics');

function response() {
  return {
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function request(query = { date: '2026-09-01' }) {
  return {
    params: { id: 'agent-1' },
    query,
    user: { id: 'user-1', tenantId: 'tenant-1' },
    config: { endpoints: { agents: { statistics: true } } },
  };
}

describe('agent statistics controller', () => {
  beforeEach(() => {
    mockGetAgent.mockResolvedValue({
      id: 'agent-1',
      tenantId: 'tenant-1',
      statistics_enabled: true,
    });
    mockGetAgentStatistics.mockResolvedValue({ range: {}, summary: {}, daily: [] });
  });

  it('passes only server-resolved scope and returns no-store data', async () => {
    const req = request();
    const res = response();

    await statistics(req, res);

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(mockGetAgentStatistics).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        range: expect.objectContaining({ from: '2026-09-01', to: '2026-09-01', days: 1 }),
      }),
      { getAgentMetricDailyRange: mockGetAgentMetricDailyRange },
    );
    expect(res.json).toHaveBeenCalledWith({ range: {}, summary: {}, daily: [] });
  });

  it('rejects invalid query combinations before database access', async () => {
    const res = response();
    await statistics(request({ date: '2026-09-01', range: '7d' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockGetAgentStatistics).not.toHaveBeenCalled();
  });

  it('returns a generic not-found response for disabled statistics', async () => {
    mockGetAgentStatistics.mockResolvedValueOnce(null);
    const res = response();
    await statistics(request(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Agent statistics not found' });
  });

  it('turns storage failures into a controlled unavailable response', async () => {
    mockGetAgentStatistics.mockRejectedValueOnce(new Error('database detail'));
    const res = response();
    await statistics(request(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Agent statistics are temporarily unavailable',
    });
    expect(mockLoggerError).toHaveBeenCalledWith('[AgentStatistics] Read failed');
  });
});
