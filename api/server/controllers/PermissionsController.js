const { logger } = require('~/config');
const {
  grantPermission,
  revokePermission,
  getEffectivePermissions,
  getAvailableRoles,
  bulkUpdateResourcePermissions,
} = require('~/server/services/PermissionService');
const { AclEntry } = require('~/models/AclEntry');
const {
  searchPrincipals: searchLocalPrincipals,
  sortPrincipalsByRelevance,
  calculateRelevanceScore,
} = require('~/models/userGroupMethods');
const { searchEntraIdPrincipals } = require('~/server/services/GraphApiService');
const { isEnabled } = require('~/server/utils');

/**
 * Generic controller for resource permission endpoints
 * Delegates validation and logic to PermissionService
 */

/**
 * Grant sharing permission for a resource
 * @route POST /api/{resourceType}/{resourceId}/permissions
 */
const createResourcePermission = async (req, res) => {
  try {
    const { resourceType, resourceId } = req.params;
    const { principalType, principalId, accessRoleId } = req.body;
    const { id: userId } = req.user;

    const aclEntry = await grantPermission({
      principalType,
      principalId,
      resourceType,
      resourceId,
      accessRoleId,
      grantedBy: userId,
    });

    res.status(201).json({
      message: 'Permission granted successfully',
      permission: {
        id: aclEntry._id,
        principalType: aclEntry.principalType,
        principalId: aclEntry.principalId,
        resourceType: aclEntry.resourceType,
        resourceId: aclEntry.resourceId,
        accessRoleId: accessRoleId,
        grantedBy: aclEntry.grantedBy,
        grantedAt: aclEntry.grantedAt,
      },
    });
  } catch (error) {
    logger.error('Error creating resource permission:', error);
    res.status(400).json({
      error: 'Failed to create permission',
      details: error.message,
    });
  }
};

/**
 * Bulk update permissions for a resource (grant, update, remove)
 * @route PUT /api/{resourceType}/{resourceId}/permissions
 */
const updateResourcePermissions = async (req, res) => {
  try {
    const { resourceType, resourceId } = req.params;
    const { permissions } = req.body; // Array of permission DTOs
    const { id: userId } = req.user;

    const results = await bulkUpdateResourcePermissions({
      resourceType,
      resourceId,
      permissions,
      grantedBy: userId,
    });

    res.status(200).json({
      message: 'Permissions updated successfully',
      results,
    });
  } catch (error) {
    logger.error('Error updating resource permissions:', error);
    res.status(400).json({
      error: 'Failed to update permissions',
      details: error.message,
    });
  }
};

/**
 * Get all permissions for a resource
 * @route GET /api/{resourceType}/{resourceId}/permissions
 */
const getResourcePermissions = async (req, res) => {
  try {
    const { resourceType, resourceId } = req.params;

    const permissions = await AclEntry.find({
      resourceType,
      resourceId,
    })
      .populate('roleId', 'accessRoleId name description permBits')
      .lean();

    const formattedPermissions = permissions.map((permission) => ({
      id: permission._id,
      principalType: permission.principalType,
      principalId: permission.principalId,
      role: permission.roleId,
      grantedBy: permission.grantedBy,
      grantedAt: permission.grantedAt,
      inheritedFrom: permission.inheritedFrom,
    }));

    res.status(200).json({
      resourceType,
      resourceId,
      permissions: formattedPermissions,
    });
  } catch (error) {
    logger.error('Error getting resource permissions:', error);
    res.status(500).json({
      error: 'Failed to get permissions',
      details: error.message,
    });
  }
};

/**
 * Update a specific permission (change role)
 * @route PATCH /api/{resourceType}/{resourceId}/permissions/{permissionId}
 */
const updateResourcePermission = async (req, res) => {
  try {
    const { resourceType, resourceId, permissionId } = req.params;
    const { accessRoleId } = req.body;
    const { id: userId } = req.user;

    // Find the existing ACL entry
    const existingEntry = await AclEntry.findOne({
      _id: permissionId,
      resourceType,
      resourceId,
    });

    if (!existingEntry) {
      return res.status(404).json({
        error: 'Permission not found',
      });
    }

    // Revoke the old permission
    await revokePermission({
      principalType: existingEntry.principalType,
      principalId: existingEntry.principalId,
      resourceType,
      resourceId,
    });

    // Grant the new permission with updated role
    const updatedEntry = await grantPermission({
      principalType: existingEntry.principalType,
      principalId: existingEntry.principalId,
      resourceType,
      resourceId,
      accessRoleId,
      grantedBy: userId,
    });

    res.status(200).json({
      message: 'Permission updated successfully',
      permission: {
        id: updatedEntry._id,
        principalType: updatedEntry.principalType,
        principalId: updatedEntry.principalId,
        resourceType: updatedEntry.resourceType,
        resourceId: updatedEntry.resourceId,
        accessRoleId: accessRoleId,
        grantedBy: updatedEntry.grantedBy,
        grantedAt: updatedEntry.grantedAt,
      },
    });
  } catch (error) {
    logger.error('Error updating resource permission:', error);
    res.status(500).json({
      error: 'Failed to update permission',
      details: error.message,
    });
  }
};

/**
 * Revoke a specific permission
 * @route DELETE /api/{resourceType}/{resourceId}/permissions/{permissionId}
 */
