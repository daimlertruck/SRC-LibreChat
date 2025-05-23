const mongoose = require('mongoose');
const { AclEntry } = require('~/models/AclEntry');
const User = require('~/models/User');
const Group = require('~/models/Group');
const { AccessRole, findRoleByIdentifier, getRoleForPermissions } = require('~/models/AccessRole');
const { getUserPrincipals } = require('~/models/userGroupMethods');
const { getTransactionSupport } = require('~/lib/db/dbUtils');
const { logger } = require('~/config');

/**
 * Grant a permission to a principal for a resource using a role
 * @param {Object} params - Parameters for granting role-based permission
 * @param {string} params.principalType - 'user', 'group', or 'public'
 * @param {string|mongoose.Types.ObjectId|null} params.principalId - The ID of the principal (null for 'public')
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @param {string} params.accessRoleId - The ID of the role (e.g., 'agent_viewer', 'agent_editor')
 * @param {string|mongoose.Types.ObjectId} params.grantedBy - User ID granting the permission
 * @param {mongoose.ClientSession} [params.session] - Optional MongoDB session for transactions
 * @returns {Promise<Object>} The created or updated ACL entry
 */
const grantPermission = async ({
  principalType,
  principalId,
  resourceType,
  resourceId,
  accessRoleId,
  grantedBy,
  session
}) => {
  try {
    // Validate principal type
    if (!['user', 'group', 'public'].includes(principalType)) {
      throw new Error(`Invalid principal type: ${principalType}`);
    }

    // Validate principalId - should be present for 'user' and 'group', null for 'public'
    if (principalType !== 'public' && !principalId) {
      throw new Error('Principal ID is required for user and group principals');
    }

    // For non-null principalId, ensure it's a valid ObjectId
    if (principalId && !mongoose.Types.ObjectId.isValid(principalId)) {
      throw new Error(`Invalid principal ID: ${principalId}`);
    }

    // Validate resourceId
    if (!resourceId || !mongoose.Types.ObjectId.isValid(resourceId)) {
      throw new Error(`Invalid resource ID: ${resourceId}`);
    }

    // Get the role to determine permission bits
    const role = await findRoleByIdentifier(accessRoleId);
    if (!role) {
      throw new Error(`Role ${accessRoleId} not found`);
    }

    // Ensure the role is for the correct resource type
    if (role.resourceType !== resourceType) {
      throw new Error(`Role ${accessRoleId} is for ${role.resourceType} resources, not ${resourceType}`);
    }

    const query = {
      principalType,
      resourceType,
      resourceId
    };
    
    if (principalType !== 'public') {
      query.principalId = principalId;
      query.principalModel = principalType === 'user' ? 'User' : 'Group';
    }
    
    const update = {
      $set: {
        permBits: role.permBits,
        roleId: role._id,
        grantedBy,
        grantedAt: new Date()
      }
    };
    
    const options = {
      upsert: true,
      new: true,
      ...(session ? { session } : {})
    };
    
    return await AclEntry.findOneAndUpdate(query, update, options);
  } catch (error) {
    logger.error(`[PermissionService.grantPermission] Error: ${error.message}`);
    throw error;
  }
};

/**
 * Revoke permissions from a principal for a resource
 * @param {Object} params - Parameters for revoking permission
 * @param {string} params.principalType - 'user', 'group', or 'public'
 * @param {string|mongoose.Types.ObjectId|null} params.principalId - The ID of the principal (null for 'public')
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @param {mongoose.ClientSession} [params.session] - Optional MongoDB session for transactions
 * @returns {Promise<Object>} The result of the delete operation
 */
const revokePermission = async ({
  principalType,
  principalId, 
  resourceType,
  resourceId,
  session
}) => {
  // Validate principal type
  if (!['user', 'group', 'public'].includes(principalType)) {
    throw new Error(`Invalid principal type: ${principalType}`);
  }

  // Validate resourceId
  if (!resourceId || !mongoose.Types.ObjectId.isValid(resourceId)) {
    throw new Error(`Invalid resource ID: ${resourceId}`);
  }

  try {
    const query = {
      principalType,
      resourceType,
      resourceId
    };
    
    if (principalType !== 'public') {
      query.principalId = principalId;
    }
    
    const options = session ? { session } : {};
    
    return await AclEntry.deleteOne(query, options);
  } catch (error) {
    logger.error(`[PermissionService.revokePermission] Error: ${error.message}`);
    throw error;
  }
};

