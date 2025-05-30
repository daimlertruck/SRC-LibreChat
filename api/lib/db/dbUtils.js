const mongoose = require('mongoose');
const { logger } = require('~/config');

/**
 * Checks if the connected MongoDB deployment supports transactions
 * This requires a MongoDB replica set configuration
 * 
 * @returns {Promise<boolean>} True if transactions are supported, false otherwise
 */
const supportsTransactions = async () => {
  try {
    // Try to start a session and perform an actual database operation within a transaction
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      
      // Try to perform an actual database operation to trigger the replica set error
      // Use a simple operation that won't affect any real data
      await mongoose.connection.db.collection('__transaction_test__').findOne({}, { session });
      
      await session.abortTransaction();
      logger.debug('MongoDB transactions are supported');
      return true;
    } catch (transactionError) {
      logger.debug('MongoDB transactions not supported (transaction error):', transactionError.message);
      return false;
    } finally {
      await session.endSession();
    }
  } catch (error) {
    logger.debug('MongoDB transactions not supported (session error):', error.message);
    return false;
  }
};

// Cache for transaction support check to avoid repeated checks
// Force reset to null to ensure new detection logic runs immediately
let transactionSupportCache = null;

/**
 * Gets whether the current MongoDB deployment supports transactions
 * Caches the result for performance
 * 
 * @returns {Promise<boolean>} True if transactions are supported, false otherwise
 */
const getTransactionSupport = async () => {
  if (transactionSupportCache === null) {
    transactionSupportCache = await supportsTransactions();
  }
  return transactionSupportCache;
};

/**
 * Resets the transaction support cache
 * Useful for testing or when MongoDB connection changes
 */
const resetTransactionSupportCache = () => {
  transactionSupportCache = null;
};

// Reset cache on module load to ensure fresh detection
resetTransactionSupportCache();

module.exports = {
  supportsTransactions,
  getTransactionSupport,
  resetTransactionSupportCache
};