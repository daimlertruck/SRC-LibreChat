const mongoose = require('mongoose');

const messageFileReferenceSchema = new mongoose.Schema(
  {
    messageId: {
      type: String,
      required: true,
      index: true,
    },
    fileId: {
      type: String,
      required: true,
      index: true,
    },
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    capturedMetadata: {
      fileName: String,
      fileSize: Number,
      mimeType: String,
      s3Bucket: String,
      s3Key: String,
      storageType: {
        type: String,
        enum: ['local', 's3'],
        default: 'local',
      },
      capturedAt: {
        type: Date,
        default: Date.now,
      },
    },
    relevance: {
      type: Number,
      min: 0,
      max: 1,
    },
    pages: [Number],
    status: {
      type: String,
      enum: ['active', 'file_deleted', 'permission_revoked', 'expired'],
      default: 'active',
    },
    lastAccessedAt: Date,
    accessCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

// Compound indexes for performance
messageFileReferenceSchema.index({ messageId: 1, status: 1 });
messageFileReferenceSchema.index({ userId: 1, fileId: 1, status: 1 });
messageFileReferenceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // 30 days TTL

// Static methods
messageFileReferenceSchema.statics.captureReferences = async function (
  messageId,
  sources,
  userId,
  conversationId,
) {
  const references = sources.map((source) => ({
    messageId,
    fileId: source.fileId,
    conversationId,
    userId,
    capturedMetadata: {
      fileName: source.fileName,
      s3Bucket: source.metadata?.s3Bucket,
      s3Key: source.metadata?.s3Key,
      storageType: source.metadata?.storageType || 'local',
    },
    relevance: source.relevance,
    pages: source.pages,
  }));

  return this.insertMany(references);
};

module.exports = mongoose.model('MessageFileReference', messageFileReferenceSchema);
