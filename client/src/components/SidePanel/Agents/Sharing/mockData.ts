/**
 * Mock data for development of agent sharing functionality
 * 
 * Reason: Centralizes mock data to avoid duplication and makes it easy to
 * switch between mock and real data during development.
 */

import { ACCESS_ROLE_IDS } from 'librechat-data-provider';
import type { 
  TPrincipal,
  TAccessRole,
} from 'librechat-data-provider';

// Mock users from different sources (Entra ID and local)
export const MOCK_USERS: TPrincipal[] = [
  { id: 'user1', name: 'John Doe', email: 'john.doe@company.com', type: 'user', source: 'entra', avatar:"/images/6818c36f96708c25b6675dd4/dc48102ec3a1a8d8892462a3332791fa44c6502f37510f4cc03d9ad39c6fc328.png" },
  { id: 'user12', name: 'John 2', email: 'john.2@company.com', type: 'user', source: 'entra' },
  { id: 'user13', name: 'John 3', email: 'john.3@company.com', type: 'user', source: 'entra' },
  { id: 'user14', name: 'John 4', email: 'john.4@company.com', type: 'user', source: 'entra' },
  { id: 'user15', name: 'John 5', email: 'john.5@company.com', type: 'user', source: 'entra' },
  { id: 'user16', name: 'John 6', email: 'john.6@company.com', type: 'user', source: 'entra' },
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
export const MOCK_CURRENT_SHARES: TPrincipal[] = [
  { 
    id: 'user2', 
    name: 'Jane Smith', 
    email: 'jane.smith@company.com',
    type: 'user', 
    source: 'entra',
    
   
  },
  { 
    id: 'group1', 
    name: 'Development Team', 
    type: 'group', 
    source: 'entra',
    
  },
];

/**
 * Get all available principals (users + groups)
 */
export const getAllMockPrincipals = (): TPrincipal[] => [...MOCK_USERS, ...MOCK_GROUPS];

/**
 * Simulate search API delay with filtering
 */
export const simulateSearchDelay = async (
  query: string, 
  filterType: 'all' | 'user' | 'group' = 'all',
  selectedUsers: TPrincipal[] = []
): Promise<TPrincipal[]> => {
  // Reason: Simulates realistic API delay for better UX testing
  await new Promise(resolve => setTimeout(resolve, 300));
  
  const allPrincipals = getAllMockPrincipals();
  const queryLower = query.toLowerCase();
  
  let filtered = allPrincipals.filter(p => 
    p.name?.toLowerCase().includes(queryLower) || 
    (p.email && p.email.toLowerCase().includes(queryLower))
  );
  
  // Filter by type if not 'all'
  if (filterType !== 'all') {
    filtered = filtered.filter(p => p.type === filterType);
  }
  
  // Filter out already selected principals
  const selectedIds = selectedUsers.map(s => s.id);
  filtered = filtered.filter(p => !selectedIds.includes(p.id));
  
  return filtered.slice(0, 10); // Limit results for performance
};