/**
 * Check if a user has specific permission bits on a resource
 * @param {Object} params - Parameters for checking permissions
 * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @param {number} params.requiredPermissions - The permission bits required (e.g., 1 for VIEW, 3 for VIEW+EDIT)
 * @returns {Promise<boolean>} Whether the user has the required permission bits
 */
const checkPermission = async ({
  userId,
  resourceType,
  resourceId,
  requiredPermissions
}) => {
  try {
    // Validate required permissions is a number
    if (typeof requiredPermissions !== 'number' || requiredPermissions < 1) {
      throw new Error('requiredPermissions must be a positive number');
    }

    // Get all principals for the user (user + groups + public)
    const principals = await getUserPrincipals(userId);
    
    if (principals.length === 0) {
      return false;
    }
    
    // Find any ACL entry matching the principals, resource, and check if it has all required permission bits
    const entry = await AclEntry.findOne({
      $or: principals.map(p => ({
        principalType: p.principalType,
        ...(p.principalType !== 'public' && { principalId: p.principalId })
      })),
      resourceType,
      resourceId,
      permBits: { $bitsAllSet: requiredPermissions }
    }).lean();
    
    return !!entry;
  } catch (error) {
    logger.error(`[PermissionService.checkPermission] Error: ${error.message}`);
    // Re-throw validation errors
    if (error.message.includes('requiredPermissions must be')) {
      throw error;
    }
    return false;
  }
};

/**
 * Get effective permissions for a user on a resource
 * @param {Object} params - Parameters for getting effective permissions
 * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @returns {Promise<Object>} Object with effective permission details and role information
 */
const getEffectivePermissions = async ({
  userId,
  resourceType,
  resourceId
}) => {
  try {
    // Get all principals for the user (user + groups + public)
    const principals = await getUserPrincipals(userId);
    
    if (principals.length === 0) {
      return { 
        effectiveRole: null,
        sources: [] 
      };
    }
    
    // Find all matching ACL entries and populate role information
    const aclEntries = await AclEntry.find({
      $or: principals.map(p => ({
        principalType: p.principalType,
        ...(p.principalType !== 'public' && { principalId: p.principalId })
      })),
      resourceType,
      resourceId
    })
    .populate('roleId')
    .populate('principalId', 'name')
    .lean();
    
    if (aclEntries.length === 0) {
      return { 
        effectiveRole: null,
        sources: [] 
      };
    }
    
    // Calculate effective permissions
    let effectiveBits = 0;
    const sources = aclEntries.map(entry => {
      effectiveBits |= entry.permBits;
      
      const source = {
        from: entry.principalType,
        principalId: entry.principalId?._id,
        principalName: entry.principalId?.name,
        direct: !entry.inheritedFrom,
        inheritedFrom: entry.inheritedFrom
      };
      
      // Add role information if available
      if (entry.roleId) {
        source.role = {
          id: entry.roleId._id,
          name: entry.roleId.name,
          accessRoleId: entry.roleId.accessRoleId
        };
      }
      
      return source;
    });
    
    // Find the matching role for the effective permission bits
    const effectiveRole = await getRoleForPermissions(resourceType, effectiveBits);
    
    return { 
      effectiveRole: effectiveRole ? {
        id: effectiveRole._id,
        name: effectiveRole.name,
        accessRoleId: effectiveRole.accessRoleId,
        description: effectiveRole.description
      } : null,
      sources 
    };
  } catch (error) {
    logger.error(`[PermissionService.getEffectivePermissions] Error: ${error.message}`);
    return { 
      effectiveRole: null, 
      sources: [] 
    };
  }
};

/**
 * Find all resources of a specific type that a user has access to with specific permission bits
 * @param {Object} params - Parameters for finding accessible resources
 * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {number} params.requiredPermissions - The minimum permission bits required (e.g., 1 for VIEW, 3 for VIEW+EDIT)
 * @returns {Promise<Array>} Array of resource IDs
 */
