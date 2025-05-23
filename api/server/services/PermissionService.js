const mongoose = require('mongoose');
const { AclEntry } = require('~/models/AclEntry');
const { User } = require('~/models/User');
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
 * Check if a user has a specific permission on a resource
 * @param {Object} params - Parameters for checking permissions
 * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @param {string} params.accessRoleId - The role ID to check against, e.g. 'agent_viewer'
 * @returns {Promise<boolean>} Whether the user has the required permission
 */
const checkPermission = async ({
  userId,
  resourceType,
  resourceId,
  accessRoleId
}) => {
  try {
    // Get the role to determine permission bits
    const role = await findRoleByIdentifier(accessRoleId);
    if (!role) {
      throw new Error(`Role ${accessRoleId} not found`);
    }

    // Get all principals for the user (user + groups + public)
    const principals = await getUserPrincipals(userId);
    
    if (principals.length === 0) {
      return false;
    }
    
    // Find any ACL entry matching the principals, resource, and permission bit
    const entry = await AclEntry.findOne({
      $or: principals.map(p => ({
        principalType: p.principalType,
        ...(p.principalType !== 'public' && { principalId: p.principalId })
      })),
      resourceType,
      resourceId,
      permBits: { $bitsAnySet: role.permBits }
    }).lean();
    
    return !!entry;
  } catch (error) {
    logger.error(`[PermissionService.checkPermission] Error: ${error.message}`);
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
 * Find all resources of a specific type that a user has access to with a specific role
 * @param {Object} params - Parameters for finding accessible resources
 * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string} params.accessRoleId - The minimum role required (e.g., 'agent_viewer')
 * @returns {Promise<Array>} Array of resource IDs
 */
const findAccessibleResources = async ({
  userId,
  resourceType,
  accessRoleId
}) => {
  try {
    // Get the role to determine permission bits
    const role = await findRoleByIdentifier(accessRoleId);
    if (!role) {
      throw new Error(`Role ${accessRoleId} not found`);
    }

    // Get all principals for the user (user + groups + public)
    const principals = await getUserPrincipals(userId);
    
    if (principals.length === 0) {
      return [];
    }
    
    // Find all matching ACL entries and extract resourceIds
    const entries = await AclEntry.find({
      $or: principals.map(p => ({
        principalType: p.principalType,
        ...(p.principalType !== 'public' && { principalId: p.principalId })
      })),
      resourceType,
      permBits: { $bitsAnySet: role.permBits }
    }).distinct('resourceId');
    
    return entries;
  } catch (error) {
    logger.error(`[PermissionService.findAccessibleResources] Error: ${error.message}`);
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
  entraObjectId,
  entraDisplayName,
  principalType,
  session
}) => {
  try {
    if (!entraObjectId) {
      throw new Error('Entra Object ID is required');
    }
    
    if (!entraDisplayName) {
      throw new Error('Entra Display Name is required');
    }
    
    if (!['user', 'group'].includes(principalType)) {
      throw new Error(`Invalid principal type: ${principalType}`);
    }
    
    const options = session ? { session } : {};
    
    if (principalType === 'user') {
      // Try to find existing user by Entra ID
      const existingUser = await User.findOne({ idOnTheSource: entraObjectId, source: 'entra' }, null, options);
      
      if (existingUser) {
        // Update name if it changed
        if (existingUser.name !== entraDisplayName) {
          await User.updateOne(
            { _id: existingUser._id },
            { $set: { name: entraDisplayName } },
            options
          );
        }
        return existingUser._id;
      }
      
      // Create new user
      const newUser = await User.create(
        [{
          name: entraDisplayName,
          idOnTheSource: entraObjectId,
          source: 'entra',
          email: `${entraObjectId}@entra.id`, // Placeholder email
          username: `entra-${entraObjectId}`, // Placeholder username
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
      const existingGroup = await Group.findOne({ idOnTheSource: entraObjectId, source: 'entra' }, null, options);
      
      if (existingGroup) {
        // Update name if it changed
        if (existingGroup.name !== entraDisplayName) {
          await Group.updateOne(
            { _id: existingGroup._id },
            { $set: { name: entraDisplayName } },
            options
          );
        }
        return existingGroup._id;
      }
      
      // Create new group
      const newGroup = await Group.create(
        [{
          name: entraDisplayName,
          idOnTheSource: entraObjectId,
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
  getAvailableRoles
};