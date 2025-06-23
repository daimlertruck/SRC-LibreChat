const { processAgentResponse } = require('../../../app/clients/agents/processAgentResponse');
const { Files } = require('../../../models');
const { getCustomConfig } = require('../../../server/services/Config/getCustomConfig');

// Mock dependencies
jest.mock('../../../models', () => ({
  Files: {
    find: jest.fn(),
  },
}));

jest.mock('../../../server/services/Config/getCustomConfig', () => ({
  getCustomConfig: jest.fn(),
}));

jest.mock('../../../config', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('processAgentResponse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return response unchanged when no messageId', async () => {
    const response = { messageId: null };
    const result = await processAgentResponse(response, 'user123', 'conv123');
    expect(result).toBe(response);
  });

  it('should return response unchanged when no file search results', async () => {
    getCustomConfig.mockResolvedValue({ endpoints: { agents: { maxFileSearchResults: 10 } } });

    const response = { messageId: 'msg123' };
    const contentParts = [{ type: 'text', content: 'some text' }];

    const result = await processAgentResponse(response, 'user123', 'conv123', contentParts);
    expect(result).toBe(response);
  });

  it('should process file search results and create attachments', async () => {
    getCustomConfig.mockResolvedValue({
      endpoints: { agents: { maxFileSearchResults: 10 } },
      fileStrategy: 's3',
    });

    Files.find.mockResolvedValue([
      {
        file_id: 'file123',
        source: 's3',
        s3Bucket: 'test-bucket',
        s3Key: 'uploads/user123/file123__test.pdf',
      },
    ]);

    const response = { messageId: 'msg123' };
    const contentParts = [
      {
        type: 'tool_call',
        tool_call: {
          name: 'file_search',
          output: `File: test.pdf
File_ID: file123
Relevance: 0.8
Page: 1
Storage_Type: s3
S3_Bucket: test-bucket
S3_Key: uploads/user123/file123__test.pdf
Content: Test content`,
        },
      },
    ];

    const result = await processAgentResponse(response, 'user123', 'conv123', contentParts);

    expect(result.attachments).toBeDefined();
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe('file_search');
    expect(result.attachments[0].file_search.sources).toBeDefined();
    expect(result.attachments[0].file_search.sources).toHaveLength(1);

    const source = result.attachments[0].file_search.sources[0];
    expect(source.fileId).toBe('file123');
    expect(source.fileName).toBe('test.pdf');
    expect(source.metadata.storageType).toBe('s3');
    expect(source.metadata.s3Bucket).toBe('test-bucket');
    expect(source.metadata.s3Key).toBe('uploads/user123/file123__test.pdf');
  });

  it('should use configured fileStrategy when file metadata is missing', async () => {
    getCustomConfig.mockResolvedValue({
      endpoints: { agents: { maxFileSearchResults: 10 } },
      fileStrategy: 's3',
    });

    Files.find.mockResolvedValue([
      {
        file_id: 'file123',
        // source is undefined, should fallback to fileStrategy
        s3Bucket: null,
        s3Key: null,
      },
    ]);

    const response = { messageId: 'msg123' };
    const contentParts = [
      {
        type: 'tool_call',
        tool_call: {
          name: 'file_search',
          output: `File: test.pdf
File_ID: file123
Relevance: 0.8
Content: Test content`,
        },
      },
    ];

    const result = await processAgentResponse(response, 'user123', 'conv123', contentParts);

    const source = result.attachments[0].file_search.sources[0];
    expect(source.metadata.storageType).toBe('s3'); // Should use fileStrategy
  });

  it('should handle file diversity by including at least one result per file', async () => {
    getCustomConfig.mockResolvedValue({
      endpoints: { agents: { maxFileSearchResults: 3 } },
      fileStrategy: 's3',
    });

    Files.find.mockResolvedValue([
      { file_id: 'file1', source: 's3', s3Bucket: 'bucket', s3Key: 'key1' },
      { file_id: 'file2', source: 's3', s3Bucket: 'bucket', s3Key: 'key2' },
    ]);

    const response = { messageId: 'msg123' };
    const contentParts = [
      {
        type: 'tool_call',
        tool_call: {
          name: 'file_search',
          output: `File: test1.pdf
File_ID: file1
Relevance: 0.9
Content: High relevance content

---

File: test1.pdf  
File_ID: file1
Relevance: 0.7
Content: Lower relevance content

---

File: test2.pdf
File_ID: file2
Relevance: 0.8
Content: Different file content`,
        },
      },
    ];

    const result = await processAgentResponse(response, 'user123', 'conv123', contentParts);

    const sources = result.attachments[0].file_search.sources;
    expect(sources).toHaveLength(3); // All 3 results should be included

    // Should have both files represented
    const fileIds = sources.map((s) => s.fileId);
    expect(fileIds).toContain('file1');
    expect(fileIds).toContain('file2');
  });
});
