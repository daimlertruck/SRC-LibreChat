const { Message, MessageFileReference } = require('~/models');
const { logger } = require('~/config');

const migrateAgentSources = async () => {
  const batchSize = 100;
  let processed = 0;
  let failed = 0;

  logger.info('Starting agent sources migration...');

  const cursor = Message.find({
    'metadata.isAgent': true,
    attachments: { $exists: true, $ne: [] },
    'metadata.sourcesVersion': { $ne: 'v3' },
  })
    .sort({ createdAt: -1 })
    .cursor({ batchSize });

  for (let message = await cursor.next(); message != null; message = await cursor.next()) {
    try {
      // Transform attachments to new format
      const sources = message.attachments
        .filter((att) => att.type === 'file_search_sources' || att.type === 'file')
        .map((att) => ({
          fileId: att.fileId || att.file_id || att.id,
          fileName: att.fileName || att.filename || att.title || 'Unknown File',
          relevance: att.relevance || (att.sources && att.sources[0]?.relevance) || 0.5,
          pages: att.pages || (att.sources && att.sources[0]?.pages) || [],
          metadata: {
            storageType: att.storageType || att.metadata?.storageType || 'local',
            s3Bucket: att.s3Bucket || att.metadata?.s3Bucket,
            s3Key: att.s3Key || att.metadata?.s3Key,
          },
        }))
        .filter((source) => source.fileId); // Only include sources with valid file IDs

      if (sources.length > 0) {
        // Create file references
        await MessageFileReference.captureReferences(
          message._id.toString(),
          sources,
          message.user,
          message.conversationId,
        );

        logger.debug(`Migrated ${sources.length} file references for message ${message._id}`);
      }

      // Mark as migrated
      await Message.updateOne({ _id: message._id }, { $set: { 'metadata.sourcesVersion': 'v3' } });

      processed++;

      if (processed % 100 === 0) {
        logger.info(`Migrated ${processed} messages`);
      }
    } catch (error) {
      logger.error('Migration failed for message', {
        messageId: message._id.toString(),
        error: error.message,
      });
      failed++;
    }
  }

  logger.info(`Migration complete. Processed: ${processed}, Failed: ${failed}`);
  return { processed, failed };
};

// Run migration
if (require.main === module) {
  migrateAgentSources()
    .then(({ processed, failed }) => {
      logger.info(`Migration completed successfully. Processed: ${processed}, Failed: ${failed}`);
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Migration script failed', error);
      process.exit(1);
    });
}

module.exports = { migrateAgentSources };
