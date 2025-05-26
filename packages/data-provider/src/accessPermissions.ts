import { z } from 'zod';

/**
 * Granular Permission System Types for Agent Sharing
 * 
 * This file contains TypeScript interfaces and Zod schemas for the enhanced
 * agent permission system that supports sharing with specific users/groups
 * and Entra ID integration.
 */

// ===== ENUMS & CONSTANTS =====

/**
 * Principal types for permission system
 */
export type TPrincipalType = 'user' | 'group' | 'public';

/**
 * Source of the principal (local LibreChat or external Entra ID)
 */
export type TPrincipalSource = 'local' | 'entra';

/**
 * Access levels for agents
 */
export type TAccessLevel = 'none' | 'viewer' | 'editor' | 'owner';

/**
 * Permission bit constants for bitwise operations
 */
export const PERMISSION_BITS = {
  VIEW: 1,     // 001 - Can view and use agent
  EDIT: 2,     // 010 - Can modify agent settings  
  DELETE: 4,   // 100 - Can delete agent
  SHARE: 8,    // 1000 - Can share agent with others (future)
} as const;

/**
 * Standard access role IDs
 */
export const ACCESS_ROLE_IDS = {
  AGENT_VIEWER: 'agent_viewer',
  AGENT_EDITOR: 'agent_editor',
  AGENT_OWNER: 'agent_owner', // Future use
} as const;

// ===== ZOD SCHEMAS =====

/**
 * Principal schema - represents a user, group, or public access
 */
export const principalSchema = z.object({
  type: z.enum(['user', 'group', 'public']),
  id: z.string().optional(), // undefined for 'public' type
  name: z.string().optional(),
  email: z.string().optional(), // for user type
  source: z.enum(['local', 'entra']).optional(),
  avatar: z.string().optional(),
});

/**
 * Access role schema - defines named permission sets
 */
export const accessRoleSchema = z.object({
  accessRoleId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  resourceType: z.string().default('agent'),
  permBits: z.number(),
});

/**
 * Permission entry schema - represents a single ACL entry
 */
export const permissionEntrySchema = z.object({
  id: z.string(),
  principalType: z.enum(['user', 'group', 'public']),
  principalId: z.string().optional(), // undefined for 'public'
  principalName: z.string().optional(),
  role: accessRoleSchema,
  grantedBy: z.string(),
  grantedAt: z.string(), // ISO date string
  inheritedFrom: z.string().optional(), // for project-level inheritance
  source: z.enum(['local', 'entra']).optional(),
});

/**
 * Resource permissions response schema
 */
export const resourcePermissionsResponseSchema = z.object({
  resourceType: z.string(),
  resourceId: z.string(),
  permissions: z.array(permissionEntrySchema),
});

/**
 * Grant permission request schema
 */
export const grantPermissionRequestSchema = z.object({
  resourceType: z.string().default('agent'),
  resourceId: z.string(),
  principalType: z.enum(['user', 'group', 'public']),
  principalId: z.string().optional(), // undefined for 'public'
  accessRoleId: z.string(),
});

/**
 * Bulk update permissions request schema
 */
export const bulkUpdatePermissionsRequestSchema = z.object({
  resourceType: z.string().default('agent'),
  resourceId: z.string(),
  permissions: z.array(z.object({
    id: z.string().optional(), // for updates
    principalType: z.enum(['user', 'group', 'public']),
    principalId: z.string().optional(), // undefined for 'public'
    principalName: z.string().optional(), // for UI display
    accessRoleId: z.string(),
    action: z.enum(['grant', 'update', 'revoke']),
    source: z.enum(['local', 'entra']).optional(),
  })),
});

// ===== TYPESCRIPT TYPES =====

/**
 * Principal - represents a user, group, or public access
 */
export type TPrincipal = z.infer<typeof principalSchema>;

/**
 * Access role - defines named permission sets
 */
export type TAccessRole = z.infer<typeof accessRoleSchema>;

/**
 * Permission entry - represents a single ACL entry
 */
export type TPermissionEntry = z.infer<typeof permissionEntrySchema>;

/**
 * Resource permissions response
 */
export type TResourcePermissionsResponse = z.infer<typeof resourcePermissionsResponseSchema>;

/**
 * Grant permission request
 */
export type TGrantPermissionRequest = z.infer<typeof grantPermissionRequestSchema>;

/**
 * Bulk update permissions request
 */
export type TBulkUpdatePermissionsRequest = z.infer<typeof bulkUpdatePermissionsRequestSchema>;

/**
 * Principal search response
 */
export type TPrincipalSearchResponse = TPrincipal[];

/**
 * Available roles response
 */
export type TAvailableRolesResponse = {
  resourceType: string;
  roles: TAccessRole[];
};

// ===== UTILITY TYPES =====


/**
 * Permission check result
 */
export interface TPermissionCheck {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  accessLevel: TAccessLevel;
}

// ===== HELPER FUNCTIONS =====

/**
 * Convert permission bits to access level
 */
export function permBitsToAccessLevel(permBits: number): TAccessLevel {
  if ((permBits & PERMISSION_BITS.DELETE) > 0) return 'owner';
  if ((permBits & PERMISSION_BITS.EDIT) > 0) return 'editor';
  if ((permBits & PERMISSION_BITS.VIEW) > 0) return 'viewer';
  return 'none';
}

/**
 * Convert access role ID to permission bits
 */
export function accessRoleToPermBits(accessRoleId: string): number {
  switch (accessRoleId) {
    case ACCESS_ROLE_IDS.AGENT_VIEWER:
      return PERMISSION_BITS.VIEW;
    case ACCESS_ROLE_IDS.AGENT_EDITOR:
      return PERMISSION_BITS.VIEW | PERMISSION_BITS.EDIT;
    case ACCESS_ROLE_IDS.AGENT_OWNER:
      return PERMISSION_BITS.VIEW | PERMISSION_BITS.EDIT | PERMISSION_BITS.DELETE;
    default:
      return PERMISSION_BITS.VIEW;
  }
}