const mongoose = require('mongoose');

const complianceAuditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    resourceId: {
      type: String,
      required: true,
      index: true,
    },
    resourceType: {
      type: String,
      required: true,
      enum: ['file', 'message', 'conversation', 'agent'],
      index: true,
    },
    metadata: {
      messageId: String,
      conversationId: String,
      ip: String,
      userAgent: String,
      timestamp: Date,
      additionalInfo: mongoose.Schema.Types.Mixed,
    },
    result: {
      type: String,
      enum: ['success', 'denied', 'error'],
      default: 'success',
    },
  },
  {
    timestamps: true,
  },
);

// Compound indexes for performance
complianceAuditLogSchema.index({ userId: 1, action: 1, createdAt: -1 });
complianceAuditLogSchema.index({ resourceId: 1, resourceType: 1, createdAt: -1 });
complianceAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // 90 days TTL

module.exports = mongoose.model('ComplianceAuditLog', complianceAuditLogSchema);