const findAccessibleResources = async ({
  userId,
  resourceType,
  requiredPermissions
}) => {
  try {
    // Validate required permissions is a number
    if (typeof requiredPermissions !== 'number' || requiredPermissions < 1) {
      throw new Error('requiredPermissions must be a positive number');
    }

    // Get all principals for the user (user + groups + public)
    const principals = await getUserPrincipals(userId);
    
    if (principals.length === 0) {
      return [];
    }
    
    // Find all matching ACL entries where user has at least the required permission bits
    const entries = await AclEntry.find({
      $or: principals.map(p => ({
        principalType: p.principalType,
        ...(p.principalType !== 'public' && { principalId: p.principalId })
      })),
      resourceType,
      permBits: { $bitsAllSet: requiredPermissions }
    }).distinct('resourceId');
    
    return entries;
  } catch (error) {
    logger.error(`[PermissionService.findAccessibleResources] Error: ${error.message}`);
    // Re-throw validation errors
    if (error.message.includes('requiredPermissions must be')) {
      throw error;
    }
    return [];
  }
};

/**
 * Sync an Entra ID principal to the local database
 * @param {Object} params - Parameters for syncing Entra principal
 * @param {string} params.entraObjectId - Entra ID Object ID
 * @param {string} params.entraDisplayName - Entra display name
 * @param {string} params.principalType - 'user' or 'group'
 * @param {mongoose.ClientSession} [params.session] - Optional MongoDB session for transactions
 * @returns {Promise<mongoose.Types.ObjectId>} The local ID of the synced principal
 */
const syncEntraPrincipal = async ({
  entraIdObject,
  principalType,
  session
}) => {
  try {
    if (!entraIdObject || !entraIdObject.id) {
      throw new Error('Entra ID object with id is required');
    }
    
    if (!entraIdObject.name) {
      throw new Error('Entra Display Name is required');
    }
    
    if (!['user', 'group'].includes(principalType)) {
      throw new Error(`Invalid principal type: ${principalType}`);
    }
    
    const options = session ? { session } : {};
    
    if (principalType === 'user') {
      // Try to find existing user by Entra ID
      const existingUser = await User.findOne({ openidId: entraIdObject.id }, null, options);
      
      if (existingUser) {
        // Update user information if it changed
        const updateFields = {};
        if (existingUser.name !== entraIdObject.name) {
          updateFields.name = entraIdObject.name;
        }
        if (entraIdObject.email && existingUser.email !== entraIdObject.email) {
          updateFields.email = entraIdObject.email;
        }
        if (entraIdObject.username && existingUser.username !== entraIdObject.username) {
          updateFields.username = entraIdObject.username;
        }
        
        if (Object.keys(updateFields).length > 0) {
          await User.updateOne(
            { _id: existingUser._id },
            { $set: updateFields },
            options
          );
        }
        return existingUser._id;
      }
      
      // For new user creation, email is required
      if (!entraIdObject.email) {
        throw new Error('Email is required for user creation');
      }
      
      // Create new user
      const newUser = await User.create(
        [{
          name: entraIdObject.name,
          openidId: entraIdObject.id,
          provider: 'openid',
          email: entraIdObject.email,
          username: entraIdObject.username || `entra-${entraIdObject.id}`,
          avatar: '',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date()
        }],
        options
      );
      
      return newUser[0]._id;
    } else {
      // Try to find existing group by Entra ID
      const existingGroup = await Group.findOne({ idOnTheSource: entraIdObject.id, source: 'entra' }, null, options);
      
      if (existingGroup) {
        // Update name if it changed
        if (existingGroup.name !== entraIdObject.name) {
          await Group.updateOne(
            { _id: existingGroup._id },
            { $set: { name: entraIdObject.name } },
            options
          );
        }
        return existingGroup._id;
      }
      
      // Create new group
      const newGroup = await Group.create(
        [{
          name: entraIdObject.name,
          idOnTheSource: entraIdObject.id,
          source: 'entra',
          memberIds: []
        }],
        options
      );
      
      return newGroup[0]._id;
    }
  } catch (error) {
    logger.error(`[PermissionService.syncEntraPrincipal] Error: ${error.message}`);
    throw error;
  }
};

/**
 * Grant permission with inherited project fan-out
 * 
 * When granting access to a project, this will also grant the same permissions to all
 * child resources (e.g. agents) within that project with inheritedFrom marker
 * 
 * @param {Object} params - Parameters for project permission grant by role
 * @param {string} params.principalType - 'user', 'group', or 'public'
 * @param {string|mongoose.Types.ObjectId|null} params.principalId - The ID of the principal (null for 'public')
 * @param {string|mongoose.Types.ObjectId} params.projectId - The ID of the project
 * @param {string} params.accessRoleId - The ID of the role (e.g., 'project_viewer', 'project_editor')
 * @param {string|mongoose.Types.ObjectId} params.grantedBy - User ID granting the permission
 * @returns {Promise<Object>} Result with the project permission and child permissions
 */
