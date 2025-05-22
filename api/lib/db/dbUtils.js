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
    // Try to start a session to see if transactions are supported
    const session = await mongoose.startSession();
    await session.endSession();
    logger.debug('MongoDB transactions are supported');
    return true;
  } catch (error) {
    logger.debug('MongoDB transactions not supported:', error.message);
    return false;
  }
};

// Cache for transaction support check to avoid repeated checks
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

module.exports = {
  supportsTransactions,
  getTransactionSupport,
  resetTransactionSupportCache
};