const {
  validateAgentFileAccess,
  validateAgentFileRequest,
  generateAgentSourceUrl,
} = require('../../../server/services/Files/agents');
const { Files } = require('../../../models');
const { Message } = require('../../../db/models');
const { Tools } = require('librechat-data-provider');

// Mock dependencies
jest.mock('../../../models', () => ({
  Files: {
    findOne: jest.fn(),
  },
}));

jest.mock('../../../db/models', () => ({
  Message: {
    findOne: jest.fn(),
  },
}));

jest.mock('../../../server/services/Files/S3/crud', () => ({
  getS3URL: jest.fn(),
}));

jest.mock('../../../server/utils/files', () => ({
  cleanFileName: jest.fn((name) => name),
}));

jest.mock('../../../server/utils/url', () => ({
  createAbsoluteUrl: jest.fn((req, path) => `http://localhost${path}`),
}));

jest.mock('../../../config', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('Agent File Services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateAgentFileRequest', () => {
    it('should pass validation with all required fields', () => {
      const req = {
        body: {
          fileId: 'file123',
          messageId: 'msg123',
          conversationId: 'conv123',
        },
      };
      const res = {};
      const next = jest.fn();

      validateAgentFileRequest(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should return 400 when required fields are missing', () => {
      const req = { body: {} };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      validateAgentFileRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing required fields: fileId, messageId, conversationId',
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('validateAgentFileAccess', () => {
    it('should grant access when file is in message attachments', async () => {
      const req = {
        body: {
          fileId: 'file123',
          messageId: 'msg123',
          conversationId: 'conv123',
        },
        user: { id: 'user123' },
      };
      const res = {};
      const next = jest.fn();

      Message.findOne.mockResolvedValue({
        messageId: 'msg123',
        attachments: [
          {
            type: Tools.file_search,
            [Tools.file_search]: {
              sources: [{ fileId: 'file123', fileName: 'test.pdf' }],
            },
          },
        ],
      });

      Files.findOne.mockResolvedValue({
        file_id: 'file123',
        source: 's3',
        s3Bucket: 'test-bucket',
        s3Key: 'uploads/user123/file123__test.pdf',
      });

      await validateAgentFileAccess(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.file).toBeDefined();
      expect(req.message).toBeDefined();
    });

    it('should deny access when message is not found', async () => {
      const req = {
        body: {
          fileId: 'file123',
          messageId: 'msg123',
          conversationId: 'conv123',
        },
        user: { id: 'user123' },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      Message.findOne.mockResolvedValue(null);

      await validateAgentFileAccess(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should deny access when file is not in message attachments', async () => {
      const req = {
        body: {
          fileId: 'file123',
          messageId: 'msg123',
          conversationId: 'conv123',
        },
        user: { id: 'user123' },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      Message.findOne.mockResolvedValue({
        messageId: 'msg123',
        attachments: [
          {
            type: Tools.file_search,
            [Tools.file_search]: {
              sources: [{ fileId: 'different-file', fileName: 'other.pdf' }],
            },
          },
        ],
      });

      await validateAgentFileAccess(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 404 when file metadata is not found', async () => {
      const req = {
        body: {
          fileId: 'file123',
          messageId: 'msg123',
          conversationId: 'conv123',
        },
        user: { id: 'user123' },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      Message.findOne.mockResolvedValue({
        messageId: 'msg123',
        attachments: [
          {
            type: Tools.file_search,
            [Tools.file_search]: {
              sources: [{ fileId: 'file123', fileName: 'test.pdf' }],
            },
          },
        ],
      });

      Files.findOne.mockResolvedValue(null);

      await validateAgentFileAccess(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'File not found' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('generateAgentSourceUrl', () => {
    it('should generate S3 URL for S3-stored files', async () => {
      const { getS3URL } = require('../../../server/services/Files/S3/crud');

      const req = {
        body: { fileId: 'file123' },
        user: { id: 'user123' },
        file: {
          file_id: 'file123',
          source: 's3',
          metadata: {
            s3Bucket: 'test-bucket',
            s3Key: 'uploads/user123/file123__test.pdf',
          },
        },
        message: {
          attachments: [
            {
              type: Tools.file_search,
              [Tools.file_search]: {
                sources: [
                  {
                    fileId: 'file123',
                    fileName: 'test.pdf',
                    metadata: {
                      storageType: 's3',
                      s3Bucket: 'test-bucket',
                      s3Key: 'uploads/user123/file123__test.pdf',
                    },
                  },
                ],
              },
            },
          ],
        },
      };
      const res = {
        json: jest.fn(),
      };

      getS3URL.mockResolvedValue('https://s3.amazonaws.com/presigned-url');

      await generateAgentSourceUrl(req, res);

      expect(getS3URL).toHaveBeenCalledWith({
        userId: 'user123',
        fileName: 'file123__test.pdf',
        basePath: 'uploads',
        customFilename: 'test.pdf',
      });

      expect(res.json).toHaveBeenCalledWith({
        downloadUrl: 'https://s3.amazonaws.com/presigned-url',
        expiresAt: expect.any(String),
        fileName: 'test.pdf',
        mimeType: 'application/octet-stream',
      });
    });

    it('should generate local URL for local files', async () => {
      const { createAbsoluteUrl } = require('../../../server/utils/url');

      const req = {
        body: { fileId: 'file123' },
        user: { id: 'user123' },
        file: {
          file_id: 'file123',
          source: 'local',
          type: 'application/pdf',
        },
        message: {
          attachments: [
            {
              type: Tools.file_search,
              [Tools.file_search]: {
                sources: [
                  {
                    fileId: 'file123',
                    fileName: 'test.pdf',
                    metadata: {
                      storageType: 'local',
                    },
                  },
                ],
              },
            },
          ],
        },
      };
      const res = {
        json: jest.fn(),
      };

      await generateAgentSourceUrl(req, res);

      expect(createAbsoluteUrl).toHaveBeenCalledWith(req, '/api/files/download/user123/file123');

      expect(res.json).toHaveBeenCalledWith({
        downloadUrl: 'http://localhost/api/files/download/user123/file123',
        expiresAt: expect.any(String),
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      });
    });

    it('should return 404 when file source is not found in message', async () => {
      const req = {
        body: { fileId: 'file123' },
        user: { id: 'user123' },
        file: { file_id: 'file123' },
        message: {
          attachments: [
            {
              type: Tools.file_search,
              [Tools.file_search]: {
                sources: [
                  {
                    fileId: 'different-file',
                    fileName: 'other.pdf',
                  },
                ],
              },
            },
          ],
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await generateAgentSourceUrl(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'File source not found in message' });
    });
  });
});
