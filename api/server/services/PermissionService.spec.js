const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { AclEntry } = require('~/models/AclEntry');
const User = require('~/models/User');
const Group = require('~/models/Group');
const { AccessRole, findRoleByIdentifier } = require('~/models/AccessRole');
const { getUserPrincipals } = require('~/models/userGroupMethods');
const { RoleBits } = require('@librechat/data-schemas');
const {
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
} = require('./PermissionService');

// Mock the getTransactionSupport function from dbUtils - disable transactions for testing
jest.mock('~/lib/db/dbUtils', () => ({
  getTransactionSupport: jest.fn().mockResolvedValue(false)
}));

// Mock the logger
jest.mock('~/config', () => ({
  logger: {
    error: jest.fn()
  }
}));

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  // Seed some roles for testing
  await AccessRole.create([
    {
      accessRoleId: 'agent_viewer',
      name: 'Agent Viewer',
      description: 'Can view agents',
      resourceType: 'agent',
      permBits: RoleBits.VIEWER // VIEW permission
    },
    {
      accessRoleId: 'agent_editor',
      name: 'Agent Editor',
      description: 'Can edit agents',
      resourceType: 'agent',
      permBits: RoleBits.EDITOR // VIEW + EDIT permissions
    },
    {
      accessRoleId: 'agent_manager',
      name: 'Agent Manager',
      description: 'Can manage agents',
      resourceType: 'agent',
      permBits: RoleBits.MANAGER // VIEW + EDIT + DELETE permissions
    },
    {
      accessRoleId: 'agent_owner',
      name: 'Agent Owner',
      description: 'Full control over agents',
      resourceType: 'agent',
      permBits: RoleBits.OWNER // VIEW + EDIT + DELETE + SHARE permissions
    },
    {
      accessRoleId: 'project_viewer',
      name: 'Project Viewer',
      description: 'Can view projects',
      resourceType: 'project',
      permBits: RoleBits.VIEWER
    },
    {
      accessRoleId: 'project_editor',
      name: 'Project Editor',
      description: 'Can edit projects',
      resourceType: 'project',
      permBits: RoleBits.EDITOR
    },
    {
      accessRoleId: 'project_manager',
      name: 'Project Manager',
      description: 'Can manage projects',
      resourceType: 'project',
      permBits: RoleBits.MANAGER
    },
    {
      accessRoleId: 'project_owner',
      name: 'Project Owner',
      description: 'Full control over projects',
      resourceType: 'project',
      permBits: RoleBits.OWNER
    }
  ]);
});

// Mock getUserPrincipals to avoid depending on the actual implementation
jest.mock('~/models/userGroupMethods', () => ({
  getUserPrincipals: jest.fn()
}));

