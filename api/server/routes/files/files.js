const fs = require('fs').promises;
const express = require('express');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { EnvVar } = require('@librechat/agents');
const {
  Time,
  isUUID,
  CacheKeys,
  FileSources,
  EModelEndpoint,
  isAgentsEndpoint,
  checkOpenAIStorage,
} = require('librechat-data-provider');
const {
  filterFile,
  processFileUpload,
  processDeleteRequest,
  processAgentFileUpload,
} = require('~/server/services/Files/process');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { refreshS3FileUrls, getS3URL } = require('~/server/services/Files/S3/crud');
const { getFiles, batchUpdateFiles } = require('~/models/File');
const { getAssistant } = require('~/models/Assistant');
const { getAgent } = require('~/models/Agent');
const { cleanFileName } = require('~/server/utils/files');
const { getLogStores } = require('~/cache');
const { removePorts, isEnabled } = require('~/server/utils');
const ioredisClient = require('~/cache/ioredisClient');
const { logger } = require('~/config');
const {
  generateAgentSourceUrl,
  validateAgentFileAccess,
  validateAgentFileRequest,
} = require('~/server/middleware/validate/agentFileAccess');

const router = express.Router();

// Rate limiter using LibreChat patterns
const createAgentFileRateLimiter = () => {
  const windowMs = (parseInt(process.env.AGENT_FILE_RATE_WINDOW) || 15) * 60 * 1000; // 15 minutes
  const max = parseInt(process.env.AGENT_FILE_RATE_LIMIT) || 50;
  const windowInMinutes = windowMs / 60000;
  const message = `Too many agent file requests, please try again after ${windowInMinutes} minutes.`;

  const limiterOptions = {
    windowMs,
    max,
    message,
    keyGenerator: removePorts,
    handler: (req, res) => {
      logger.warn(`Rate limit exceeded for agent file requests from ${req.ip}`);
      return res.status(429).json({ error: message });
    },
  };

  // Use Redis store if available
  if (isEnabled(process.env.USE_REDIS) && ioredisClient) {
    logger.debug('Using Redis for agent file rate limiter.');
    const store = new RedisStore({
      sendCommand: (...args) => ioredisClient.call(...args),
      prefix: 'agent_file_limiter:',
    });
    limiterOptions.store = store;
  }

  return rateLimit(limiterOptions);
};

const agentFileRateLimiter = createAgentFileRateLimiter();

router.get('/', async (req, res) => {
  try {
    const files = await getFiles({ user: req.user.id });
    if (req.app.locals.fileStrategy === FileSources.s3) {
      try {
        const cache = getLogStores(CacheKeys.S3_EXPIRY_INTERVAL);
        const alreadyChecked = await cache.get(req.user.id);
        if (!alreadyChecked) {
          await refreshS3FileUrls(files, batchUpdateFiles);
          await cache.set(req.user.id, true, Time.THIRTY_MINUTES);
        }
      } catch (error) {
        logger.warn('[/files] Error refreshing S3 file URLs:', error);
      }
    }
    res.status(200).send(files);
  } catch (error) {
    logger.error('[/files] Error getting files:', error);
    res.status(400).json({ message: 'Error in request', error: error.message });
  }
});

router.get('/config', async (req, res) => {
  try {
    res.status(200).json(req.app.locals.fileConfig);
  } catch (error) {
    logger.error('[/files] Error getting fileConfig', error);
    res.status(400).json({ message: 'Error in request', error: error.message });
  }
});

