/**
 * Mock data for development of agent sharing functionality
 * 
 * Reason: Centralizes mock data to avoid duplication and makes it easy to
 * switch between mock and real data during development.
 */

import { ACCESS_ROLE_IDS } from 'librechat-data-provider';
import type { 
  TPrincipal,
  TSelectedPrincipal,
  TAccessRole,
} from 'librechat-data-provider';

// Mock users from different sources (Entra ID and local)
export const MOCK_USERS: TPrincipal[] = [
  { id: 'user1', name: 'John Doe', email: 'john.doe@company.com', type: 'user', source: 'entra' },
  { id: 'user2', name: 'Jane Smith', email: 'jane.smith@company.com', type: 'user', source: 'entra' },
  { id: 'user3', name: 'Bob Wilson', email: 'bob.wilson@company.com', type: 'user', source: 'local' },
  { id: 'user4', name: 'Alice Johnson', email: 'alice@company.com', type: 'user', source: 'entra' },
  { id: 'user5', name: 'Mike Chen', email: 'mike.chen@company.com', type: 'user', source: 'entra' },
  { id: 'user6', name: 'Sarah Davis', email: 'sarah.davis@company.com', type: 'user', source: 'local' },
];

// Mock groups from different sources
export const MOCK_GROUPS: TPrincipal[] = [
  { id: 'group1', name: 'Development Team', type: 'group', source: 'entra' },
  { id: 'group2', name: 'QA Team', type: 'group', source: 'entra' },
  { id: 'group3', name: 'Product Owners', type: 'group', source: 'entra' },
  { id: 'group4', name: 'Local Admins', type: 'group', source: 'local' },
  { id: 'group5', name: 'Data Science Team', type: 'group', source: 'entra' },
];

// Available access roles for agents
export const MOCK_ACCESS_ROLES: TAccessRole[] = [
  { 
    accessRoleId: ACCESS_ROLE_IDS.AGENT_VIEWER, 
    name: 'Viewer', 
    description: 'Can view and use the agent',
    resourceType: 'agent',
    permBits: 1 
  },
  { 
    accessRoleId: ACCESS_ROLE_IDS.AGENT_EDITOR, 
    name: 'Editor', 
    description: 'Can modify agent settings and use it',
    resourceType: 'agent',
    permBits: 3 
  },
];

// Mock existing shares for demonstration
export const MOCK_CURRENT_SHARES: TSelectedPrincipal[] = [
  { 
    id: 'user2', 
    name: 'Jane Smith', 
    email: 'jane.smith@company.com',
    type: 'user', 
    source: 'entra',
    accessRoleId: ACCESS_ROLE_IDS.AGENT_EDITOR,
    tempId: 'share1'
  },
  { 
    id: 'group1', 
    name: 'Development Team', 
    type: 'group', 
    source: 'entra',
    accessRoleId: ACCESS_ROLE_IDS.AGENT_VIEWER,
    tempId: 'share2'
  },
];

/**
 * Get all available principals (users + groups)
 */
export const getAllMockPrincipals = (): TPrincipal[] => [...MOCK_USERS, ...MOCK_GROUPS];

/**
 * Simulate search API delay
 */
export const simulateSearchDelay = async (query: string): Promise<TPrincipal[]> => {
  // Reason: Simulates realistic API delay for better UX testing
  await new Promise(resolve => setTimeout(resolve, 300));
  
  const allPrincipals = getAllMockPrincipals();
  const queryLower = query.toLowerCase();
  
  return allPrincipals.filter(p => 
    p.name?.toLowerCase().includes(queryLower) || 
    (p.email && p.email.toLowerCase().includes(queryLower))
  );
};