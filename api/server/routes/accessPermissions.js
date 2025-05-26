const express = require('express');
const { requireJwtAuth, checkBan, uaParser } = require('~/server/middleware');
const {
  createResourcePermission,
  updateResourcePermissions,
  getResourcePermissions,
  updateResourcePermission,
  deleteResourcePermission,
  getResourceRoles,
  getUserEffectivePermissions,
  searchPrincipals
} = require('~/server/controllers/PermissionsController');

const router = express.Router();

// Apply common middleware
router.use(requireJwtAuth);
router.use(checkBan);
router.use(uaParser);

/**
 * Generic routes for resource permissions
 * Pattern: /api/permissions/{resourceType}/{resourceId}
 */

/**
 * GET /api/permissions/search-principals
 * Search for users and groups to grant permissions
 */
router.get('/search-principals', searchPrincipals);

/**
 * GET /api/permissions/{resourceType}/roles
 * Get available roles for a resource type
 */
router.get('/:resourceType/roles', getResourceRoles);

/**
 * POST /api/permissions/{resourceType}/{resourceId}
 * Grant permission for a specific resource
 */
router.post('/:resourceType/:resourceId', createResourcePermission);

/**
 * GET /api/permissions/{resourceType}/{resourceId}
 * Get all permissions for a specific resource
 */
router.get('/:resourceType/:resourceId', getResourcePermissions);

/**
 * PUT /api/permissions/{resourceType}/{resourceId}
 * Bulk update permissions for a specific resource
 */
router.put('/:resourceType/:resourceId', updateResourcePermissions);

/**
 * GET /api/permissions/{resourceType}/{resourceId}/effective
 * Get user's effective permissions for a specific resource
 */
router.get('/:resourceType/:resourceId/effective', getUserEffectivePermissions);

/**
 * PATCH /api/permissions/{resourceType}/{resourceId}/{permissionId}
 * Update a specific permission (change role)
 */
router.patch('/:resourceType/:resourceId/:permissionId', updateResourcePermission);

/**
 * DELETE /api/permissions/{resourceType}/{resourceId}/{permissionId}
 * Revoke a specific permission
 */
router.delete('/:resourceType/:resourceId/:permissionId', deleteResourcePermission);

module.exports = router;