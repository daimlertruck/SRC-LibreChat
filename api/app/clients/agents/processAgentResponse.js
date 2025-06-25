const { Files } = require('~/models');
const { getCustomConfig } = require('~/server/services/Config/getCustomConfig');
const { nanoid } = require('nanoid');
const { Tools } = require('librechat-data-provider');
const { logger } = require('~/config');

/**
 * Processes agent response to extract and capture file references from tool calls
 */
const processAgentResponse = async (response, userId, conversationId, contentParts = []) => {
  try {
    if (!response.messageId) {
      logger.warn('[processAgentResponse] No messageId in response');
      return response;
    }

    const customConfig = await getCustomConfig();
    const maxCitations = customConfig?.endpoints?.agents?.maxCitations ?? 30;

    const fileSearchResults = extractFileResults(contentParts);
    if (!fileSearchResults.length) {
      logger.warn('[processAgentResponse] No file search results found');
      return response;
    }

    const selectedResults = selectBestResults(fileSearchResults, maxCitations);
    const sources = await createSourcesWithMetadata(selectedResults, customConfig);

    if (sources.length > 0) {
      logger.debug(
        '[processAgentResponse] Creating file search attachment with sources:',
        sources.length,
      );

      const fileSearchAttachment = {
        messageId: response.messageId,
        toolCallId: 'file_search_results',
        conversationId,
        name: `${Tools.file_search}_file_search_results_${nanoid()}`,
        type: Tools.file_search,
        [Tools.file_search]: { sources },
      };

      response.attachments = response.attachments || [];
      response.attachments.push(fileSearchAttachment);
    }

    return response;
  } catch (error) {
    logger.error('[processAgentResponse] Error processing agent response:', error);
    return response;
  }
};

/**
 * Extract file results from content parts (simplified)
 */
const extractFileResults = (contentParts) => {
  const results = [];

  for (const part of contentParts) {
    let toolResult = null;

    if (part.type === 'tool_call' && part.tool_call?.name === 'file_search') {
      toolResult = part.tool_result || part.tool_call?.output;
    } else if (
      (part.type === 'tool_result' || part.type === 'tool_call') &&
      part.tool_result &&
      typeof part.tool_result === 'string' &&
      part.tool_result.includes('File:')
    ) {
      toolResult = part.tool_result;
    } else if (part.content && typeof part.content === 'string' && part.content.includes('File:')) {
      toolResult = part.content;
    }

    if (toolResult) {
      results.push(...parseFileSearchResults(toolResult));
    }
  }

  return results;
};

/**
 * Select best results with file diversity (simplified algorithm)
 */
const selectBestResults = (results, maxCitations) => {
  const byFile = {};
  results.forEach((result) => {
    if (!byFile[result.file_id]) {
      byFile[result.file_id] = [];
    }
    byFile[result.file_id].push(result);
  });

  const representatives = [];
  for (const fileId in byFile) {
    const fileResults = byFile[fileId].sort((a, b) => b.relevance - a.relevance);
    representatives.push(fileResults[0]);
  }

  return representatives.sort((a, b) => b.relevance - a.relevance).slice(0, maxCitations);
};

/**
 * Create sources with metadata
 */
const createSourcesWithMetadata = async (results, customConfig) => {
  const fileIds = [...new Set(results.map((result) => result.file_id))];

  let fileMetadataMap = {};
  try {
    const files = await Files.find({ file_id: { $in: fileIds } });
    fileMetadataMap = files.reduce((map, file) => {
      map[file.file_id] = file;
      return map;
    }, {});
  } catch (error) {
    logger.error('[processAgentResponse] Error looking up file metadata:', error);
  }

  return results.map((result) => {
    const fileRecord = fileMetadataMap[result.file_id] || {};
    const configuredStorageType = fileRecord.source || customConfig?.fileStrategy || 'local';

    return {
      fileId: result.file_id,
      fileName: fileRecord.filename || 'Unknown File',
      pages: result.page ? [result.page] : [],
      relevance: result.relevance,
      type: 'file',
      pageRelevance: result.pageRelevance || {},
      metadata: { storageType: configuredStorageType },
    };
  });
};

/**
 * Parse file search results (simplified)
 */
const parseFileSearchResults = (formattedResults) => {
  const results = [];

  try {
    let dataToProcess = formattedResults;
    const internalDataMatch = formattedResults.match(
      /<!-- INTERNAL_DATA_START -->\n(.*?)\n<!-- INTERNAL_DATA_END -->/s,
    );
    if (internalDataMatch) {
      dataToProcess = internalDataMatch[1];
    }

    const sections = dataToProcess.split(/\n\s*\n|\n---\n/);

    for (const section of sections) {
      if (!section.trim()) continue;

      const lines = section.trim().split('\n');
      let filename = '';
      let file_id = '';
      let relevance = 0;
      let content = '';
      let page = null;

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('File: ')) {
          filename = trimmedLine.replace('File: ', '').trim();
        } else if (trimmedLine.startsWith('File_ID: ')) {
          file_id = trimmedLine.replace('File_ID: ', '').trim();
        } else if (trimmedLine.startsWith('Relevance: ')) {
          relevance = parseFloat(trimmedLine.replace('Relevance: ', '').trim()) || 0;
        } else if (trimmedLine.startsWith('Page: ')) {
          const pageStr = trimmedLine.replace('Page: ', '').trim();
          page = pageStr !== 'N/A' && pageStr !== '' ? parseInt(pageStr) : null;
        } else if (trimmedLine.startsWith('Content: ')) {
          content = trimmedLine.replace('Content: ', '').trim();
        }
      }

      if (filename && (relevance > 0 || file_id)) {
        const finalFileId = file_id || filename.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        results.push({
          file_id: finalFileId,
          filename,
          relevance: relevance || 0.5,
          content,
          page,
          pageRelevance: page ? { [page]: relevance || 0.5 } : {},
        });
      }
    }
  } catch (error) {
    logger.error('[parseFileSearchResults] Error parsing results:', error);
  }

  return results;
};

module.exports = {
  processAgentResponse,
};