const grantProjectPermissionWithFanout = async ({
  principalType,
  principalId,
  projectId,
  accessRoleId,
  grantedBy
}) => {
  // Check if transactions are supported
  const supportsTransactions = await getTransactionSupport();
  let session = null;
  let result = null;
  
  try {
    // Get the role to determine permission bits
    const role = await findRoleByIdentifier(accessRoleId);
    if (!role) {
      throw new Error(`Role ${accessRoleId} not found`);
    }

    // Ensure the role is for project resources
    if (role.resourceType !== 'project') {
      throw new Error(`Role ${accessRoleId} is for ${role.resourceType} resources, not projects`);
    }

    if (supportsTransactions) {
      session = await mongoose.startSession();
      session.startTransaction();
    }
    
    // 1. Grant permission on the project itself
    const projectAcl = await grantPermission({
      principalType,
      principalId,
      resourceType: 'project',
      resourceId: projectId,
      accessRoleId,
      grantedBy,
      session
    });
    
    // 2. Query for all agents in this project
    const Agent = mongoose.model('Agent');
    const queryOptions = session ? { session } : {};
    const agentsInProject = await Agent.find(
      { projectId },
      { _id: 1 },
      queryOptions
    ).lean();
    
    // 3. Fan-out the permission to all agents in the project
    const childPermissions = [];
    
    // Find the agent_viewer role for the agent resources
    // We need to map project roles to agent roles
    const agentRoleMapping = {
      'project_viewer': 'agent_viewer',
      'project_editor': 'agent_editor',
      'project_manager': 'agent_manager',
      'project_owner': 'agent_owner'
    };
    
    // Default to agent_viewer if no explicit mapping
    const agentRoleId = agentRoleMapping[accessRoleId] || 'agent_viewer';
    const agentRole = await findRoleByIdentifier(agentRoleId);
    
    if (!agentRole) {
      throw new Error(`Corresponding agent role ${agentRoleId} not found`);
    }
    
    for (const agent of agentsInProject) {
      // Create an ACL entry for this agent with inheritedFrom marker
      const aclEntry = new AclEntry({
        principalType,
        ...(principalType !== 'public' && { 
          principalId,
          principalModel: principalType === 'user' ? 'User' : 'Group'
        }),
        resourceType: 'agent',
        resourceId: agent._id,
        permBits: agentRole.permBits,
        roleId: agentRole._id,
        grantedBy,
        grantedAt: new Date(),
        inheritedFrom: projectId
      });
      
      if (session) {
        await aclEntry.save({ session });
      } else {
        await aclEntry.save();
      }
      childPermissions.push(aclEntry);
    }
    
    result = {
      projectPermission: projectAcl,
      childPermissions,
      agentCount: agentsInProject.length
    };
    
    if (session && supportsTransactions) {
      await session.commitTransaction();
    }
    
    return result;
  } catch (error) {
    if (session && supportsTransactions) {
      await session.abortTransaction();
    }
    logger.error(`[PermissionService.grantProjectPermissionWithFanout] Error: ${error.message}`);
    throw error;
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

/**
 * Revoke project permission with inherited cleanup
 * 
 * Removes the project permission and all child permissions that were inherited from it
 * 
 * @param {Object} params - Parameters for project permission revocation
 * @param {string} params.principalType - 'user', 'group', or 'public'
 * @param {string|mongoose.Types.ObjectId|null} params.principalId - The ID of the principal (null for 'public')
 * @param {string|mongoose.Types.ObjectId} params.projectId - The ID of the project
 * @returns {Promise<Object>} Result with counts of deleted permissions
 */
const revokeProjectPermissionWithCleanup = async ({
  principalType,
  principalId,
  projectId
}) => {
  // Check if transactions are supported
  const supportsTransactions = await getTransactionSupport();
  let session = null;
  let result = null;
  
  try {
    if (supportsTransactions) {
      session = await mongoose.startSession();
      session.startTransaction();
    }
    
    // 1. Revoke the project permission itself
    const projectResult = await revokePermission({
      principalType,
      principalId,
      resourceType: 'project',
      resourceId: projectId,
      session
    });
    
    // 2. Delete all inherited child permissions
    const query = {
      principalType,
      inheritedFrom: projectId
    };
    
    if (principalType !== 'public') {
      query.principalId = principalId;
    }
    
    const options = session ? { session } : {};
    const childResult = await AclEntry.deleteMany(query, options);
    
    result = {
      projectPermission: projectResult.deletedCount,
      childPermissions: childResult.deletedCount
    };
    
    if (session && supportsTransactions) {
      await session.commitTransaction();
    }
    
    return result;
  } catch (error) {
    if (session && supportsTransactions) {
      await session.abortTransaction();
    }
    logger.error(`[PermissionService.revokeProjectPermissionWithCleanup] Error: ${error.message}`);
    throw error;
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

/**
 * Reset all permissions for a resource
 * 
 * Removes all ACL entries for the specified resource
 * 
 * @param {Object} params - Parameters for resetting resource permissions
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @returns {Promise<number>} Count of deleted permissions
 */
const resetResourcePermissions = async ({
  resourceType,
  resourceId
}) => {
  try {
    if (!resourceId || !mongoose.Types.ObjectId.isValid(resourceId)) {
      throw new Error(`Invalid resource ID: ${resourceId}`);
    }
    
    const result = await AclEntry.deleteMany({
      resourceType,
      resourceId
    });
    
    return result.deletedCount;
  } catch (error) {
    logger.error(`[PermissionService.resetResourcePermissions] Error: ${error.message}`);
    throw error;
  }
};

/**
 * Check if a user is the author/owner of a resource
 * 
 * This is useful for checking "ownership" permissions in addition to ACL
 * 
 * @param {Object} params - Parameters for checking resource authorship
 * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
 * @param {Object} params.resource - The resource document with author/authorId field
 * @returns {boolean} Whether the user is the author
 */
const isResourceAuthor = ({
  userId,
  resource
}) => {
  if (!userId || !resource) {
    return false;
  }
  
  // Convert to string for comparison
  const userIdStr = userId.toString();
  
  // Check possible author field variations
  const author = resource.author || resource.authorId || resource.userId || resource.ownerId;
  
  if (!author) {
    return false;
  }
  
  return author.toString() === userIdStr;
};

/**
 * Get available roles for a resource type
 * @param {Object} params - Parameters for getting available roles
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @returns {Promise<Array>} Array of role definitions
 */
const getAvailableRoles = async ({
  resourceType
}) => {
  try {
    return await AccessRole.find({ resourceType }).lean();
  } catch (error) {
    logger.error(`[PermissionService.getAvailableRoles] Error: ${error.message}`);
    return [];
  }
};

/**
 * Bulk update permissions for a resource (grant, update, revoke)
 * Efficiently handles multiple permission changes in a single transaction
 * 
 * @param {Object} params - Parameters for bulk permission update
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @param {Array} params.permissions - Array of permission DTOs with {principalType, principalId, accessRoleId}
 * @param {string|mongoose.Types.ObjectId} params.grantedBy - User ID making the changes
 * @param {mongoose.ClientSession} [params.session] - Optional MongoDB session for transactions
 * @returns {Promise<Object>} Results object with granted, updated, revoked arrays and error details
 */
const bulkUpdateResourcePermissions = async ({
  resourceType,
  resourceId,
  permissions,
  grantedBy,
  session
}) => {
  // Check if transactions are supported
  const supportsTransactions = await getTransactionSupport();
  let localSession = session;
  let shouldEndSession = false;
  
  try {
    // Validate inputs
    if (!Array.isArray(permissions)) {
      throw new Error('permissions must be an array');
    }

    if (!resourceId || !mongoose.Types.ObjectId.isValid(resourceId)) {
      throw new Error(`Invalid resource ID: ${resourceId}`);
    }

    // Start transaction if not provided and supported
    if (!localSession && supportsTransactions) {
      localSession = await mongoose.startSession();
      localSession.startTransaction();
      shouldEndSession = true;
    }

    const sessionOptions = localSession ? { session: localSession } : {};

    // Get current permissions for the resource
    const currentPermissions = await AclEntry.find({
      resourceType,
      resourceId
    }, null, sessionOptions).populate('roleId', 'accessRoleId').lean();

    // Create maps for efficient comparison
    const currentPermMap = new Map();
    currentPermissions.forEach(perm => {
      const key = `${perm.principalType}-${perm.principalId || 'public'}`;
      currentPermMap.set(key, perm);
    });

    const newPermMap = new Map();
    permissions.forEach(perm => {
      const key = `${perm.principalType}-${perm.principalId || 'public'}`;
      newPermMap.set(key, perm);
    });

    const results = {
      granted: [],
      updated: [],
      revoked: [],
      errors: []
    };

    // Prepare bulk operations
    const bulkWrites = [];
    const newAclEntries = [];

    // Process new permissions (grant or update)
    for (const newPerm of permissions) {
      try {
        const key = `${newPerm.principalType}-${newPerm.principalId || 'public'}`;
        const currentPerm = currentPermMap.get(key);

        // Get the role to validate and get permission bits
        const role = await findRoleByIdentifier(newPerm.accessRoleId);
        if (!role) {
          results.errors.push({
            permission: newPerm,
            error: `Role ${newPerm.accessRoleId} not found`
          });
          continue;
        }

        if (role.resourceType !== resourceType) {
          results.errors.push({
            permission: newPerm,
            error: `Role ${newPerm.accessRoleId} is for ${role.resourceType} resources, not ${resourceType}`
          });
          continue;
        }

        const query = {
          principalType: newPerm.principalType,
          resourceType,
          resourceId
        };
        
        if (newPerm.principalType !== 'public') {
          query.principalId = newPerm.principalId;
          query.principalModel = newPerm.principalType === 'user' ? 'User' : 'Group';
        }

        const update = {
          $set: {
            permBits: role.permBits,
            roleId: role._id,
            grantedBy,
            grantedAt: new Date()
          }
        };

        if (!currentPerm) {
          // New permission - use upsert
          bulkWrites.push({
            updateOne: {
              filter: query,
              update: update,
              upsert: true
            }
          });
          
          results.granted.push({
            principalType: newPerm.principalType,
            principalId: newPerm.principalId,
            accessRoleId: newPerm.accessRoleId
          });
        } else {
          // Check if role needs to be updated
          if (currentPerm.roleId.accessRoleId !== newPerm.accessRoleId) {
            bulkWrites.push({
              updateOne: {
                filter: query,
                update: update
              }
            });

            results.updated.push({
              principalType: newPerm.principalType,
              principalId: newPerm.principalId,
              oldAccessRoleId: currentPerm.roleId.accessRoleId,
              newAccessRoleId: newPerm.accessRoleId,
              id: currentPerm._id
            });
          }
        }
      } catch (error) {
        results.errors.push({
          permission: newPerm,
          error: error.message
        });
      }
    }

    // Process permissions to revoke (in current but not in new)
    const deleteQueries = [];
    for (const [key, currentPerm] of currentPermMap) {
      if (!newPermMap.has(key)) {
        const deleteQuery = {
          principalType: currentPerm.principalType,
          resourceType,
          resourceId
        };
        
        if (currentPerm.principalType !== 'public') {
          deleteQuery.principalId = currentPerm.principalId;
        }

        deleteQueries.push(deleteQuery);
        
        results.revoked.push({
          principalType: currentPerm.principalType,
          principalId: currentPerm.principalId,
          id: currentPerm._id
        });
      }
    }

    // Execute bulk operations
    if (bulkWrites.length > 0) {
      await AclEntry.bulkWrite(bulkWrites, sessionOptions);
    }

    // Execute deletions
    if (deleteQueries.length > 0) {
      await AclEntry.deleteMany({
        $or: deleteQueries
      }, sessionOptions);
    }

    // Commit transaction if we started it
    if (shouldEndSession && supportsTransactions) {
      await localSession.commitTransaction();
    }

    return results;

  } catch (error) {
    // Abort transaction if we started it
    if (shouldEndSession && supportsTransactions) {
      await localSession.abortTransaction();
    }
    logger.error(`[PermissionService.bulkUpdateResourcePermissions] Error: ${error.message}`);
    throw error;
  } finally {
    if (shouldEndSession && localSession) {
      localSession.endSession();
    }
  }
};

module.exports = {
  grantPermission,
  revokePermission,
  checkPermission,
  getEffectivePermissions,
  findAccessibleResources,
  syncEntraPrincipal,
  grantProjectPermissionWithFanout,
  revokeProjectPermissionWithCleanup,
  resetResourcePermissions,
  isResourceAuthor,
  getAvailableRoles,
  bulkUpdateResourcePermissions
};