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

module.exports = {
  createAbsoluteUrl,
};
