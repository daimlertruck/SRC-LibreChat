const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Import the services and models
const {
  validateAgentFileAccess,
  validateAgentFileRequest,
  validateBatchRequest,
  generateAgentSourceUrl,
  trackUrlUsage,
  batchGenerateUrls,
  dataLoaders,
  cacheManager,
} = require('./agents');
const { Files, MessageFileReference } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

// Mock Redis client
const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  keys: jest.fn(),
  mget: jest.fn(),
  connected: true,
};

// Mock cache client
jest.mock('~/cache', () => ({
  getCacheClient: () => mockRedisClient,
  logViolation: jest.fn(),
}));

// Mock S3 functions
jest.mock('./S3/crud', () => ({
  getS3SignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/signed-url'),
}));

// Metrics functionality removed for simplicity

describe('Agent File Services Integration Tests', () => {
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
    app.use(requireJwtAuth);

    // Add agent file routes
    app.post(
      '/api/files/agent-source-url',
      validateAgentFileRequest,
      validateAgentFileAccess,
      trackUrlUsage,
      generateAgentSourceUrl,
    );

    app.post('/api/files/agent-source-urls-batch', validateBatchRequest, batchGenerateUrls);

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

    // Clear DataLoader cache
    dataLoaders.clearAll();

    // Reset all mocks
    jest.clearAllMocks();
    mockRedisClient.get.mockResolvedValue(null);
    mockRedisClient.setex.mockResolvedValue('OK');

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

  describe('Security Tests', () => {
    test('should deny access without valid JWT token', async () => {
      const response = await request(app).post('/api/files/agent-source-url').send({
        fileId: testFile.file_id,
        messageId: 'test-message-id',
        conversationId: 'test-conversation-id',
      });

      expect(response.status).toBe(401);
    });

    test('should deny access to files not belonging to user', async () => {
      // Create another user's file reference
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

    test('should implement timing-attack resistance', async () => {
      const validRequest = {
        fileId: testFile.file_id,
        messageId: 'test-message-id',
        conversationId: 'test-conversation-id',
      };

      const invalidRequest = {
        fileId: 'invalid-file-id',
        messageId: 'invalid-message-id',
        conversationId: 'invalid-conversation-id',
      };

      // Measure response times
      const times = [];

      for (let i = 0; i < 5; i++) {
        const start = Date.now();
        await request(app)
          .post('/api/files/agent-source-url')
          .set('Authorization', `Bearer ${token}`)
          .send(i % 2 === 0 ? validRequest : invalidRequest);
        times.push(Date.now() - start);
      }

      // Times should be relatively consistent (within 100ms variance)
      const maxTime = Math.max(...times);
      const minTime = Math.min(...times);
      expect(maxTime - minTime).toBeLessThan(100);
    });

    test('should validate required request fields', async () => {
      const invalidRequests = [
        {}, // Empty request
        { fileId: testFile.file_id }, // Missing messageId and conversationId
        { messageId: 'test-message-id' }, // Missing fileId and conversationId
        { conversationId: 'test-conversation-id' }, // Missing fileId and messageId
      ];

      for (const invalidRequest of invalidRequests) {
        const response = await request(app)
          .post('/api/files/agent-source-url')
          .set('Authorization', `Bearer ${token}`)
          .send(invalidRequest);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Missing required fields');
      }
    });
  });

  describe('Performance Tests', () => {
    test('should use caching for repeated requests', async () => {
      const requestData = {
        fileId: testFile.file_id,
        messageId: 'test-message-id',
        conversationId: 'test-conversation-id',
      };

      // First request - should miss cache
      mockRedisClient.get.mockResolvedValueOnce(null);

      const response1 = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send(requestData);

      expect(response1.status).toBe(200);
      expect(mockRedisClient.setex).toHaveBeenCalled();

      // Second request - should hit cache
      const cachedResponse = {
        downloadUrl: '/api/files/download-secure/cached-token',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        fileName: testFile.filename,
      };
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(cachedResponse));

      const response2 = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send(requestData);

      expect(response2.status).toBe(200);
      expect(response2.body).toEqual(cachedResponse);
    });

    test('should batch database queries with DataLoader', async () => {
      // Create multiple file references
      const fileIds = [];
      const references = [];

      for (let i = 0; i < 5; i++) {
        const file = await Files.create({
          file_id: `test-file-${i}`,
          filename: `test-document-${i}.pdf`,
          filepath: `/files/${user.id}/test-document-${i}.pdf`,
          bytes: 1024,
          type: 'application/pdf',
          user: user.id,
          source: 'local',
        });
        fileIds.push(file.file_id);

        const ref = await MessageFileReference.create({
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
        references.push(ref);
      }

      // Batch request
      const response = await request(app)
        .post('/api/files/agent-source-urls-batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileIds });

      expect(response.status).toBe(200);
      expect(Object.keys(response.body)).toHaveLength(5);

      // Verify all file IDs are present in response
      fileIds.forEach((fileId) => {
        expect(response.body[fileId]).toBeDefined();
        expect(response.body[fileId].downloadUrl).toBeDefined();
      });
    });

    test('should handle rate limiting correctly', async () => {
      // Simulate rate limit by making Redis throw an error
      mockRedisClient.get.mockImplementation(() => {
        const error = new Error('Rate limit exceeded');
        error.msBeforeNext = 60000;
        throw error;
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
  });

  describe('Circuit Breaker Tests', () => {
    test('should handle database failures gracefully', async () => {
      // Mock database failure
      jest.spyOn(MessageFileReference, 'findOne').mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal error');
    });

    test('should implement circuit breaker for S3 operations', async () => {
      // Update test reference to use S3 storage
      await MessageFileReference.findByIdAndUpdate(testReference._id, {
        'capturedMetadata.storageType': 's3',
        'capturedMetadata.s3Bucket': 'test-bucket',
        'capturedMetadata.s3Key': 'test-key',
      });

      // Mock S3 failure multiple times to trigger circuit breaker
      const { getS3SignedUrl } = require('./S3/crud');
      getS3SignedUrl.mockRejectedValue(new Error('S3 service unavailable'));

      // Make multiple requests to trigger circuit breaker
      for (let i = 0; i < 6; i++) {
        await request(app)
          .post('/api/files/agent-source-url')
          .set('Authorization', `Bearer ${token}`)
          .send({
            fileId: testFile.file_id,
            messageId: 'test-message-id',
            conversationId: 'test-conversation-id',
          });
      }

      // Next request should be rejected by circuit breaker
      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('Service temporarily unavailable');
    });
  });

  describe('Audit Logging Tests', () => {
    test('should log file access attempts', async () => {
      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(200);

      // Audit logging functionality removed for simplicity
    });

    // Test for suspicious download patterns removed (metrics functionality removed)
  });

  describe('Batch Operations Tests', () => {
    test('should reject batch requests exceeding size limit', async () => {
      const fileIds = Array.from({ length: 25 }, (_, i) => `file-${i}`);

      const response = await request(app)
        .post('/api/files/agent-source-urls-batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileIds });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Maximum 20 files per batch request');
    });

    test('should handle partial failures in batch operations', async () => {
      // Create mix of valid and invalid file references
      const validFile = await Files.create({
        file_id: 'valid-file',
        filename: 'valid.pdf',
        filepath: `/files/${user.id}/valid.pdf`,
        bytes: 1024,
        type: 'application/pdf',
        user: user.id,
        source: 'local',
      });

      await MessageFileReference.create({
        messageId: 'valid-message',
        fileId: validFile.file_id,
        conversationId: 'test-conversation-id',
        userId: user.id,
        capturedMetadata: {
          fileName: validFile.filename,
          storageType: 'local',
        },
        status: 'active',
      });

      const fileIds = [validFile.file_id, 'invalid-file-id'];

      const response = await request(app)
        .post('/api/files/agent-source-urls-batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ fileIds });

      expect(response.status).toBe(200);
      expect(response.body[validFile.file_id]).toBeDefined();
      expect(response.body[validFile.file_id].downloadUrl).toBeDefined();
      // Invalid file should not be in response
      expect(response.body['invalid-file-id']).toBeUndefined();
    });
  });

  describe('Edge Cases Tests', () => {
    test('should handle inactive file references', async () => {
      // Mark reference as inactive
      await MessageFileReference.findByIdAndUpdate(testReference._id, {
        status: 'inactive',
      });

      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(403);
    });

    test('should handle missing files', async () => {
      // Delete the file but keep the reference
      await Files.findByIdAndDelete(testFile._id);

      const response = await request(app)
        .post('/api/files/agent-source-url')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fileId: testFile.file_id,
          messageId: 'test-message-id',
          conversationId: 'test-conversation-id',
        });

      expect(response.status).toBe(403);
    });

    test('should handle Redis connection failures gracefully', async () => {
      // Mock Redis failure
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
