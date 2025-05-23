const { logger } = require('~/config');
const { checkPermission } = require('~/server/services/PermissionService');

/**
 * Generic middleware factory that creates middleware to check resource access permissions.
 * This middleware checks if the authenticated user has the required permission on a specific resource
 * through the ACL system. All users (including owners) must have explicit ACL entries.
 * 
 * @param {Object} options - Configuration options
 * @param {string} options.resourceType - The type of resource (e.g., 'agent', 'file', 'project')
 * @param {number} options.requiredPermission - The permission bit required (1=view, 2=edit, 4=delete, 8=share)
 * @param {string} [options.resourceIdParam='resourceId'] - The name of the route parameter containing the resource ID
 * @returns {Function} Express middleware function
 * 
 * @example
 * // Basic usage for viewing agents
 * router.get('/agents/:agentId', 
 *   canAccessResource({ resourceType: 'agent', requiredPermission: 1 }), 
 *   getAgent
 * );
 * 
 * @example
 * // Custom resource ID parameter and edit permission
 * router.put('/files/:fileId', 
 *   canAccessResource({ 
 *     resourceType: 'file', 
 *     requiredPermission: 2,
 *     resourceIdParam: 'fileId'
 *   }), 
 *   updateFile
 * );
 */
const canAccessResource = (options) => {
  const {
    resourceType,
    requiredPermission,
    resourceIdParam = 'resourceId'
  } = options;

  // Validate required options
  if (!resourceType || typeof resourceType !== 'string') {
    throw new Error('canAccessResource: resourceType is required and must be a string');
  }

  if (!requiredPermission || typeof requiredPermission !== 'number') {
    throw new Error('canAccessResource: requiredPermission is required and must be a number');
  }

  return async (req, res, next) => {
    try {
      // Extract resource ID from route parameters
      const resourceId = req.params[resourceIdParam];
      
      if (!resourceId) {
        logger.warn(`[canAccessResource] Missing ${resourceIdParam} in route parameters`);
        return res.status(400).json({ 
          error: 'Bad Request',
          message: `${resourceIdParam} is required` 
        });
      }

      // Check if user is authenticated
      if (!req.user || !req.user.id) {
        logger.warn(`[canAccessResource] Unauthenticated request for ${resourceType} ${resourceId}`);
        return res.status(401).json({ 
          error: 'Unauthorized',
          message: 'Authentication required' 
        });
      }

      const userId = req.user.id;

      // Check permissions using PermissionService (includes owner ACL entries)
      const hasPermission = await checkPermission({
        userId,
        resourceType,
        resourceId,
        requiredPermission
      });

      if (hasPermission) {
        logger.debug(`[canAccessResource] User ${userId} has permission ${requiredPermission} on ${resourceType} ${resourceId}`);
        
        // Attach resource info to request for downstream middleware/controllers
        req.resourceAccess = {
          resourceType,
          resourceId,
          permission: requiredPermission,
          userId
        };
        
        return next();
      }

      // Permission denied
      logger.warn(
        `[canAccessResource] User ${userId} denied access to ${resourceType} ${resourceId} ` +
        `(required permission: ${requiredPermission})`
      );
      
      return res.status(403).json({ 
        error: 'Forbidden',
        message: `Insufficient permissions to access this ${resourceType}` 
      });

    } catch (error) {
      logger.error(`[canAccessResource] Error checking access for ${resourceType}:`, error);
      return res.status(500).json({ 
        error: 'Internal Server Error',
        message: 'Failed to check resource access permissions' 
      });
    }
  };
};

module.exports = {
  canAccessResource
};