router.delete('/', async (req, res) => {
  try {
    const { files: _files } = req.body;

    /** @type {MongoFile[]} */
    const files = _files.filter((file) => {
      if (!file.file_id) {
        return false;
      }
      if (!file.filepath) {
        return false;
      }

      if (/^(file|assistant)-/.test(file.file_id)) {
        return true;
      }

      return isUUID.safeParse(file.file_id).success;
    });

    if (files.length === 0) {
      res.status(204).json({ message: 'Nothing provided to delete' });
      return;
    }

    const fileIds = files.map((file) => file.file_id);
    const dbFiles = await getFiles({ file_id: { $in: fileIds } });
    const unauthorizedFiles = dbFiles.filter((file) => file.user.toString() !== req.user.id);

    if (unauthorizedFiles.length > 0) {
      return res.status(403).json({
        message: 'You can only delete your own files',
        unauthorizedFiles: unauthorizedFiles.map((f) => f.file_id),
      });
    }

    /* Handle agent unlinking even if no valid files to delete */
    if (req.body.agent_id && req.body.tool_resource && dbFiles.length === 0) {
      const agent = await getAgent({
        id: req.body.agent_id,
      });

      const toolResourceFiles = agent.tool_resources?.[req.body.tool_resource]?.file_ids ?? [];
      const agentFiles = files.filter((f) => toolResourceFiles.includes(f.file_id));

      await processDeleteRequest({ req, files: agentFiles });
      res.status(200).json({ message: 'File associations removed successfully from agent' });
      return;
    }

    /* Handle assistant unlinking even if no valid files to delete */
    if (req.body.assistant_id && req.body.tool_resource && dbFiles.length === 0) {
      const assistant = await getAssistant({
        id: req.body.assistant_id,
      });

      const toolResourceFiles = assistant.tool_resources?.[req.body.tool_resource]?.file_ids ?? [];
      const assistantFiles = files.filter((f) => toolResourceFiles.includes(f.file_id));

      await processDeleteRequest({ req, files: assistantFiles });
      res.status(200).json({ message: 'File associations removed successfully from assistant' });
      return;
    } else if (
      req.body.assistant_id &&
      req.body.files?.[0]?.filepath === EModelEndpoint.azureAssistants
    ) {
      await processDeleteRequest({ req, files: req.body.files });
      return res
        .status(200)
        .json({ message: 'File associations removed successfully from Azure Assistant' });
    }

    await processDeleteRequest({ req, files: dbFiles });

    logger.debug(
      `[/files] Files deleted successfully: ${files
        .filter((f) => f.file_id)
        .map((f) => f.file_id)
        .join(', ')}`,
    );
    res.status(200).json({ message: 'Files deleted successfully' });
  } catch (error) {
    logger.error('[/files] Error deleting files:', error);
    res.status(400).json({ message: 'Error in request', error: error.message });
  }
});

function isValidID(str) {
  return /^[A-Za-z0-9_-]{21}$/.test(str);
}

router.get('/code/download/:session_id/:fileId', async (req, res) => {
  try {
    const { session_id, fileId } = req.params;
    const logPrefix = `Session ID: ${session_id} | File ID: ${fileId} | Code output download requested by user `;
    logger.debug(logPrefix);

    if (!session_id || !fileId) {
      return res.status(400).send('Bad request');
    }

    if (!isValidID(session_id) || !isValidID(fileId)) {
      logger.debug(`${logPrefix} invalid session_id or fileId`);
      return res.status(400).send('Bad request');
    }

    const { getDownloadStream } = getStrategyFunctions(FileSources.execute_code);
    if (!getDownloadStream) {
      logger.warn(
        `${logPrefix} has no stream method implemented for ${FileSources.execute_code} source`,
      );
      return res.status(501).send('Not Implemented');
    }

    const result = await loadAuthValues({ userId: req.user.id, authFields: [EnvVar.CODE_API_KEY] });

    /** @type {AxiosResponse<ReadableStream> | undefined} */
    const response = await getDownloadStream(
      `${session_id}/${fileId}`,
      result[EnvVar.CODE_API_KEY],
    );
    res.set(response.headers);
    response.data.pipe(res);
  } catch (error) {
    logger.error('Error downloading file:', error);
    res.status(500).send('Error downloading file');
  }
});

