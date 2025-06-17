const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');
const { RateLimiterRedis } = require('rate-limiter-flexible');

// Import the file routes
const filesRouter = require('./files');
const { Files, MessageFileReference } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

// Mock Redis client for rate limiting
const mockRedisClient = {
  consume: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  keys: jest.fn(),
  connected: true,
};

// Mock cache client
jest.mock('~/cache', () => ({
  getCacheClient: () => mockRedisClient,
  getLogStores: () => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  }),
}));

// Mock S3 functions
jest.mock('../../../server/services/Files/S3/crud', () => ({
  refreshS3FileUrls: jest.fn(),
}));

// Mock strategy functions
jest.mock('../../../server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn().mockReturnValue({
    getDownloadStream: jest.fn().mockReturnValue({
      pipe: jest.fn(),
    }),
  }),
}));

// Mock file processing functions
jest.mock('../../../server/services/Files/process', () => ({
  filterFile: jest.fn(),
  processFileUpload: jest.fn(),
  processDeleteRequest: jest.fn(),
  processAgentFileUpload: jest.fn(),
}));

describe('Files Route Integration Tests', () => {
  let mongoServer;
  let app;
  let user;
  let token;
  let testFile;
  let testReference;

  beforeAll(async () => {
    // Setup MongoDB Memory Server
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    // Setup Express app
    app = express();
    app.use(express.json());

    // Mock file strategy for the app
    app.locals.fileStrategy = 'local';
    app.locals.fileConfig = {
      maxFileSize: 1024 * 1024 * 10, // 10MB
      allowedTypes: ['pdf', 'txt', 'docx'],
    };

    // Add authentication middleware
    app.use('/api/files', requireJwtAuth);

    // Add files router
    app.use('/api/files', filesRouter);

    // Create test user
    user = {
      id: new mongoose.Types.ObjectId().toString(),
      email: 'test@example.com',
    };

    // Create JWT token
    token = jwt.sign(user, process.env.JWT_SECRET || 'test-secret');
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clear all collections before each test
    await Files.deleteMany({});
    await MessageFileReference.deleteMany({});

    // Reset all mocks
    jest.clearAllMocks();
    mockRedisClient.consume.mockResolvedValue(true);
    mockRedisClient.get.mockResolvedValue(null);

    // Create test data
    testFile = await Files.create({
      file_id: 'test-file-id',
      filename: 'test-document.pdf',
      filepath: `/files/${user.id}/test-document.pdf`,
      bytes: 1024,
      type: 'application/pdf',
      user: user.id,
      source: 'local',
    });

    testReference = await MessageFileReference.create({
      messageId: 'test-message-id',
      fileId: testFile.file_id,
      conversationId: 'test-conversation-id',
      userId: user.id,
      capturedMetadata: {
        fileName: testFile.filename,
        mimeType: testFile.type,
        fileSize: testFile.bytes,
        storageType: 'local',
      },
      relevance: 0.85,
      pages: [1, 2],
      status: 'active',
    });
  });

  describe('GET /api/files', () => {
    test('should return user files', async () => {
      const response = await request(app).get('/api/files').set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].file_id).toBe(testFile.file_id);
    });

    test('should handle S3 file URL refresh', async () => {
      app.locals.fileStrategy = 's3';

      const response = await request(app).get('/api/files').set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);

      // Verify S3 refresh was called
      const { refreshS3FileUrls } = require('../../../server/services/Files/S3/crud');
      expect(refreshS3FileUrls).toHaveBeenCalled();
    });

    test('should require authentication', async () => {
      const response = await request(app).get('/api/files');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/files/config', () => {
    test('should return file configuration', async () => {
      const response = await request(app)
        .get('/api/files/config')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(app.locals.fileConfig);
    });
  });

  describe('POST /api/files/agent-source-url', () => {
    test('should generate presigned URL for agent file', async () => {
      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(200);
      expect(response.body.downloadUrl).toBeDefined();
      expect(response.body.expiresAt).toBeDefined();
      expect(response.body.fileName).toBe(testFile.filename);
    });

    test('should respect rate limits', async () => {
      // Mock rate limiter to reject
      mockRedisClient.consume.mockRejectedValue({
        msBeforeNext: 60000,
      });

      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(429);
      expect(response.body.error).toBe('Too many requests');
      expect(response.body.retryAfter).toBeDefined();
    });

    test('should validate request parameters', async () => {
      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          // Missing messageId and conversationId
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required fields');
    });

    test('should deny access to unauthorized files', async () => {
      // Create file reference for different user
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await MessageFileReference.create({
        messageId: 'other-message-id',
        fileId: testFile.file_id,
        conversationId: 'other-conversation-id',
        userId: otherUserId,
        capturedMetadata: {
          fileName: testFile.filename,
          storageType: 'local',
        },
        status: 'active',
      });

      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'other-message-id',
          conversationId: 'other-conversation-id',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/files/agent-source-urls-batch', () => {
    beforeEach(async () => {
      // Create additional test files for batch testing
      for (let i = 1; i <= 3; i++) {
        const file = await Files.create({
          file_id: `test-file-${i}`,
          filename: `test-document-${i}.pdf`,
          filepath: `/files/${user.id}/test-document-${i}.pdf`,
          bytes: 1024,
          type: 'application/pdf',
          user: user.id,
          source: 'local',
        });

        await MessageFileReference.create({
          messageId: `test-message-${i}`,
          fileId: file.file_id,
          conversationId: 'test-conversation-id',
          userId: user.id,
          capturedMetadata: {
            fileName: file.filename,
            storageType: 'local',
          },
          status: 'active',
        });
      }
    });

    test('should generate batch presigned URLs', async () => {
      const fileIds = ['test-file-1', 'test-file-2', 'test-file-3'];

      const response = await request(app)
        .post('/api/files/agent-source-urls-batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileIds });

      expect(response.status).toBe(200);
      expect(Object.keys(response.body)).toHaveLength(3);

      fileIds.forEach((fileId) => {
        expect(response.body[fileId]).toBeDefined();
        expect(response.body[fileId].downloadUrl).toBeDefined();
      });
    });

    test('should reject batch requests exceeding size limit', async () => {
      const fileIds = Array.from({ length: 25 }, (_, i) => `file-${i}`);

      const response = await request(app)
        .post('/api/files/agent-source-urls-batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileIds });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Maximum 20 files per batch request');
    });

    test('should respect batch rate limits', async () => {
      // Mock batch rate limiter to reject
      mockRedisClient.consume.mockRejectedValue({
        msBeforeNext: 60000,
      });

      const response = await request(app)
        .post('/api/files/agent-source-urls-batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileIds: ['test-file-1'] });

      expect(response.status).toBe(429);
      expect(response.body.operation).toBe('agent_batch_download');
    });

    test('should validate batch request structure', async () => {
      const invalidRequests = [
        {}, // No fileIds
        { fileIds: 'not-an-array' }, // Invalid type
        { fileIds: [] }, // Empty array
      ];

      for (const invalidRequest of invalidRequests) {
        const response = await request(app)
          .post('/api/files/agent-source-urls-batch')
          .set('Authorization', `Bearer ${token}`)
          .send(invalidRequest);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('fileIds');
      }
    });
  });

  describe('Rate Limiting Integration', () => {
    test('should apply different rate limits for different operations', async () => {
      // Test single file rate limit
      mockRedisClient.consume
        .mockResolvedValueOnce(true) // First call succeeds
        .mockRejectedValueOnce({ msBeforeNext: 30000 }); // Second call hits limit

      // First request should succeed
      let response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(200);

      // Second request should be rate limited
      response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(429);
      expect(response.body.operation).toBe('agent_file_download');
    });

    test('should handle rate limiter initialization failures gracefully', async () => {
      // Mock cache client to return null (no Redis connection)
      const { getCacheClient } = require('~/cache');
      getCacheClient.mockReturnValueOnce(null);

      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      // Should still work without rate limiting
      expect(response.status).toBe(200);
    });
  });

  describe('Error Handling', () => {
    test('should handle database connection errors', async () => {
      // Mock database error
      jest.spyOn(Files, 'findOne').mockRejectedValue(new Error('Database connection lost'));

      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(500);
    });

    test('should handle invalid JWT tokens', async () => {
      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', 'Bearer invalid-token')
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(401);
    });

    test('should handle malformed request bodies', async () => {
      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('invalid-json');

      expect(response.status).toBe(400);
    });
  });

  describe('Cache Integration', () => {
    test('should use Redis cache for URL generation', async () => {
      // Mock cache hit
      const cachedResponse = {
        downloadUrl: '/api/files/download-secure/cached-token',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        fileName: testFile.filename,
      };

      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(cachedResponse));

      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(cachedResponse);

      // Verify cache was checked
      expect(mockRedisClient.get).toHaveBeenCalled();
    });

    test('should handle cache failures gracefully', async () => {
      // Mock cache error
      mockRedisClient.get.mockRejectedValue(new Error('Redis connection failed'));
      mockRedisClient.setex.mockRejectedValue(new Error('Redis connection failed'));

      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      // Should still work without cache
      expect(response.status).toBe(200);
      expect(response.body.downloadUrl).toBeDefined();
    });
  });
});
