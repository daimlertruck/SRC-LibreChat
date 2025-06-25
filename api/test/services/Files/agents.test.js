const {
  validateAgentFileRequest,
  generateAgentSourceUrl,
} = require('../../../server/middleware/validate/agentFileAccess');
const { Tools } = require('librechat-data-provider');

// No additional mocks needed for remaining tests

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

  describe('generateAgentSourceUrl', () => {
    it('should generate local URL for local files', async () => {
      const req = {
        protocol: 'http',
        get: jest.fn().mockReturnValue('localhost:3080'),
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
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await generateAgentSourceUrl(req, res);

      expect(req.get).toHaveBeenCalledWith('host');

      expect(res.json).toHaveBeenCalledWith({
        downloadUrl: 'http://localhost:3080/api/files/download/user123/file123',
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