router.get('/download/:userId/:file_id', async (req, res) => {
  try {
    const { userId, file_id } = req.params;
    logger.debug(`File download requested by user ${userId}: ${file_id}`);

    const errorPrefix = `File download requested by user ${userId}`;

    if (userId !== req.user.id) {
      logger.warn(`${errorPrefix} forbidden: ${file_id}`);
      return res.status(403).send('Forbidden');
    }

    const [file] = await getFiles({ file_id });

    if (!file) {
      logger.warn(`${errorPrefix} not found: ${file_id}`);
      return res.status(404).send('File not found');
    }

    if (!file.filepath.includes(userId)) {
      logger.warn(`${errorPrefix} forbidden: ${file_id}`);
      return res.status(403).send('Forbidden');
    }

    if (checkOpenAIStorage(file.source) && !file.model) {
      logger.warn(`${errorPrefix} has no associated model: ${file_id}`);
      return res.status(400).send('The model used when creating this file is not available');
    }

    const { getDownloadStream } = getStrategyFunctions(file.source);
    if (!getDownloadStream) {
      logger.warn(`${errorPrefix} has no stream method implemented: ${file.source}`);
      return res.status(501).send('Not Implemented');
    }

    const setHeaders = () => {
      const cleanedFilename = cleanFileName(file.filename);
      res.setHeader('Content-Disposition', `attachment; filename="${cleanedFilename}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-File-Metadata', JSON.stringify(file));
    };

    /** @type {{ body: import('stream').PassThrough } | undefined} */
    let passThrough;
    /** @type {ReadableStream | undefined} */
    let fileStream;

    if (checkOpenAIStorage(file.source)) {
      req.body = { model: file.model };
      const endpointMap = {
        [FileSources.openai]: EModelEndpoint.assistants,
        [FileSources.azure]: EModelEndpoint.azureAssistants,
      };
      const { openai } = await getOpenAIClient({
        req,
        res,
        overrideEndpoint: endpointMap[file.source],
      });
      logger.debug(`Downloading file ${file_id} from OpenAI`);
      passThrough = await getDownloadStream(file_id, openai);
      setHeaders();
      logger.debug(`File ${file_id} downloaded from OpenAI`);
      passThrough.body.pipe(res);
    } else if (file.source === FileSources.s3) {
      // For S3 files, redirect to fresh presigned URL instead of streaming
      logger.debug('[DOWNLOAD ROUTE] S3 file detected, generating fresh presigned URL');
      try {
        // Extract S3 key from the stored filepath
        const s3Key = file.filepath.split('/').slice(3).join('/'); // Remove https://bucket.s3.region.amazonaws.com/
        const fileName = file.filename;

        logger.debug('[DOWNLOAD ROUTE] Extracting S3 info:', {
          originalFilepath: file.filepath,
          extractedKey: s3Key,
          fileName,
        });

        // Generate fresh presigned URL with cleaned filename
        const cleanedFilename = cleanFileName(fileName);
        const freshPresignedUrl = await getS3URL({
          userId: file.user,
          fileName: `${file.file_id}__${fileName}`,
          basePath: file.filepath.includes('/images/') ? 'images' : 'uploads',
          customFilename: cleanedFilename,
        });

        // Redirect to S3 presigned URL for direct download
        return res.redirect(302, freshPresignedUrl);
      } catch (error) {
        logger.error('[DOWNLOAD ROUTE] Error generating S3 presigned URL:', error);
        // Fallback to streaming
        fileStream = await getDownloadStream(req, file.filepath);
      }
    } else {
      fileStream = await getDownloadStream(req, file.filepath);

      fileStream.on('error', (streamError) => {
        logger.error('[DOWNLOAD ROUTE] Stream error:', streamError);
      });

      setHeaders();
      fileStream.pipe(res);
    }
  } catch (error) {
    logger.error('[DOWNLOAD ROUTE] Error downloading file:', error);
    res.status(500).send('Error downloading file');
  }
});

// Simple rate limiting middleware
const rateLimitMiddleware = async (req, res, next) => {
  try {
    if (agentFileRateLimiter.consume) {
      await agentFileRateLimiter.consume(req.user.id);
    }
    next();
  } catch (rejRes) {
    logger.warn(`Rate limit exceeded for agent file access`, {
      userId: req.user.id,
      retryAfter: rejRes.msBeforeNext,
    });

    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.round(rejRes.msBeforeNext / 1000) || 900,
    });
  }
};

// Simplified agent source URL endpoint
router.post(
  '/agent-source-url',
  rateLimitMiddleware,
  validateAgentFileRequest,
  validateAgentFileAccess,
  generateAgentSourceUrl,
);

router.post('/', async (req, res) => {
  const metadata = req.body;
  let cleanup = true;

  try {
    filterFile({ req });

    metadata.temp_file_id = metadata.file_id;
    metadata.file_id = req.file_id;

    if (isAgentsEndpoint(metadata.endpoint)) {
      return await processAgentFileUpload({ req, res, metadata });
    }

    await processFileUpload({ req, res, metadata });
  } catch (error) {
    let message = 'Error processing file';
    logger.error('[/files] Error processing file:', error);

    if (error.message?.includes('file_ids')) {
      message += ': ' + error.message;
    }

    if (error.message?.includes('Invalid file format')) {
      message = error.message;
    }

    try {
      await fs.unlink(req.file.path);
      cleanup = false;
    } catch (error) {
      logger.error('[/files] Error deleting file:', error);
    }
    res.status(500).json({ message });
  }

  if (cleanup) {
    try {
      await fs.unlink(req.file.path);
    } catch (error) {
      logger.error('[/files] Error deleting file after file processing:', error);
    }
  }
});

module.exports = router;
