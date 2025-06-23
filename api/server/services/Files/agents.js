const { Files, MessageFileReference } = require('~/models');
const { getS3URL } = require('./S3/crud');
const { cleanFileName } = require('~/server/utils/files');
const { logger } = require('~/config');

/**
 * Simple validation for agent file access
 * Follows LibreChat patterns - straightforward and clear
 */
const validateAgentFileAccess = async (req, res, next) => {
  try {
    const { fileId, messageId, conversationId } = req.body;
    const userId = req.user.id;

    // Find file reference - simple database query
    if (!MessageFileReference) {
      logger.error('[validateAgentFileAccess] MessageFileReference model not available');
      return res.status(500).json({ error: 'Database model not available' });
    }

    const reference = await MessageFileReference.findOne({
      messageId,
      fileId,
      userId,
      conversationId,
      status: 'active',
    });

    if (!reference) {
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

    req.fileReference = reference;
    req.file = file;
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
    const { file, fileReference } = req;
    const userId = req.user.id;

    const expiryMinutes = parseInt(process.env.AGENT_FILE_URL_EXPIRY) || 5;
    let downloadUrl;

    // Generate URL based on storage type
    // Helper function to create absolute URLs
    const createAbsoluteUrl = (path) => {
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${path}`;
    };

    // Check for S3 details - prioritize clean file fields over potentially corrupted metadata
    const s3Key = file.s3Key || fileReference.capturedMetadata?.s3Key;
    const s3Bucket = file.s3Bucket || fileReference.capturedMetadata?.s3Bucket;
    const storageType =
      file.source === 's3' ? 's3' : fileReference.capturedMetadata?.storageType || file.source;

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
          const cleanedFilename = cleanFileName(fileReference.capturedMetadata.fileName);

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
        downloadUrl = createAbsoluteUrl(`/api/files/download/${userId}/${file.file_id}`);
      }
    } else if (file.source === 'vectordb' || file.source === 'local') {
      // Vector database or local files - use existing download endpoint with absolute URL
      downloadUrl = createAbsoluteUrl(`/api/files/download/${userId}/${file.file_id}`);
    } else {
      // Fallback to local download endpoint with absolute URL
      downloadUrl = createAbsoluteUrl(`/api/files/download/${userId}/${file.file_id}`);
    }

    const response = {
      downloadUrl,
      expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString(),
      fileName: cleanFileName(fileReference.capturedMetadata.fileName),
      mimeType: fileReference.capturedMetadata.mimeType,
    };

    // Update access count (simple increment)
    try {
      await MessageFileReference.findByIdAndUpdate(fileReference._id, {
        $inc: { accessCount: 1 },
        $set: { lastAccessedAt: new Date() },
      });
    } catch {
      // Don't fail the request for this
    }

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
