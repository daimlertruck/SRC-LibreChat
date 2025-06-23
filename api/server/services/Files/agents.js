const { Files } = require('~/models');
const { Message } = require('~/db/models');
const { Tools } = require('librechat-data-provider');
const { getS3URL } = require('./S3/crud');
const { cleanFileName } = require('~/server/utils/files');
const { createAbsoluteUrl } = require('~/server/utils/url');
const { logger } = require('~/config');

/**
 * Simple validation for agent file access using web search pattern
 * Files are stored as attachments in messages
 */
const validateAgentFileAccess = async (req, res, next) => {
  try {
    const { fileId, messageId, conversationId } = req.body;
    const userId = req.user.id;

    // Find message with file_search attachments
    const message = await Message.findOne({
      messageId,
      conversationId,
      user: userId,
    });

    if (!message) {
      logger.warn(`[validateAgentFileAccess] Message not found: ${messageId}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check for file_search attachments containing the requested fileId
    const hasFileAccess = message.attachments?.some((attachment) => {
      if (attachment.type === Tools.file_search && attachment[Tools.file_search]) {
        return attachment[Tools.file_search].sources?.some((source) => source.fileId === fileId);
      }
      return false;
    });

    if (!hasFileAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Find file metadata
    if (!Files) {
      logger.error('[validateAgentFileAccess] Files model not available');
      return res.status(500).json({ error: 'Files model not available' });
    }

    const file = await Files.findOne({ file_id: fileId });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Store file metadata for next middleware
    req.file = file;
    req.message = message;
    next();
  } catch (error) {
    logger.error('[validateAgentFileAccess] Error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
};

/**
 * Validate basic agent file request structure
 */
const validateAgentFileRequest = (req, res, next) => {
  const { fileId, messageId, conversationId } = req.body;

  if (!fileId || !messageId || !conversationId) {
    return res.status(400).json({
      error: 'Missing required fields: fileId, messageId, conversationId',
    });
  }

  next();
};

/**
 * Generate download URL for agent file
 * Simple implementation following LibreChat patterns
 */
const generateAgentSourceUrl = async (req, res) => {
  try {
    const { file, message } = req;
    const { fileId } = req.body;
    const userId = req.user.id;

    // Find file metadata from message attachments
    let fileSource = null;
    message.attachments?.forEach((attachment) => {
      if (attachment.type === Tools.file_search && attachment[Tools.file_search]) {
        const source = attachment[Tools.file_search].sources?.find((s) => s.fileId === fileId);
        if (source) {
          fileSource = source;
        }
      }
    });

    if (!fileSource) {
      return res.status(404).json({ error: 'File source not found in message' });
    }

    const expiryMinutes = parseInt(process.env.AGENT_FILE_URL_EXPIRY) || 5;
    let downloadUrl;

    // Generate URL based on storage type
    const storageType = fileSource.metadata?.storageType || file.source;
    const s3Key = fileSource.metadata?.s3Key || file.metadata?.s3Key;
    const s3Bucket = fileSource.metadata?.s3Bucket || file.metadata?.s3Bucket;

    if (
      (storageType === 's3' && s3Key && s3Bucket) ||
      (file.source === 's3' && s3Key && s3Bucket)
    ) {
      // S3 stored files - use enhanced getS3URL with clean filename
      try {
        // Extract parts from s3Key: "basePath/userId/fileName"
        const keyParts = s3Key.split('/');
        if (keyParts.length >= 3) {
          const basePath = keyParts[0]; // e.g., "uploads"
          const extractedUserId = keyParts[1]; // e.g., "67f2bbc8e0ed32a5fd0e39c9"
          const fileName = keyParts.slice(2).join('/'); // e.g., "bc8245e6-df02-4947-9675-06dd03e352b8__mars.pptx"

          // Get clean filename for download
          const cleanedFilename = cleanFileName(fileSource.fileName);

          downloadUrl = await getS3URL({
            userId: extractedUserId,
            fileName: fileName,
            basePath: basePath,
            customFilename: cleanedFilename,
          });
        } else {
          throw new Error(`Invalid S3 key format: ${s3Key}`);
        }
      } catch (s3Error) {
        logger.error('[generateAgentSourceUrl] Error generating S3 URL:', s3Error);
        // Fallback to local download with absolute URL
        downloadUrl = createAbsoluteUrl(req, `/api/files/download/${userId}/${file.file_id}`);
      }
    } else if (file.source === 'vectordb' || file.source === 'local') {
      // Vector database or local files - use existing download endpoint with absolute URL
      downloadUrl = createAbsoluteUrl(req, `/api/files/download/${userId}/${file.file_id}`);
    } else {
      // Fallback to local download endpoint with absolute URL
      downloadUrl = createAbsoluteUrl(req, `/api/files/download/${userId}/${file.file_id}`);
    }

    const response = {
      downloadUrl,
      expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString(),
      fileName: cleanFileName(fileSource.fileName),
      mimeType: file.type || 'application/octet-stream',
    };

    // No access tracking needed with simplified architecture
    logger.debug(`[generateAgentSourceUrl] Generated URL for file: ${fileSource.fileName}`);

    res.json(response);
  } catch (error) {
    logger.error('[generateAgentSourceUrl] Error:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
};

module.exports = {
  validateAgentFileAccess,
  validateAgentFileRequest,
  generateAgentSourceUrl,
};