const deleteResourcePermission = async (req, res) => {
  try {
    const { resourceType, resourceId, permissionId } = req.params;

    // Find the ACL entry to get the principalType and principalId
    const aclEntry = await AclEntry.findOne({
      _id: permissionId,
      resourceType,
      resourceId,
    });

    if (!aclEntry) {
      return res.status(404).json({
        error: 'Permission not found',
      });
    }

    // Revoke using PermissionService
    await revokePermission({
      principalType: aclEntry.principalType,
      principalId: aclEntry.principalId,
      resourceType,
      resourceId,
    });

    res.status(200).json({
      message: 'Permission revoked successfully',
      permissionId,
    });
  } catch (error) {
    logger.error('Error deleting resource permission:', error);
    res.status(500).json({
      error: 'Failed to delete permission',
      details: error.message,
    });
  }
};

/**
 * Get available roles for a resource type
 * @route GET /api/{resourceType}/roles
 */
const getResourceRoles = async (req, res) => {
  try {
    const { resourceType } = req.params;

    const roles = await getAvailableRoles({ resourceType });

    res.status(200).json({
      resourceType,
      roles: roles.map((role) => ({
        accessRoleId: role.accessRoleId,
        name: role.name,
        description: role.description,
        permBits: role.permBits,
      })),
    });
  } catch (error) {
    logger.error('Error getting resource roles:', error);
    res.status(500).json({
      error: 'Failed to get roles',
      details: error.message,
    });
  }
};

/**
 * Get user's effective permissions for a resource
 * @route GET /api/{resourceType}/{resourceId}/effective-permissions
 */
const getUserEffectivePermissions = async (req, res) => {
  try {
    const { resourceType, resourceId } = req.params;
    const { id: userId } = req.user;

    const permissions = await getEffectivePermissions({
      userId,
      resourceType,
      resourceId,
    });

    res.status(200).json({
      resourceType,
      resourceId,
      userId,
      effectivePermissions: permissions,
    });
  } catch (error) {
    logger.error('Error getting user effective permissions:', error);
    res.status(500).json({
      error: 'Failed to get effective permissions',
      details: error.message,
    });
  }
};

/**
 * Search for users and groups to grant permissions
 * Supports hybrid local database + Entra ID search when configured
 * @route GET /api/permissions/search-principals
 */
const searchPrincipals = async (req, res) => {
  try {
    const { q: query, limit = 10, type } = req.query;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({
        error: 'Query parameter "q" is required and must not be empty',
      });
    }

    if (query.trim().length < 2) {
      return res.status(400).json({
        error: 'Query must be at least 2 characters long',
      });
    }

    const searchLimit = Math.min(Math.max(1, parseInt(limit) || 10), 50);
    const typeFilter = ['user', 'group'].includes(type) ? type : null;

    const localResults = await searchLocalPrincipals(query.trim(), searchLimit, typeFilter);
    let allPrincipals = [...localResults];

    const useEntraId =
      isEnabled(process.env.USE_ENTRA_ID_FOR_PEOPLE_SEARCH) &&
      isEnabled(process.env.OPENID_REUSE_TOKENS) &&
      req.user?.provider === 'openid' &&
      req.user?.openidId;

    if (useEntraId && localResults.length < searchLimit) {
      try {
        const graphTypeMap = {
          user: 'users',
          group: 'groups',
          null: 'all',
        };

        const authHeader = req.headers.authorization;
        const accessToken =
          authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

        if (accessToken) {
          const graphResults = await searchEntraIdPrincipals(
            accessToken,
            req.user.openidId,
            query.trim(),
            graphTypeMap[typeFilter],
            searchLimit - localResults.length,
          );

          const localEmails = new Set(
            localResults.map((p) => p.email?.toLowerCase()).filter(Boolean),
          );
          const localGroupSourceIds = new Set(
            localResults.map((p) => p.idOnTheSource).filter(Boolean),
          );

          for (const principal of graphResults) {
            const isDuplicateByEmail =
              principal.email && localEmails.has(principal.email.toLowerCase());
            const isDuplicateBySourceId =
              principal.idOnTheSource && localGroupSourceIds.has(principal.idOnTheSource);

            if (!isDuplicateByEmail && !isDuplicateBySourceId) {
              allPrincipals.push(principal);
            }
          }
        }
      } catch (graphError) {
        logger.warn('Graph API search failed, falling back to local results:', graphError.message);
      }
    }
    const scoredResults = allPrincipals.map((item) => ({
      ...item,
      _searchScore: calculateRelevanceScore(item, query.trim()),
    }));

    allPrincipals = sortPrincipalsByRelevance(scoredResults)
      .slice(0, searchLimit)
      .map((result) => {
        const { _searchScore, ...resultWithoutScore } = result;
        return resultWithoutScore;
      });
    res.status(200).json({
      query: query.trim(),
      limit: searchLimit,
      type: typeFilter,
      results: allPrincipals,
      count: allPrincipals.length,
      sources: {
        local: allPrincipals.filter((r) => r.source === 'local').length,
        entra: allPrincipals.filter((r) => r.source === 'entra').length,
      },
    });
  } catch (error) {
    logger.error('Error searching principals:', error);
    res.status(500).json({
      error: 'Failed to search principals',
      details: error.message,
    });
  }
};

module.exports = {
  createResourcePermission,
  updateResourcePermissions,
  getResourcePermissions,
  updateResourcePermission,
  deleteResourcePermission,
  getResourceRoles,
  getUserEffectivePermissions,
  searchPrincipals,
};
