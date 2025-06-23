/**
 * Creates absolute URLs from request context
 * @param {Object} req - Express request object
 * @param {string} path - Path to make absolute
 * @returns {string} Absolute URL
 */
const createAbsoluteUrl = (req, path) => {
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}${path}`;
};

/**
 * Extracts S3 bucket and key information from file metadata
 * @param {Object} file - File object with S3 metadata
 * @param {Object} fileReference - File reference with captured metadata
 * @returns {Object} S3 details with bucket, key, and storage type
 */
const extractS3Details = (file, fileReference) => {
  const s3Key = file.s3Key || fileReference.capturedMetadata?.s3Key;
  const s3Bucket = file.s3Bucket || fileReference.capturedMetadata?.s3Bucket;
  const storageType =
    file.source === 's3' ? 's3' : fileReference.capturedMetadata?.storageType || file.source;

  return { s3Key, s3Bucket, storageType };
};

module.exports = {
  createAbsoluteUrl,
  extractS3Details,
};
