const { Files, MessageFileReference } = require('~/models');
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

    if (
      fileReference.capturedMetadata.storageType === 's3' &&
      fileReference.capturedMetadata.s3Key
    ) {
      // S3 stored files - use RAG API metadata directly
      try {
        // Use the bucket name from RAG API instead of environment variable
        // Create direct presigned URL using exact S3 metadata from RAG API
        const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
        const { GetObjectCommand } = require('@aws-sdk/client-s3');

        // Try to get bucket region and create S3 client accordingly
        const { S3Client, GetBucketLocationCommand } = require('@aws-sdk/client-s3');

        const bucketName = fileReference.capturedMetadata.s3Bucket;
        let region = process.env.AWS_REGION || 'us-east-1';
        const endpoint = process.env.AWS_ENDPOINT_URL;
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

        // First, try to detect the bucket's region
        try {
          const tempS3 = new S3Client({
            region: 'us-east-1', // Use us-east-1 for GetBucketLocation call
            ...(endpoint ? { endpoint } : {}),
            ...(accessKeyId && secretAccessKey
              ? { credentials: { accessKeyId, secretAccessKey } }
              : {}),
          });

          const locationResult = await tempS3.send(
            new GetBucketLocationCommand({ Bucket: bucketName }),
          );
          const bucketRegion = locationResult.LocationConstraint || 'us-east-1';
          region = bucketRegion;
        } catch {
          // Region detection failed, use default
        }

        // Now create S3 client with the correct region
        const config = {
          region,
          ...(endpoint ? { endpoint } : {}),
        };

        let s3;
        if (accessKeyId && secretAccessKey) {
          s3 = new S3Client({
            ...config,
            credentials: { accessKeyId, secretAccessKey },
          });
        } else {
          s3 = new S3Client(config);
        }

        const params = {
          Bucket: fileReference.capturedMetadata.s3Bucket, // Use RAG API bucket name
          Key: fileReference.capturedMetadata.s3Key, // Use full S3 key from RAG API
        };

        downloadUrl = await getSignedUrl(s3, new GetObjectCommand(params), {
          expiresIn: expiryMinutes * 60,
        });
      } catch (s3Error) {
        logger.error('[generateAgentSourceUrl] Error generating S3 URL:', s3Error);
        // Fallback to local download
        downloadUrl = `/api/files/download/${userId}/${file.file_id}`;
      }
    } else if (file.source === 'vectordb' || file.source === 'local') {
      // Vector database or local files - use existing download endpoint
      downloadUrl = `/api/files/download/${userId}/${file.file_id}`;
    } else {
      // Fallback to local download endpoint
      downloadUrl = `/api/files/download/${userId}/${file.file_id}`;
    }

    const response = {
      downloadUrl,
      expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString(),
      fileName: fileReference.capturedMetadata.fileName,
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
