const { MessageFileReference } = require('~/models');
const { logger } = require('~/config');

/**
 * Processes agent response to extract and capture file references from tool calls
 * @param {Object} response - The agent response object
 * @param {string} userId - User ID
 * @param {string} conversationId - Conversation ID
 * @param {Array} contentParts - Content parts from the agent response
 * @param {import('http').ServerResponse} [res] - Server response for streaming
 * @returns {Object} Processed response with attachments
 */
const processAgentResponse = async (
  response,
  userId,
  conversationId,
  contentParts = [],
  res = null,
) => {
  try {
    logger.debug('[processAgentResponse] Starting processing', {
      messageId: response.messageId,
      userId,
      conversationId,
      contentPartsCount: contentParts.length,
    });

    if (!response.messageId) {
      logger.warn('[processAgentResponse] No messageId in response');
      return response;
    }

    // Look for file search tool calls in content parts
    const fileSearchResults = [];

    for (const part of contentParts) {
      // Check multiple possible formats for file_search tool calls
      let toolResult = null;
      let isFileSearchTool = false;

      // Format 1: Direct tool_call with tool_result
      if (part.type === 'tool_call' && part.tool_call?.name === 'file_search') {
        isFileSearchTool = true;
        toolResult = part.tool_result || part.tool_call?.output;
      }

      // Format 2: Check if it's a tool result with file_search content
      if (part.type === 'tool_result' || part.type === 'tool_call') {
        const resultContent =
          part.tool_result || part.content || part.text || part.result || part.tool_call?.output;
        if (resultContent && typeof resultContent === 'string' && resultContent.includes('File:')) {
          isFileSearchTool = true;
          toolResult = resultContent;
        }
      }

      // Format 3: Check content for file search patterns
      if (
        !isFileSearchTool &&
        part.content &&
        typeof part.content === 'string' &&
        part.content.includes('File:')
      ) {
        isFileSearchTool = true;
        toolResult = part.content;
      }

      if (isFileSearchTool && toolResult) {
        if (typeof toolResult === 'string') {
          // Parse the formatted file search results
          const results = parseFileSearchResults(toolResult);
          fileSearchResults.push(...results);
        }
      }
    }

    if (fileSearchResults.length === 0) {
      logger.warn(
        '[processAgentResponse] No file search results found - no citations will be created',
      );
      return response;
    }

    // Transform results into source format using RAG API metadata as source of truth
    // Ensure file diversity by including at least one result per file, then fill with highest relevance

    // Group results by file_id to ensure file diversity
    const resultsByFileId = {};
    fileSearchResults.forEach((result) => {
      if (!resultsByFileId[result.file_id]) {
        resultsByFileId[result.file_id] = [];
      }
      resultsByFileId[result.file_id].push(result);
    });

    // Get the highest relevance result from each file (file representatives)
    const fileRepresentatives = [];
    for (const fileId in resultsByFileId) {
      const fileResults = resultsByFileId[fileId].sort((a, b) => b.relevance - a.relevance);
      fileRepresentatives.push(fileResults[0]); // Take the best result from each file
    }

    // Sort file representatives by their highest relevance score
    fileRepresentatives.sort((a, b) => b.relevance - a.relevance);

    // Start with file representatives, then add remaining high-relevance results up to limit
    const selectedResults = [...fileRepresentatives];

    // If we have room for more results (under 10), add additional high-relevance results
    if (selectedResults.length < 10) {
      const allResultsSorted = fileSearchResults.sort((a, b) => b.relevance - a.relevance);

      for (const result of allResultsSorted) {
        if (selectedResults.length >= 10) break;

        // Check if this exact result is already included (avoid duplicates)
        const alreadyIncluded = selectedResults.some(
          (selected) =>
            selected.file_id === result.file_id &&
            selected.page === result.page &&
            Math.abs(selected.relevance - result.relevance) < 0.0001, // Handle floating point precision
        );

        if (!alreadyIncluded) {
          selectedResults.push(result);
        }
      }
    }

    const sources = selectedResults
      .slice(0, 10) // Final safety limit to 10 results
      .map((result) => {
        const source = {
          fileId: result.file_id,
          fileName: result.filename,
          pages: result.page ? [result.page] : [],
          relevance: result.relevance,
          type: 'file',
          // Include page-specific relevance mapping for sorting
          pageRelevance: result.pageRelevance || {},
          metadata: {
            storageType: result.storage_type || 'local', // Use RAG API storage type
          },
        };

        // Add S3 metadata if storage type is S3
        if (result.storage_type === 's3' && result.s3_bucket && result.s3_key) {
          source.metadata.s3Bucket = result.s3_bucket;
          source.metadata.s3Key = result.s3_key;
        }

        return source;
      });

    if (sources.length > 0) {
      // Stream file search results immediately if res is available
      if (res && !res.headersSent) {
        try {
          const { nanoid } = require('nanoid');
          const { Tools } = require('librechat-data-provider');

          const attachment = {
            messageId: response.messageId,
            toolCallId: 'file_search_results',
            conversationId: conversationId,
            name: `${Tools.file_search}_file_search_results_${nanoid()}`,
            type: Tools.file_search,
            [Tools.file_search]: {
              sources: sources.map((source) => ({
                fileId: source.fileId,
                fileName: source.fileName,
                pages: source.pages,
                relevance: source.relevance,
                type: 'file',
                pageRelevance: source.pageRelevance,
                metadata: source.metadata,
              })),
            },
          };

          res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
        } catch (streamError) {
          logger.error('[processAgentResponse] Error streaming file search results:', streamError);
        }
      }

      // Capture file references for data consistency
      try {
        await MessageFileReference.captureReferences(
          response.messageId,
          sources,
          userId,
          conversationId,
        );
      } catch (captureError) {
        logger.error('[processAgentResponse] Failed to capture file references:', captureError);
        // Continue with the attachment creation even if capture fails
      }

      // Create attachment object that will be added to artifactPromises
      const fileSearchAttachment = {
        type: 'file_search_sources',
        sources: sources,
        messageId: response.messageId,
        toolCallId: 'file_search_results',
      };

      // Add to response attachments array for processing
      response.attachments = response.attachments || [];
      response.attachments.push(fileSearchAttachment);
    }

    return response;
  } catch (error) {
    logger.error('[processAgentResponse] Error processing agent response:', error);
    return response; // Return original response on error
  }
};

