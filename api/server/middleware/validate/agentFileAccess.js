const { Files } = require('~/models');
const { Message } = require('~/db/models');
const { Tools } = require('librechat-data-provider');
const { getS3URL } = require('~/server/services/Files/S3/crud');
const { cleanFileName } = require('~/server/utils/files');
const { logger } = require('~/config');

/**
 * Utility: Check if file exists in attachments (eliminates duplication)
 */
const hasFileInAttachments = (attachments, fileId) => {
  if (!attachments) return false;
  return attachments.some(
    (attachment) =>
      attachment.type === Tools.file_search &&
      attachment[Tools.file_search]?.sources?.some((source) => source.fileId === fileId),
  );
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
 * Validate user access to agent file
 */
const validateAgentFileAccess = async (req, res, next) => {
  try {
    const { fileId, messageId, conversationId } = req.body;
    const userId = req.user.id;

    const [message, file] = await Promise.all([
      Message.findOne({ messageId, conversationId, user: userId }).select('attachments'),
      Files.findOne({ file_id: fileId }).select('filename source filepath s3Key type'),
    ]);

    if (!message) {
      logger.warn(`[validateAgentFileAccess] Message not found: ${messageId}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!hasFileInAttachments(message.attachments, fileId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    req.file = file;
    req.message = message;
    next();
  } catch (error) {
    logger.error('[validateAgentFileAccess] Error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
};

/**
 * Generate download URL for agent file
 */
const generateAgentSourceUrl = async (req, res) => {
  try {
    const { file, message } = req;
    const { fileId } = req.body;

    const fileSource = message.attachments
      .find((att) => att.type === Tools.file_search)
      ?.[Tools.file_search]?.sources?.find((s) => s.fileId === fileId);

    if (!fileSource) {
      return res.status(404).json({ error: 'File source not found in message' });
    }

    const expiryMinutes = parseInt(process.env.AGENT_FILE_URL_EXPIRY) || 5;
    let downloadUrl;

    // Handle S3 files - generate fresh URL with clean filename
    if (file.source === 's3' && file.filepath && file.filepath.includes('amazonaws.com')) {
      try {
        let s3Key = file.s3Key;
        if (!s3Key) {
          // Extract key from presigned URL, removing query parameters
          const url = new URL(file.filepath);
          s3Key = url.pathname.substring(1); // Remove leading slash
        }
        const keyParts = s3Key.split('/');
        const basePath = keyParts[0];
        const extractedUserId = keyParts[1];
        const fileName = keyParts.slice(2).join('/');
        const cleanedFilename = cleanFileName(fileSource.fileName);

        downloadUrl = await getS3URL({
          userId: extractedUserId,
          fileName: fileName,
          basePath: basePath,
          customFilename: cleanedFilename,
        });
      } catch (error) {
        logger.error(`[generateAgentSourceUrl] Error generating S3 URL: ${error.message}`);
        downloadUrl = file.filepath; // Fallback to existing URL
      }
    } else {
      // Fallback to API endpoint for non-S3 files
      downloadUrl = `${req.protocol}://${req.get('host')}/api/files/download/${req.user.id}/${file.file_id}`;
    }

    const response = {
      downloadUrl,
      expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString(),
      fileName: cleanFileName(fileSource.fileName),
      mimeType: file.type || 'application/octet-stream',
    };

    logger.debug(`[generateAgentSourceUrl] Generated URL for file: ${fileSource.fileName}`);
    res.json(response);
  } catch (error) {
    logger.error('[generateAgentSourceUrl] Error:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
};

module.exports = {
  validateAgentFileRequest,
  validateAgentFileAccess,
  generateAgentSourceUrl,
};
