const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({ limiterCache: jest.fn(() => undefined) }));

const { agentStatisticsLimiter } = require('./agentStatisticsLimiter');

describe('agentStatisticsLimiter', () => {
  it('limits each authenticated tenant principal independently', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = {
        id: req.get('x-user-id'),
        tenantId: req.get('x-tenant-id'),
      };
      next();
    });
    app.get('/', agentStatisticsLimiter, (_req, res) => res.sendStatus(204));

    for (let count = 0; count < 60; count += 1) {
      const response = await request(app)
        .get('/')
        .set('x-user-id', 'user-1')
        .set('x-tenant-id', 'tenant-1');
      expect(response.status).toBe(204);
    }

    const limited = await request(app)
      .get('/')
      .set('x-user-id', 'user-1')
      .set('x-tenant-id', 'tenant-1');
    const otherTenant = await request(app)
      .get('/')
      .set('x-user-id', 'user-1')
      .set('x-tenant-id', 'tenant-2');

    expect(limited.status).toBe(429);
    expect(otherTenant.status).toBe(204);
  });
});