/**
 * Parses formatted file search results string into structured data
 * @param {string} formattedResults - The formatted results from file search tool
 * @returns {Array} Array of parsed file results
 */
const parseFileSearchResults = (formattedResults) => {
  const results = [];

  try {
    // Check if there's internal data with page information
    let dataToProcess = formattedResults;
    const internalDataMatch = formattedResults.match(
      /<!-- INTERNAL_DATA_START -->\n(.*?)\n<!-- INTERNAL_DATA_END -->/s,
    );
    if (internalDataMatch) {
      // Use the internal data which has complete information including pages
      dataToProcess = internalDataMatch[1];
    }

    // Try multiple parsing strategies

    // Strategy 1: Split by multiple newlines or separator
    const sections = dataToProcess.split(/\n\s*\n|\n---\n/);

    for (const section of sections) {
      if (!section.trim()) continue;

      const lines = section.trim().split('\n');
      let filename = '';
      let file_id = '';
      let relevance = 0;
      let content = '';
      let page = null;

      let storage_type = null;
      let s3_bucket = null;
      let s3_key = null;

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('File: ')) {
          const rawFilename = trimmedLine.replace('File: ', '').trim();
          filename = extractOriginalFilename(rawFilename);
        } else if (trimmedLine.startsWith('File_ID: ')) {
          file_id = trimmedLine.replace('File_ID: ', '').trim();
        } else if (trimmedLine.startsWith('Relevance: ')) {
          const relevanceStr = trimmedLine.replace('Relevance: ', '').trim();
          relevance = parseFloat(relevanceStr) || 0;
        } else if (trimmedLine.startsWith('Page: ')) {
          const pageStr = trimmedLine.replace('Page: ', '').trim();
          page = pageStr !== 'N/A' && pageStr !== '' ? parseInt(pageStr) : null;
        } else if (trimmedLine.startsWith('Storage_Type: ')) {
          const storageStr = trimmedLine.replace('Storage_Type: ', '').trim();
          storage_type = storageStr !== 'N/A' && storageStr !== '' ? storageStr : null;
        } else if (trimmedLine.startsWith('S3_Bucket: ')) {
          const bucketStr = trimmedLine.replace('S3_Bucket: ', '').trim();
          s3_bucket = bucketStr !== 'N/A' && bucketStr !== '' ? bucketStr : null;
        } else if (trimmedLine.startsWith('S3_Key: ')) {
          const keyStr = trimmedLine.replace('S3_Key: ', '').trim();
          s3_key = keyStr !== 'N/A' && keyStr !== '' ? keyStr : null;
        } else if (trimmedLine.startsWith('Content: ')) {
          content = trimmedLine.replace('Content: ', '').trim();
        }
      }

      if (filename && (relevance > 0 || file_id)) {
        // Use extracted file_id or generate one as fallback
        const finalFileId = file_id || extractFileIdFromFilename(filename);

        const parsedResult = {
          file_id: finalFileId,
          filename,
          relevance: relevance || 0.5, // Default relevance if not parsed
          content,
          page,
          // Store page-specific relevance for sorting
          pageRelevance: page ? { [page]: relevance || 0.5 } : {},
          // Include RAG API storage metadata
          storage_type,
          s3_bucket,
          s3_key,
        };

        results.push(parsedResult);
      }
    }
  } catch (error) {
    logger.error('[parseFileSearchResults] Error parsing results:', error);
  }

  return results;
};

/**
 * Extracts the original filename from internal storage format
 * Internal format: originalname_fileid_timestamp.ext
 * Example: mars_1c6af286_20250616_105837.pptx -> mars.pptx
 * @param {string} internalFilename - The internal storage filename
 * @returns {string} Original filename
 */
const extractOriginalFilename = (internalFilename) => {
  if (!internalFilename) return internalFilename;

  // Check if this follows the internal naming pattern: name_id_timestamp.ext
  const pattern = /^(.+?)_[a-f0-9]{8}_\d{8}_\d{6}\.(.+)$/;
  const match = internalFilename.match(pattern);

  if (match) {
    const [, originalName, extension] = match;
    return `${originalName}.${extension}`;
  }

  // If it doesn't match the pattern, return as-is
  return internalFilename;
};

/**
 * Extracts or generates a file ID from filename
 * @param {string} filename - The filename
 * @returns {string} File ID
 */
const extractFileIdFromFilename = (filename) => {
  // This is a simple implementation - in production you might want to
  // maintain a mapping of filenames to file IDs or extract from metadata
  return filename.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
};

module.exports = {
  processAgentResponse,
  parseFileSearchResults,
  extractOriginalFilename,
};
