const { z } = require('zod');
const axios = require('axios');
const { tool } = require('@langchain/core/tools');
const { Tools, EToolResources } = require('librechat-data-provider');
const { getFiles } = require('~/models/File');
const { logger } = require('~/config');

/**
 *
 * @param {Object} options
 * @param {ServerRequest} options.req
 * @param {Agent['tool_resources']} options.tool_resources
 * @returns {Promise<{
 *   files: Array<{ file_id: string; filename: string }>,
 *   toolContext: string
 * }>}
 */
const primeFiles = async (options) => {
  const { tool_resources } = options;
  const file_ids = tool_resources?.[EToolResources.file_search]?.file_ids ?? [];
  const agentResourceIds = new Set(file_ids);
  const resourceFiles = tool_resources?.[EToolResources.file_search]?.files ?? [];
  const dbFiles = ((await getFiles({ file_id: { $in: file_ids } })) ?? []).concat(resourceFiles);

  let toolContext = `- Note: Semantic search is available through the ${Tools.file_search} tool but no files are currently loaded. Request the user to upload documents to search through.`;

  const files = [];
  for (let i = 0; i < dbFiles.length; i++) {
    const file = dbFiles[i];
    if (!file) {
      continue;
    }
    if (i === 0) {
      toolContext = `- Note: Use the ${Tools.file_search} tool to find relevant information within:`;
    }
    toolContext += `\n\t- ${file.filename}${
      agentResourceIds.has(file.file_id) ? '' : ' (just attached by user)'
    }`;
    files.push({
      file_id: file.file_id,
      filename: file.filename,
    });
  }

  return { files, toolContext };
};

/**
 *
 * @param {Object} options
 * @param {ServerRequest} options.req
 * @param {Array<{ file_id: string; filename: string }>} options.files
 * @param {string} [options.entity_id]
 * @returns
 */
const createFileSearchTool = async ({ req, files, entity_id }) => {
  return tool(
    async ({ query }) => {
      if (files.length === 0) {
        return 'No files to search. Instruct the user to add files for the search.';
      }
      const jwtToken = req.headers.authorization.split(' ')[1];
      if (!jwtToken) {
        return 'There was an error authenticating the file search request.';
      }

      /**
       *
       * @param {import('librechat-data-provider').TFile} file
       * @returns {{ file_id: string, query: string, k: number, entity_id?: string }}
       */
      const createQueryBody = (file) => {
        const body = {
          file_id: file.file_id,
          query,
          k: 5,
        };
        if (!entity_id) {
          return body;
        }
        body.entity_id = entity_id;
        logger.debug(`[${Tools.file_search}] RAG API /query body`, body);
        return body;
      };

      const queryPromises = files.map((file) =>
        axios
          .post(`${process.env.RAG_API_URL}/query`, createQueryBody(file), {
            headers: {
              Authorization: `Bearer ${jwtToken}`,
              'Content-Type': 'application/json',
            },
          })
          .catch((error) => {
            logger.error('Error encountered in `file_search` while querying file:', error);
            return null;
          }),
      );

      const results = await Promise.all(queryPromises);
      const validResults = results.filter((result) => result !== null);

      if (validResults.length === 0) {
        return 'No results found or errors occurred while searching the files.';
      }

      const formattedResults = validResults
        .flatMap((result, fileIndex) =>
          result.data.map(([docInfo, distance]) => {
            const filename = docInfo.metadata.source.split('/').pop();
            const file = files[fileIndex]; // Get corresponding file info

            return {
              filename,
              content: docInfo.page_content,
              distance,
              file_id: file?.file_id,
              relevance: 1.0 - distance,
              page: docInfo.metadata.page || null,
              storage_type: docInfo.metadata.storage_type || docInfo.metadata.storageType,
            };
          }),
        )
        // TODO: results should be sorted by relevance, not distance
        .sort((a, b) => a.distance - b.distance)
        // TODO: make this configurable
        .slice(0, 10);

      // Format for display (File, Relevance, Content only)
      const formattedString = formattedResults
        .map(
          (result) =>
            `File: ${result.filename}\nRelevance: ${result.relevance.toFixed(4)}\nContent: ${
              result.content
            }\n`,
        )
        .join('\n---\n');

      // Also store the full results with pages and storage metadata for internal processing
      // This ensures the processAgentResponse can access all metadata from RAG API
      const fullResults = formattedResults
        .map(
          (result) =>
            `File: ${result.filename}\nFile_ID: ${result.file_id}\nRelevance: ${result.relevance.toFixed(4)}\nPage: ${result.page || 'N/A'}\nStorage_Type: ${result.storage_type || 'N/A'}\nS3_Bucket: ${result.s3_bucket || 'N/A'}\nS3_Key: ${result.s3_key || 'N/A'}\nContent: ${
              result.content
            }\n`,
        )
        .join('\n---\n');

      // Return the display format, but include a hidden marker with full data for processing
      return `${formattedString}\n\n<!-- INTERNAL_DATA_START -->\n${fullResults}\n<!-- INTERNAL_DATA_END -->`;
    },
    {
      name: Tools.file_search,
      description: `Performs semantic search across attached "${Tools.file_search}" documents using natural language queries. This tool analyzes the content of uploaded files to find relevant information, quotes, and passages that best match your query. Use this to extract specific information or find relevant sections within the available documents.`,
      schema: z.object({
        query: z
          .string()
          .describe(
            "A natural language query to search for relevant information in the files. Be specific and use keywords related to the information you're looking for. The query will be used for semantic similarity matching against the file contents.",
          ),
      }),
    },
  );
};

module.exports = { createFileSearchTool, primeFiles };