describe('PermissionService', () => {
  // Common test data
  const userId = new mongoose.Types.ObjectId();
  const groupId = new mongoose.Types.ObjectId();
  const resourceId = new mongoose.Types.ObjectId();
  const grantedById = new mongoose.Types.ObjectId();
  
  describe('grantPermission', () => {
    test('should grant permission to a user with a role', async () => {
      const entry = await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      expect(entry).toBeDefined();
      expect(entry.principalType).toBe('user');
      expect(entry.principalId.toString()).toBe(userId.toString());
      expect(entry.principalModel).toBe('User');
      expect(entry.resourceType).toBe('agent');
      expect(entry.resourceId.toString()).toBe(resourceId.toString());
      
      // Get the role to verify the permission bits are correctly set
      const role = await findRoleByIdentifier('agent_viewer');
      expect(entry.permBits).toBe(role.permBits);
      expect(entry.roleId.toString()).toBe(role._id.toString());
      expect(entry.grantedBy.toString()).toBe(grantedById.toString());
      expect(entry.grantedAt).toBeInstanceOf(Date);
    });
    
    test('should grant permission to a group with a role', async () => {
      const entry = await grantPermission({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_editor',
        grantedBy: grantedById
      });
      
      expect(entry).toBeDefined();
      expect(entry.principalType).toBe('group');
      expect(entry.principalId.toString()).toBe(groupId.toString());
      expect(entry.principalModel).toBe('Group');
      
      // Get the role to verify the permission bits are correctly set
      const role = await findRoleByIdentifier('agent_editor');
      expect(entry.permBits).toBe(role.permBits);
      expect(entry.roleId.toString()).toBe(role._id.toString());
    });
    
    test('should grant public permission with a role', async () => {
      const entry = await grantPermission({
        principalType: 'public',
        principalId: null,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      expect(entry).toBeDefined();
      expect(entry.principalType).toBe('public');
      expect(entry.principalId).toBeUndefined();
      expect(entry.principalModel).toBeUndefined();
      
      // Get the role to verify the permission bits are correctly set
      const role = await findRoleByIdentifier('agent_viewer');
      expect(entry.permBits).toBe(role.permBits);
      expect(entry.roleId.toString()).toBe(role._id.toString());
    });
    
    test('should throw error for invalid principal type', async () => {
      await expect(
        grantPermission({
          principalType: 'invalid',
          principalId: userId,
          resourceType: 'agent',
          resourceId,
          accessRoleId: 'agent_viewer',
          grantedBy: grantedById
        })
      ).rejects.toThrow('Invalid principal type: invalid');
    });
    
    test('should throw error for missing principalId with user type', async () => {
      await expect(
        grantPermission({
          principalType: 'user',
          principalId: null,
          resourceType: 'agent',
          resourceId,
          accessRoleId: 'agent_viewer',
          grantedBy: grantedById
        })
      ).rejects.toThrow('Principal ID is required for user and group principals');
    });
    
    test('should throw error for non-existent role', async () => {
      await expect(
        grantPermission({
          principalType: 'user',
          principalId: userId,
          resourceType: 'agent',
          resourceId,
          accessRoleId: 'non_existent_role',
          grantedBy: grantedById
        })
      ).rejects.toThrow('Role non_existent_role not found');
    });
    
    test('should throw error for role-resource type mismatch', async () => {
      await expect(
        grantPermission({
          principalType: 'user',
          principalId: userId,
          resourceType: 'agent',
          resourceId,
          accessRoleId: 'project_viewer', // Project role for agent resource
          grantedBy: grantedById
        })
      ).rejects.toThrow('Role project_viewer is for project resources, not agent');
    });
    
    test('should update existing permission when granting to same principal and resource', async () => {
      // First grant with viewer role
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      // Then update to editor role
      const updated = await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_editor',
        grantedBy: grantedById
      });
      
      const editorRole = await findRoleByIdentifier('agent_editor');
      expect(updated.permBits).toBe(editorRole.permBits);
      expect(updated.roleId.toString()).toBe(editorRole._id.toString());
      
      // Verify there's only one entry
      const entries = await AclEntry.find({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId
      });
      expect(entries).toHaveLength(1);
    });
  });
  
  describe('revokePermission', () => {
    beforeEach(async () => {
      // Setup test data
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      await grantPermission({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_editor',
        grantedBy: grantedById
      });
      
      await grantPermission({
        principalType: 'public',
        principalId: null,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
    });
    
    test('should revoke user permission', async () => {
      const result = await revokePermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId
      });
      
      expect(result.deletedCount).toBe(1);
      
      // Verify permission is deleted
      const entries = await AclEntry.find({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId
      });
      expect(entries).toHaveLength(0);
      
      // Verify other permissions still exist
      const allEntries = await AclEntry.find({ resourceType: 'agent', resourceId });
      expect(allEntries).toHaveLength(2);
    });
    
    test('should revoke group permission', async () => {
      const result = await revokePermission({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId
      });
      
      expect(result.deletedCount).toBe(1);
      
      // Verify permission is deleted
      const entries = await AclEntry.find({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId
      });
      expect(entries).toHaveLength(0);
    });
    
    test('should revoke public permission', async () => {
      const result = await revokePermission({
        principalType: 'public',
        principalId: null,
        resourceType: 'agent',
        resourceId
      });
      
      expect(result.deletedCount).toBe(1);
      
      // Verify permission is deleted
      const entries = await AclEntry.find({
        principalType: 'public',
        resourceType: 'agent',
        resourceId
      });
      expect(entries).toHaveLength(0);
    });
    
    test('should handle non-existent permission gracefully', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const result = await revokePermission({
        principalType: 'user',
        principalId: nonExistentId,
        resourceType: 'agent',
        resourceId
      });
      
      expect(result.deletedCount).toBe(0);
    });
    
    test('should throw error for invalid principal type', async () => {
      await expect(
        revokePermission({
          principalType: 'invalid',
          principalId: userId,
          resourceType: 'agent',
          resourceId
        })
      ).rejects.toThrow('Invalid principal type: invalid');
    });
    
    test('should throw error for invalid resource ID', async () => {
      await expect(
        revokePermission({
          principalType: 'user',
          principalId: userId,
          resourceType: 'agent',
          resourceId: 'not-a-valid-id'
        })
      ).rejects.toThrow('Invalid resource ID: not-a-valid-id');
    });
  });
  
  describe('checkPermission', () => {
    let otherResourceId;
    
    beforeEach(async () => {
      // Reset the mock implementation for getUserPrincipals
      getUserPrincipals.mockReset();
      
      // Setup test data
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      otherResourceId = new mongoose.Types.ObjectId();
      await grantPermission({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId: otherResourceId,
        accessRoleId: 'agent_editor',
        grantedBy: grantedById
      });
    });
    
    test('should check permission for user principal', async () => {
      // Mock getUserPrincipals to return just the user principal
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId }
      ]);
      
      const hasViewPermission = await checkPermission({
        userId,
        resourceType: 'agent',
        resourceId,
        requiredPermissions: RoleBits.VIEWER // 1 = VIEW
      });
      
      expect(hasViewPermission).toBe(true);
      
      // Check higher permission level that user doesn't have
      const hasEditPermission = await checkPermission({
        userId,
        resourceType: 'agent',
        resourceId,
        requiredPermissions: RoleBits.EDITOR // 3 = VIEW + EDIT
      });
      
      expect(hasEditPermission).toBe(false);
    });
    
    test('should check permission for user and group principals', async () => {
      // Mock getUserPrincipals to return both user and group principals
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId },
        { principalType: 'group', principalId: groupId }
      ]);
      
      // Check original resource (user has access)
      const hasViewOnOriginal = await checkPermission({
        userId,
        resourceType: 'agent',
        resourceId,
        requiredPermissions: RoleBits.VIEWER // 1 = VIEW
      });
      
      expect(hasViewOnOriginal).toBe(true);
      
      // Check other resource (group has access)
      const hasViewOnOther = await checkPermission({
        userId,
        resourceType: 'agent',
        resourceId: otherResourceId,
        requiredPermissions: RoleBits.VIEWER // 1 = VIEW
      });
      
      // Group has agent_editor role which includes viewer permissions
      expect(hasViewOnOther).toBe(true);
    });
    
    test('should check permission for public access', async () => {
      const publicResourceId = new mongoose.Types.ObjectId();
      
      // Grant public access to a resource
      await grantPermission({
        principalType: 'public',
        principalId: null,
        resourceType: 'agent',
        resourceId: publicResourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      // Mock getUserPrincipals to return user, group, and public principals
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId },
        { principalType: 'group', principalId: groupId },
        { principalType: 'public' }
      ]);
      
      const hasPublicAccess = await checkPermission({
        userId,
        resourceType: 'agent',
        resourceId: publicResourceId,
        requiredPermissions: RoleBits.VIEWER // 1 = VIEW
      });
      
      expect(hasPublicAccess).toBe(true);
    });
    
    test('should return false for invalid permission bits', async () => {
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId }
      ]);
      
      await expect(
        checkPermission({
          userId,
          resourceType: 'agent',
          resourceId,
          requiredPermissions: 'invalid'
        })
      ).rejects.toThrow('requiredPermissions must be a positive number');
      
      const nonExistentResource = await checkPermission({
        userId,
        resourceType: 'agent',
        resourceId: new mongoose.Types.ObjectId(),
        requiredPermissions: RoleBits.VIEWER
      });
      
      expect(nonExistentResource).toBe(false);
    });
    
    test('should return false if user has no principals', async () => {
      getUserPrincipals.mockResolvedValue([]);
      
      const hasPermission = await checkPermission({
        userId,
        resourceType: 'agent',
        resourceId,
        requiredPermissions: RoleBits.VIEWER
      });
      
      expect(hasPermission).toBe(false);
    });
  });
  
  describe('getEffectivePermissions', () => {
    beforeEach(async () => {
      // Reset the mock implementation for getUserPrincipals
      getUserPrincipals.mockReset();
      
      // Setup test data with multiple permissions from different sources
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      await grantPermission({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_editor',
        grantedBy: grantedById
      });
      
      // Create another resource with public permission
      const publicResourceId = new mongoose.Types.ObjectId();
      await grantPermission({
        principalType: 'public',
        principalId: null,
        resourceType: 'agent',
        resourceId: publicResourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      // Setup a resource with inherited permission
      const projectId = new mongoose.Types.ObjectId();
      const childResourceId = new mongoose.Types.ObjectId();
      
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'project',
        resourceId: projectId,
        accessRoleId: 'project_viewer',
        grantedBy: grantedById
      });
      
      await AclEntry.create({
        principalType: 'user',
        principalId: userId,
        principalModel: 'User',
        resourceType: 'agent',
        resourceId: childResourceId,
        permBits: RoleBits.VIEWER,
        roleId: (await findRoleByIdentifier('agent_viewer'))._id,
        grantedBy: grantedById,
        grantedAt: new Date(),
        inheritedFrom: projectId
      });
    });
    
    test('should get effective permissions from multiple sources', async () => {
      // Mock getUserPrincipals to return both user and group principals
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId },
        { principalType: 'group', principalId: groupId }
      ]);
      
      const effective = await getEffectivePermissions({
        userId,
        resourceType: 'agent',
        resourceId
      });
      
      expect(effective).toBeDefined();
      expect(effective.effectiveRole).toBeDefined();
      
      // The effective role should be the highest possible role (in this case editor)
      expect(effective.effectiveRole.accessRoleId).toBe('agent_editor');
      
      // Should have 2 sources
      expect(effective.sources).toHaveLength(2);
      
      // Check sources
      const userSource = effective.sources.find(s => s.from === 'user');
      const groupSource = effective.sources.find(s => s.from === 'group');
      
      expect(userSource).toBeDefined();
      expect(userSource.role.accessRoleId).toBe('agent_viewer');
      expect(userSource.direct).toBe(true);
      
      expect(groupSource).toBeDefined();
      expect(groupSource.role.accessRoleId).toBe('agent_editor');
      expect(groupSource.direct).toBe(true);
    });
    
    test('should get effective permissions from inherited permissions', async () => {
      // Find the child resource ID
      const inheritedEntry = await AclEntry.findOne({ inheritedFrom: { $exists: true } });
      const childResourceId = inheritedEntry.resourceId;
      
      // Mock getUserPrincipals to return user principal
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId }
      ]);
      
      const effective = await getEffectivePermissions({
        userId,
        resourceType: 'agent',
        resourceId: childResourceId
      });
      
      expect(effective).toBeDefined();
      expect(effective.effectiveRole).toBeDefined();
      expect(effective.effectiveRole.accessRoleId).toBe('agent_viewer');
      
      expect(effective.sources).toHaveLength(1);
      expect(effective.sources[0].from).toBe('user');
      expect(effective.sources[0].direct).toBe(false);
      expect(effective.sources[0].inheritedFrom).toBeDefined();
    });
    
    test('should return null role for non-existent permissions', async () => {
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId }
      ]);
      
      const nonExistentResource = new mongoose.Types.ObjectId();
      const effective = await getEffectivePermissions({
        userId,
        resourceType: 'agent',
        resourceId: nonExistentResource
      });
      
      expect(effective).toBeDefined();
      expect(effective.effectiveRole).toBeNull();
      expect(effective.sources).toHaveLength(0);
    });
    
    test('should return null role if user has no principals', async () => {
      getUserPrincipals.mockResolvedValue([]);
      
      const effective = await getEffectivePermissions({
        userId,
        resourceType: 'agent',
        resourceId
      });
      
      expect(effective).toBeDefined();
      expect(effective.effectiveRole).toBeNull();
      expect(effective.sources).toHaveLength(0);
    });
  });
  
  describe('findAccessibleResources', () => {
    beforeEach(async () => {
      // Reset the mock implementation for getUserPrincipals
      getUserPrincipals.mockReset();
      
      // Setup test data with multiple resources
      const resource1 = new mongoose.Types.ObjectId();
      const resource2 = new mongoose.Types.ObjectId();
      const resource3 = new mongoose.Types.ObjectId();
      
      // User can view resource 1
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId: resource1,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      // User can edit resource 2
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId: resource2,
        accessRoleId: 'agent_editor',
        grantedBy: grantedById
      });
      
      // Group can view resource 3
      await grantPermission({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId: resource3,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
    });
    
    test('should find resources user can view', async () => {
      // Mock getUserPrincipals to return user principal
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId }
      ]);
      
      const viewableResources = await findAccessibleResources({
        userId,
        resourceType: 'agent',
        requiredPermissions: RoleBits.VIEWER // 1 = VIEW
      });
      
      // Should find both resources (viewer role is included in editor role)
      expect(viewableResources).toHaveLength(2);
    });
    
    test('should find resources user can edit', async () => {
      // Mock getUserPrincipals to return user principal
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId }
      ]);
      
      const editableResources = await findAccessibleResources({
        userId,
        resourceType: 'agent',
        requiredPermissions: RoleBits.EDITOR // 3 = VIEW + EDIT
      });
      
      // Should find only one resource (only the editor resource has EDIT permission)
      expect(editableResources).toHaveLength(1);
    });
    
    test('should find resources accessible via group membership', async () => {
      // Mock getUserPrincipals to return user and group principals
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId },
        { principalType: 'group', principalId: groupId }
      ]);
      
      const viewableResources = await findAccessibleResources({
        userId,
        resourceType: 'agent',
        requiredPermissions: RoleBits.VIEWER // 1 = VIEW
      });
      
      // Should find all three resources
      expect(viewableResources).toHaveLength(3);
    });
    
    test('should return empty array for invalid permissions', async () => {
      getUserPrincipals.mockResolvedValue([
        { principalType: 'user', principalId: userId }
      ]);
      
      await expect(
        findAccessibleResources({
          userId,
          resourceType: 'agent',
          requiredPermissions: 'invalid'
        })
      ).rejects.toThrow('requiredPermissions must be a positive number');
      
      const nonExistentType = await findAccessibleResources({
        userId,
        resourceType: 'non_existent_type',
        requiredPermissions: RoleBits.VIEWER
      });
      
      expect(nonExistentType).toEqual([]);
    });
    
    test('should return empty array if user has no principals', async () => {
      getUserPrincipals.mockResolvedValue([]);
      
      const resources = await findAccessibleResources({
        userId,
        resourceType: 'agent',
        requiredPermissions: RoleBits.VIEWER
      });
      
      expect(resources).toEqual([]);
    });
  });
  
  describe('syncEntraPrincipal', () => {
    test('should create a new user if not found', async () => {
      const entraIdObject = {
        id: 'entra-user-123',
        name: 'Test Entra User',
        email: 'test@example.com',
        username: 'testuser'
      };
      
      const localId = await syncEntraPrincipal({
        entraIdObject,
        principalType: 'user'
      });
      
      expect(localId).toBeDefined();
      
      // Verify user was created
      const user = await User.findById(localId);
      expect(user).toBeDefined();
      expect(user.name).toBe(entraIdObject.name);
      expect(user.openidId).toBe(entraIdObject.id);
      expect(user.email).toBe(entraIdObject.email);
      expect(user.username).toBe(entraIdObject.username);
      expect(user.provider).toBe('openid');
      expect(user.emailVerified).toBe(true);
    });
    
    test('should update existing user name if changed', async () => {
      // Create a user first
      const entraObjectId = 'entra-user-123';
      const originalName = 'Original Name';
      const newName = 'Updated Name';
      
      const user = await User.create({
        name: originalName,
        openidId: entraObjectId,
        provider: 'openid',
        email: 'test@example.com',
        username: `entra-${entraObjectId}`,
        avatar: '',
        emailVerified: true
      });
      
      // Now sync with updated name
      const localId = await syncEntraPrincipal({
        entraIdObject: {
          id: entraObjectId,
          name: newName,
          email: 'test@example.com'
        },
        principalType: 'user'
      });
      
      expect(localId.toString()).toBe(user._id.toString());
      
      // Verify name was updated
      const updatedUser = await User.findById(localId);
      expect(updatedUser.name).toBe(newName);
    });
    
    test('should create a new group if not found', async () => {
      const entraIdObject = {
        id: 'entra-group-123',
        name: 'Test Entra Group'
      };
      
      const localId = await syncEntraPrincipal({
        entraIdObject,
        principalType: 'group'
      });
      
      expect(localId).toBeDefined();
      
      // Verify group was created
      const group = await Group.findById(localId);
      expect(group).toBeDefined();
      expect(group.name).toBe(entraIdObject.name);
      expect(group.idOnTheSource).toBe(entraIdObject.id);
      expect(group.source).toBe('entra');
      expect(group.memberIds).toEqual([]);
    });
    
    test('should update existing group name if changed', async () => {
      // Create a group first
      const entraObjectId = 'entra-group-123';
      const originalName = 'Original Group';
      const newName = 'Updated Group';
      
      const group = await Group.create({
        name: originalName,
        idOnTheSource: entraObjectId,
        source: 'entra',
        memberIds: []
      });
      
      // Now sync with updated name
      const localId = await syncEntraPrincipal({
        entraIdObject: {
          id: entraObjectId,
          name: newName
        },
        principalType: 'group'
      });
      
      expect(localId.toString()).toBe(group._id.toString());
      
      // Verify name was updated
      const updatedGroup = await Group.findById(localId);
      expect(updatedGroup.name).toBe(newName);
    });
    
    test('should throw error for invalid principal type', async () => {
      await expect(
        syncEntraPrincipal({
          entraIdObject: { id: 'test-123', name: 'Test' },
          principalType: 'invalid'
        })
      ).rejects.toThrow('Invalid principal type: invalid');
    });
    
    test('should throw error for missing email when creating user', async () => {
      await expect(
        syncEntraPrincipal({
          entraIdObject: { id: 'test-123', name: 'Test User' },
          principalType: 'user'
        })
      ).rejects.toThrow('Email is required for user creation');
    });
  });
  
  describe('grantProjectPermissionWithFanout', () => {
    const Agent = mongoose.model('Agent', new mongoose.Schema({
      projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' }
    }));
    
    beforeEach(async () => {
      // Create a project with agents
      const projectId = new mongoose.Types.ObjectId();
      
      // Create some agents in the project
      await Agent.create([
        { projectId },
        { projectId },
        { projectId }
      ]);
    });
    
    test('should grant project permission and create fan-out permissions for agents', async () => {
      const projectId = (await Agent.findOne().lean()).projectId;
      
      const result = await grantProjectPermissionWithFanout({
        principalType: 'user',
        principalId: userId,
        projectId,
        accessRoleId: 'project_viewer',
        grantedBy: grantedById
      });
      
      expect(result).toBeDefined();
      expect(result.projectPermission).toBeDefined();
      expect(result.childPermissions).toHaveLength(3);
      expect(result.agentCount).toBe(3);
      
      // Verify project permission
      const projectPerm = await AclEntry.findOne({
        principalType: 'user',
        principalId: userId,
        resourceType: 'project',
        resourceId: projectId
      });
      expect(projectPerm).toBeDefined();
      
      // Verify agent permissions
      const agentPerms = await AclEntry.find({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        inheritedFrom: projectId
      });
      expect(agentPerms).toHaveLength(3);
      
      // Verify correct agent role mapping
      const agentRole = await findRoleByIdentifier('agent_viewer');
      for (const perm of agentPerms) {
        expect(perm.permBits).toBe(agentRole.permBits);
        expect(perm.roleId.toString()).toBe(agentRole._id.toString());
        expect(perm.inheritedFrom.toString()).toBe(projectId.toString());
      }
    });
    
    test('should map project roles to corresponding agent roles', async () => {
      const projectId = (await Agent.findOne().lean()).projectId;
      
      // Test with project_editor role
      const result = await grantProjectPermissionWithFanout({
        principalType: 'user',
        principalId: userId,
        projectId,
        accessRoleId: 'project_editor',
        grantedBy: grantedById
      });
      
      expect(result).toBeDefined();
      
      // Verify agent permissions have editor role
      const agentPerms = await AclEntry.find({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        inheritedFrom: projectId
      });
      
      const agentRole = await findRoleByIdentifier('agent_editor');
      for (const perm of agentPerms) {
        expect(perm.permBits).toBe(agentRole.permBits);
        expect(perm.roleId.toString()).toBe(agentRole._id.toString());
      }
    });
    
    test('should throw error for non-project role', async () => {
      const projectId = new mongoose.Types.ObjectId();
      
      await expect(
        grantProjectPermissionWithFanout({
          principalType: 'user',
          principalId: userId,
          projectId,
          accessRoleId: 'agent_viewer', // Agent role instead of project role
          grantedBy: grantedById
        })
      ).rejects.toThrow('Role agent_viewer is for agent resources, not projects');
    });
  });
  
  describe('revokeProjectPermissionWithCleanup', () => {
    const projectId = new mongoose.Types.ObjectId();
    const agentIds = [
      new mongoose.Types.ObjectId(),
      new mongoose.Types.ObjectId(),
      new mongoose.Types.ObjectId()
    ];
    
    beforeEach(async () => {
      // Setup project permission
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'project',
        resourceId: projectId,
        accessRoleId: 'project_viewer',
        grantedBy: grantedById
      });
      
      // Setup inherited agent permissions
      const agentRole = await findRoleByIdentifier('agent_viewer');
      for (const agentId of agentIds) {
        await AclEntry.create({
          principalType: 'user',
          principalId: userId,
          principalModel: 'User',
          resourceType: 'agent',
          resourceId: agentId,
          permBits: agentRole.permBits,
          roleId: agentRole._id,
          grantedBy: grantedById,
          grantedAt: new Date(),
          inheritedFrom: projectId
        });
      }
      
      // Add some non-inherited permissions that should remain
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId: new mongoose.Types.ObjectId(),
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
    });
    
    test('should revoke project permission and clean up inherited permissions', async () => {
      const result = await revokeProjectPermissionWithCleanup({
        principalType: 'user',
        principalId: userId,
        projectId
      });
      
      expect(result).toBeDefined();
      expect(result.projectPermission).toBe(1);
      expect(result.childPermissions).toBe(3);
      
      // Verify project permission is gone
      const projectPerm = await AclEntry.findOne({
        principalType: 'user',
        principalId: userId,
        resourceType: 'project',
        resourceId: projectId
      });
      expect(projectPerm).toBeNull();
      
      // Verify inherited agent permissions are gone
      const agentPerms = await AclEntry.find({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        inheritedFrom: projectId
      });
      expect(agentPerms).toHaveLength(0);
      
      // Verify non-inherited permissions remain
      const otherPerms = await AclEntry.find({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        inheritedFrom: { $exists: false }
      });
      expect(otherPerms).toHaveLength(1);
    });
    
    test('should handle non-existent project permission gracefully', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const result = await revokeProjectPermissionWithCleanup({
        principalType: 'user',
        principalId: userId,
        projectId: nonExistentId
      });
      
      expect(result).toBeDefined();
      expect(result.projectPermission).toBe(0);
      expect(result.childPermissions).toBe(0);
    });
  });
  
  describe('resetResourcePermissions', () => {
    beforeEach(async () => {
      // Setup multiple permissions for a resource
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      await grantPermission({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_editor',
        grantedBy: grantedById
      });
      
      await grantPermission({
        principalType: 'public',
        principalId: null,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
    });
    
    test('should reset all permissions for a resource', async () => {
      const count = await resetResourcePermissions({
        resourceType: 'agent',
        resourceId
      });
      
      expect(count).toBe(3);
      
      // Verify no permissions remain
      const perms = await AclEntry.find({
        resourceType: 'agent',
        resourceId
      });
      expect(perms).toHaveLength(0);
    });
    
    test('should only reset permissions for the specified resource', async () => {
      const otherResourceId = new mongoose.Types.ObjectId();
      
      // Add permission for another resource
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId: otherResourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      // Reset the original resource
      await resetResourcePermissions({
        resourceType: 'agent',
        resourceId
      });
      
      // Verify the other resource's permission remains
      const perms = await AclEntry.find({
        resourceType: 'agent',
        resourceId: otherResourceId
      });
      expect(perms).toHaveLength(1);
    });
    
    test('should throw error for invalid resource ID', async () => {
      await expect(
        resetResourcePermissions({
          resourceType: 'agent',
          resourceId: 'not-a-valid-id'
        })
      ).rejects.toThrow('Invalid resource ID: not-a-valid-id');
    });
  });
  
  describe('isResourceAuthor', () => {
    test('should identify resource author by author field', () => {
      const resource = {
        author: userId
      };
      
      const isAuthor = isResourceAuthor({
        userId,
        resource
      });
      
      expect(isAuthor).toBe(true);
    });
    
    test('should identify resource author by authorId field', () => {
      const resource = {
        authorId: userId
      };
      
      const isAuthor = isResourceAuthor({
        userId,
        resource
      });
      
      expect(isAuthor).toBe(true);
    });
    
    test('should identify resource author by userId field', () => {
      const resource = {
        userId
      };
      
      const isAuthor = isResourceAuthor({
        userId,
        resource
      });
      
      expect(isAuthor).toBe(true);
    });
    
    test('should identify resource author by ownerId field', () => {
      const resource = {
        ownerId: userId
      };
      
      const isAuthor = isResourceAuthor({
        userId,
        resource
      });
      
      expect(isAuthor).toBe(true);
    });
    
    test('should return false if user is not the author', () => {
      const otherUserId = new mongoose.Types.ObjectId();
      const resource = {
        author: otherUserId
      };
      
      const isAuthor = isResourceAuthor({
        userId,
        resource
      });
      
      expect(isAuthor).toBe(false);
    });
    
    test('should return false if resource has no author field', () => {
      const resource = {
        name: 'Test Resource'
      };
      
      const isAuthor = isResourceAuthor({
        userId,
        resource
      });
      
      expect(isAuthor).toBe(false);
    });
    
    test('should handle comparison with different ObjectId/string formats', () => {
      // Test with string userId and ObjectId author
      const resource1 = {
        author: userId
      };
      const isAuthor1 = isResourceAuthor({
        userId: userId.toString(),
        resource: resource1
      });
      expect(isAuthor1).toBe(true);
      
      // Test with ObjectId userId and string author
      const resource2 = {
        author: userId.toString()
      };
      const isAuthor2 = isResourceAuthor({
        userId,
        resource: resource2
      });
      expect(isAuthor2).toBe(true);
    });
  });
  
  describe('getAvailableRoles', () => {
    test('should get all roles for a resource type', async () => {
      const roles = await getAvailableRoles({
        resourceType: 'agent'
      });
      
      expect(roles).toHaveLength(4);
      expect(roles.map(r => r.accessRoleId).sort()).toEqual([
        'agent_editor',
        'agent_manager',
        'agent_owner',
        'agent_viewer'
      ].sort());
    });
    
    test('should return empty array for non-existent resource type', async () => {
      const roles = await getAvailableRoles({
        resourceType: 'non_existent_type'
      });
      
      expect(roles).toEqual([]);
    });
  });

  describe('bulkUpdateResourcePermissions', () => {
    const otherUserId = new mongoose.Types.ObjectId();
    const anotherGroupId = new mongoose.Types.ObjectId();
    
    beforeEach(async () => {
      // Setup existing permissions for testing
      await grantPermission({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
      
      await grantPermission({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_editor',
        grantedBy: grantedById
      });
      
      await grantPermission({
        principalType: 'public',
        principalId: null,
        resourceType: 'agent',
        resourceId,
        accessRoleId: 'agent_viewer',
        grantedBy: grantedById
      });
    });
    
    test('should grant new permissions in bulk', async () => {
      const newResourceId = new mongoose.Types.ObjectId();
      const permissions = [
        {
          principalType: 'user',
          principalId: userId,
          accessRoleId: 'agent_viewer'
        },
        {
          principalType: 'user',
          principalId: otherUserId,
          accessRoleId: 'agent_editor'
        },
        {
          principalType: 'group',
          principalId: groupId,
          accessRoleId: 'agent_manager'
        }
      ];
      
      const results = await bulkUpdateResourcePermissions({
        resourceType: 'agent',
        resourceId: newResourceId,
        permissions,
        grantedBy: grantedById
      });
      
      expect(results.granted).toHaveLength(3);
      expect(results.updated).toHaveLength(0);
      expect(results.revoked).toHaveLength(0);
      expect(results.errors).toHaveLength(0);
      
      // Verify permissions were created
      const aclEntries = await AclEntry.find({
        resourceType: 'agent',
        resourceId: newResourceId
      });
      expect(aclEntries).toHaveLength(3);
    });
    
    test('should update existing permissions in bulk', async () => {
      const permissions = [
        {
          principalType: 'user',
          principalId: userId,
          accessRoleId: 'agent_editor' // Upgrade from viewer to editor
        },
        {
          principalType: 'group',
          principalId: groupId,
          accessRoleId: 'agent_manager' // Upgrade from editor to manager
        },
        {
          principalType: 'public',
          accessRoleId: 'agent_viewer' // Keep same role
        }
      ];
      
      const results = await bulkUpdateResourcePermissions({
        resourceType: 'agent',
        resourceId,
        permissions,
        grantedBy: grantedById
      });
      
      expect(results.granted).toHaveLength(0);
      expect(results.updated).toHaveLength(2); // Only user and group updated, public stayed same
      expect(results.revoked).toHaveLength(0);
      expect(results.errors).toHaveLength(0);
      
      // Verify updates
      const userEntry = await AclEntry.findOne({
        principalType: 'user',
        principalId: userId,
        resourceType: 'agent',
        resourceId
      }).populate('roleId', 'accessRoleId');
      expect(userEntry.roleId.accessRoleId).toBe('agent_editor');
      
      const groupEntry = await AclEntry.findOne({
        principalType: 'group',
        principalId: groupId,
        resourceType: 'agent',
        resourceId
      }).populate('roleId', 'accessRoleId');
      expect(groupEntry.roleId.accessRoleId).toBe('agent_manager');
    });
    
    test('should revoke permissions not in the new list', async () => {
      const permissions = [
        {
          principalType: 'user',
          principalId: userId,
          accessRoleId: 'agent_viewer'
        }
        // Group and public permissions not included, should be revoked
      ];
      
      const results = await bulkUpdateResourcePermissions({
        resourceType: 'agent',
        resourceId,
        permissions,
        grantedBy: grantedById
      });
      
      expect(results.granted).toHaveLength(0);
      expect(results.updated).toHaveLength(0);
      expect(results.revoked).toHaveLength(2); // Group and public revoked
      expect(results.errors).toHaveLength(0);
      
      // Verify only user permission remains
      const remainingEntries = await AclEntry.find({
        resourceType: 'agent',
        resourceId
      });
      expect(remainingEntries).toHaveLength(1);
      expect(remainingEntries[0].principalType).toBe('user');
      expect(remainingEntries[0].principalId.toString()).toBe(userId.toString());
    });
    
    test('should handle mixed operations (grant, update, revoke)', async () => {
      const permissions = [
        {
          principalType: 'user',
          principalId: userId,
          accessRoleId: 'agent_manager' // Update existing
        },
        {
          principalType: 'user',
          principalId: otherUserId,
          accessRoleId: 'agent_viewer' // New permission
        }
        // Group and public permissions not included, should be revoked
      ];
      
      const results = await bulkUpdateResourcePermissions({
        resourceType: 'agent',
        resourceId,
        permissions,
        grantedBy: grantedById
      });
      
      expect(results.granted).toHaveLength(1); // New user
      expect(results.updated).toHaveLength(1); // Existing user updated
      expect(results.revoked).toHaveLength(2); // Group and public revoked
      expect(results.errors).toHaveLength(0);
      
      // Verify final state
      const finalEntries = await AclEntry.find({
        resourceType: 'agent',
        resourceId
      }).populate('roleId', 'accessRoleId');
      
      expect(finalEntries).toHaveLength(2);
      
      const userEntry = finalEntries.find(e => 
        e.principalId.toString() === userId.toString()
      );
      expect(userEntry.roleId.accessRoleId).toBe('agent_manager');
      
      const otherUserEntry = finalEntries.find(e => 
        e.principalId.toString() === otherUserId.toString()
      );
      expect(otherUserEntry.roleId.accessRoleId).toBe('agent_viewer');
    });
    
    test('should handle errors for invalid roles gracefully', async () => {
      const permissions = [
        {
          principalType: 'user',
          principalId: userId,
          accessRoleId: 'agent_viewer' // Valid
        },
        {
          principalType: 'user',
          principalId: otherUserId,
          accessRoleId: 'non_existent_role' // Invalid
        },
        {
          principalType: 'group',
          principalId: groupId,
          accessRoleId: 'project_viewer' // Wrong resource type
        }
      ];
      
      const results = await bulkUpdateResourcePermissions({
        resourceType: 'agent',
        resourceId,
        permissions,
        grantedBy: grantedById
      });
      
      expect(results.granted).toHaveLength(0);
      expect(results.updated).toHaveLength(0); // User permission unchanged
      expect(results.revoked).toHaveLength(1); // Public permission revoked
      expect(results.errors).toHaveLength(2); // Two invalid permissions
      
      // Check error details
      expect(results.errors[0].error).toContain('Role non_existent_role not found');
      expect(results.errors[1].error).toContain('Role project_viewer is for project resources, not agent');
    });
    
    test('should handle empty permissions array (revoke all)', async () => {
      const results = await bulkUpdateResourcePermissions({
        resourceType: 'agent',
        resourceId,
        permissions: [],
        grantedBy: grantedById
      });
      
      expect(results.granted).toHaveLength(0);
      expect(results.updated).toHaveLength(0);
      expect(results.revoked).toHaveLength(3); // All existing revoked
      expect(results.errors).toHaveLength(0);
      
      // Verify all permissions removed
      const remainingEntries = await AclEntry.find({
        resourceType: 'agent',
        resourceId
      });
      expect(remainingEntries).toHaveLength(0);
    });
    
    test('should throw error for invalid permissions array', async () => {
      await expect(
        bulkUpdateResourcePermissions({
          resourceType: 'agent',
          resourceId,
          permissions: 'not an array',
          grantedBy: grantedById
        })
      ).rejects.toThrow('permissions must be an array');
    });
    
    test('should throw error for invalid resource ID', async () => {
      await expect(
        bulkUpdateResourcePermissions({
          resourceType: 'agent',
          resourceId: 'invalid-id',
          permissions: [],
          grantedBy: grantedById
        })
      ).rejects.toThrow('Invalid resource ID: invalid-id');
    });
    
    test('should handle public permissions correctly', async () => {
      const permissions = [
        {
          principalType: 'public',
          accessRoleId: 'agent_editor' // Update public permission
        },
        {
          principalType: 'user',
          principalId: otherUserId,
          accessRoleId: 'agent_viewer' // New user permission
        }
        // Existing user and group permissions should be revoked
      ];
      
      const results = await bulkUpdateResourcePermissions({
        resourceType: 'agent',
        resourceId,
        permissions,
        grantedBy: grantedById
      });
      
      expect(results.granted).toHaveLength(1); // New user
      expect(results.updated).toHaveLength(1); // Public updated
      expect(results.revoked).toHaveLength(2); // Existing user and group revoked
      expect(results.errors).toHaveLength(0);
      
      // Verify public permission was updated
      const publicEntry = await AclEntry.findOne({
        principalType: 'public',
        resourceType: 'agent',
        resourceId
      }).populate('roleId', 'accessRoleId');
      
      expect(publicEntry).toBeDefined();
      expect(publicEntry.roleId.accessRoleId).toBe('agent_editor');
    });
    
    test('should work with different resource types', async () => {
      // Test with project resources
      const projectResourceId = new mongoose.Types.ObjectId();
      const permissions = [
        {
          principalType: 'user',
          principalId: userId,
          accessRoleId: 'project_viewer'
        },
        {
          principalType: 'group',
          principalId: groupId,
          accessRoleId: 'project_editor'
        }
      ];
      
      const results = await bulkUpdateResourcePermissions({
        resourceType: 'project',
        resourceId: projectResourceId,
        permissions,
        grantedBy: grantedById
      });
      
      expect(results.granted).toHaveLength(2);
      expect(results.updated).toHaveLength(0);
      expect(results.revoked).toHaveLength(0);
      expect(results.errors).toHaveLength(0);
      
      // Verify permissions were created with correct resource type
      const projectEntries = await AclEntry.find({
        resourceType: 'project',
        resourceId: projectResourceId
      });
      expect(projectEntries).toHaveLength(2);
      expect(projectEntries.every(e => e.resourceType === 'project')).toBe(true);
    });
  });
});