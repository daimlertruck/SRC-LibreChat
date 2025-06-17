const request = require('supertest');
const express = require('express');

// Mock dependencies first
jest.mock('../../../models', () => ({
  Files: {
    findOne: jest.fn(),
  },
  MessageFileReference: {
    findOne: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));
jest.mock('../../../cache', () => ({
  getCacheClient: jest.fn(() => ({
    get: jest.fn(),
    setex: jest.fn(),
  })),
}));
jest.mock('../../../server/services/Files/S3/crud', () => ({
  getS3SignedUrl: jest.fn(),
}));
jest.mock('../../../config', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  validateAgentFileAccess,
  generateAgentSourceUrl,
} = require('../../../server/services/Files/agents');
const { Files, MessageFileReference } = require('../../../models');

describe('Agent File Services - Simplified', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock user middleware
    app.use((req, res, next) => {
      req.user = { id: 'test-user-id' };
      next();
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validateAgentFileAccess', () => {
    beforeEach(() => {
      app.post('/test', validateAgentFileAccess, (req, res) => {
        res.json({ success: true });
      });
    });

    it('should allow access for valid file reference', async () => {
      const mockReference = {
        _id: 'ref-id',
        messageId: 'msg-1',
        fileId: 'file-1',
        userId: 'test-user-id',
        conversationId: 'conv-1',
        status: 'active',
      };

      const mockFile = {
        file_id: 'file-1',
        filename: 'test.pdf',
      };

      MessageFileReference.findOne.mockResolvedValue(mockReference);
      Files.findOne.mockResolvedValue(mockFile);

      const response = await request(app).post('/test').send({
        fileId: 'file-1',
        messageId: 'msg-1',
        conversationId: 'conv-1',
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should deny access for non-existent file reference', async () => {
      MessageFileReference.findOne.mockResolvedValue(null);

      const response = await request(app).post('/test').send({
        fileId: 'file-1',
        messageId: 'msg-1',
        conversationId: 'conv-1',
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Access denied');
    });

    it('should handle missing file metadata', async () => {
      const mockReference = {
        _id: 'ref-id',
        messageId: 'msg-1',
        fileId: 'file-1',
        userId: 'test-user-id',
        conversationId: 'conv-1',
        status: 'active',
      };

      MessageFileReference.findOne.mockResolvedValue(mockReference);
      Files.findOne.mockResolvedValue(null);

      const response = await request(app).post('/test').send({
        fileId: 'file-1',
        messageId: 'msg-1',
        conversationId: 'conv-1',
      });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('File not found');
    });

    it('should handle database errors gracefully', async () => {
      MessageFileReference.findOne.mockRejectedValue(new Error('Database error'));

      const response = await request(app).post('/test').send({
        fileId: 'file-1',
        messageId: 'msg-1',
        conversationId: 'conv-1',
      });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal error');
    });
  });

  describe('generateAgentSourceUrl', () => {
    beforeEach(() => {
      app.post('/generate', validateAgentFileAccess, generateAgentSourceUrl);
    });

    it('should generate S3 URL for S3 files', async () => {
      const mockReference = {
        _id: 'ref-id',
        capturedMetadata: {
          storageType: 's3',
          s3Key: 'test-key',
          s3Bucket: 'test-bucket',
          fileName: 'test.pdf',
          mimeType: 'application/pdf',
        },
      };

      const mockFile = {
        file_id: 'file-1',
        filename: 'test.pdf',
      };

      MessageFileReference.findOne.mockResolvedValue(mockReference);
      Files.findOne.mockResolvedValue(mockFile);
      MessageFileReference.findByIdAndUpdate.mockResolvedValue({});

      const { getS3SignedUrl } = require('../../../server/services/Files/S3/crud');
      getS3SignedUrl.mockResolvedValue('https://s3.amazonaws.com/signed-url');

      const response = await request(app).post('/generate').send({
        fileId: 'file-1',
        messageId: 'msg-1',
        conversationId: 'conv-1',
      });

      expect(response.status).toBe(200);
      expect(response.body.downloadUrl).toBe('https://s3.amazonaws.com/signed-url');
      expect(response.body.fileName).toBe('test.pdf');
      expect(response.body.mimeType).toBe('application/pdf');
      expect(response.body.expiresAt).toBeDefined();
    });

    it('should generate local URL for local files', async () => {
      const mockReference = {
        _id: 'ref-id',
        capturedMetadata: {
          storageType: 'local',
          fileName: 'test.pdf',
          mimeType: 'application/pdf',
        },
      };

      const mockFile = {
        file_id: 'file-1',
        filename: 'test.pdf',
      };

      MessageFileReference.findOne.mockResolvedValue(mockReference);
      Files.findOne.mockResolvedValue(mockFile);
      MessageFileReference.findByIdAndUpdate.mockResolvedValue({});

      const response = await request(app).post('/generate').send({
        fileId: 'file-1',
        messageId: 'msg-1',
        conversationId: 'conv-1',
      });

      expect(response.status).toBe(200);
      expect(response.body.downloadUrl).toBe('/api/files/download/test-user-id/file-1');
      expect(response.body.fileName).toBe('test.pdf');
      expect(response.body.mimeType).toBe('application/pdf');
    });
  });
});
