const express = require('express');
const request = require('supertest');

const mockOrder = [];
const mockAccessOptions = [];
let mockAllowResource = true;
const mockCanAccessAgentResource = jest.fn((options) => {
  mockAccessOptions.push(options);
  return (_req, res, next) => {
    mockOrder.push('resource');
    if (!mockAllowResource) return res.status(403).json({ message: 'Forbidden' });
    next();
  };
});

jest.mock('@librechat/api', () => ({
  generateCheckAccess: jest.fn(() => (_req, _res, next) => {
    mockOrder.push('agent');
    next();
  }),
}));
jest.mock('~/server/middleware', () => ({
  configMiddleware: (req, _res, next) => {
    req.config = { endpoints: { agents: { statistics: true } } };
    mockOrder.push('config');
    next();
  },
  canAccessAgentResource: mockCanAccessAgentResource,
}));
jest.mock('~/server/middleware/limiters', () => ({
  agentStatisticsLimiter: (_req, _res, next) => {
    mockOrder.push('limiter');
    next();
  },
}));
jest.mock('~/server/controllers/agents/statistics', () => (req, res) => {
  mockOrder.push('controller');
  res.json({ id: req.params.id });
});
jest.mock(
  '~/server/controllers/agents/v1',
  () => new Proxy({}, { get: () => (_req, res) => res.status(204).end() }),
);
jest.mock('~/models', () => ({ getRoleByName: jest.fn() }));
jest.mock('./actions', () => require('express').Router());
jest.mock('./tools', () => require('express').Router());

const { v1: router } = require('./v1');

describe('agent statistics route', () => {
  beforeEach(() => {
    mockOrder.length = 0;
    mockAllowResource = true;
  });

  it('orders edit authorization before limiting, config, and the controller', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1' };
      next();
    });
    app.use(router);

    const response = await request(app).get('/agent-1/statistics');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'agent-1' });
    expect(mockOrder).toEqual(['agent', 'resource', 'limiter', 'config', 'controller']);
    expect(mockAccessOptions).toContainEqual({ requiredPermission: 2, resourceIdParam: 'id' });
  });

  it('does not limit, load configuration, or execute the controller when edit access is denied', async () => {
    mockAllowResource = false;
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1' };
      next();
    });
    app.use(router);

    const response = await request(app).get('/agent-1/statistics');

    expect(response.status).toBe(403);
    expect(mockOrder).toEqual(['agent', 'resource']);
  });
});
