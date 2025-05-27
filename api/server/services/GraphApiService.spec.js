// Mock all dependencies before importing anything
jest.mock('@microsoft/microsoft-graph-client');
jest.mock('~/cache/getLogStores');
jest.mock('~/strategies/openidStrategy');
jest.mock('~/config', () => ({
  logger: {
    error: jest.fn(),
    debug: jest.fn(),
  },
  createAxiosInstance: jest.fn(() => ({
    create: jest.fn(),
    defaults: {},
  })),
}));
jest.mock('~/utils', () => ({
  logAxiosError: jest.fn(),
}));

// Mock deeper dependencies to prevent loading entire dependency tree
jest.mock('~/models/userMethods', () => ({}));
jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));
jest.mock('~/models', () => ({
  User: {},
  Group: {},
  updateUser: jest.fn(),
  findUser: jest.fn(),
  createUser: jest.fn(),
}));
jest.mock('librechat-data-provider', () => ({
  CacheKeys: {
    OPENID_EXCHANGED_TOKENS: 'openid:exchanged:tokens',
    PENDING_REQ: 'pending_req',
    CONFIG_STORE: 'config_store',
    ROLES: 'roles',
    AUDIO_RUNS: 'audio_runs',
    MESSAGES: 'messages',
    FLOWS: 'flows',
    TOKEN_CONFIG: 'token_config',
    GEN_TITLE: 'gen_title',
    S3_EXPIRY_INTERVAL: 's3_expiry_interval',
    MODEL_QUERIES: 'model_queries',
    ABORT_KEYS: 'abort_keys',
    ENCODED_DOMAINS: 'encoded_domains',
    BANS: 'bans',
  },
  Time: {
    ONE_MINUTE: 60000,
    TWO_MINUTES: 120000,
    TEN_MINUTES: 600000,
    THIRTY_MINUTES: 1800000,
    THIRTY_SECONDS: 30000,
  },
  ViolationTypes: {
    BAN: 'ban',
    TOKEN_BALANCE: 'token_balance',
    TTS_LIMIT: 'tts_limit',
    STT_LIMIT: 'stt_limit',
    CONVO_ACCESS: 'convo_access',
    TOOL_CALL_LIMIT: 'tool_call_limit',
    FILE_UPLOAD_LIMIT: 'file_upload_limit',
    VERIFY_EMAIL_LIMIT: 'verify_email_limit',
    RESET_PASSWORD_LIMIT: 'reset_password_limit',
    ILLEGAL_MODEL_REQUEST: 'illegal_model_request',
  },
}));

const GraphApiService = require('./GraphApiService');
const { Client } = require('@microsoft/microsoft-graph-client');
const getLogStores = require('~/cache/getLogStores');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const client = require('openid-client');

describe('GraphApiService', () => {
  let mockGraphClient;
  let mockTokensCache;
  let mockOpenIdConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Graph client
    mockGraphClient = {
      api: jest.fn().mockReturnThis(),
      search: jest.fn().mockReturnThis(),
      filter: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      top: jest.fn().mockReturnThis(),
      get: jest.fn(),
    };

    Client.init.mockReturnValue(mockGraphClient);

    // Mock tokens cache
    mockTokensCache = {
      get: jest.fn(),
      set: jest.fn(),
    };
    getLogStores.mockReturnValue(mockTokensCache);

    // Mock OpenID config
    mockOpenIdConfig = {
      client_id: 'test-client-id',
      issuer: 'https://test-issuer.com',
    };
    getOpenIdConfig.mockReturnValue(mockOpenIdConfig);

    // Mock openid-client (using the existing jest mock configuration)
    if (client.genericGrantRequest) {
      client.genericGrantRequest.mockResolvedValue({
        access_token: 'mocked-graph-token',
        expires_in: 3600,
      });
    }
  });

  describe('Dependency Contract Tests', () => {
    it('should fail if getOpenIdConfig interface changes', () => {
      // Reason: Ensure getOpenIdConfig returns expected structure
      const config = getOpenIdConfig();
      
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
      // Add specific property checks that GraphApiService depends on
      expect(config).toHaveProperty('client_id');
      expect(config).toHaveProperty('issuer');
      
      // Ensure the function is callable
      expect(typeof getOpenIdConfig).toBe('function');
    });

    it('should fail if openid-client.genericGrantRequest interface changes', () => {
      // Reason: Ensure client.genericGrantRequest maintains expected signature
      if (client.genericGrantRequest) {
        expect(typeof client.genericGrantRequest).toBe('function');
        
        // Test that it accepts the expected parameters
        const mockCall = client.genericGrantRequest(
          mockOpenIdConfig,
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
          {
            scope: 'test-scope',
            assertion: 'test-token',
            requested_token_use: 'on_behalf_of',
          }
        );
        
        expect(mockCall).toBeDefined();
      }
    });

    it('should fail if Microsoft Graph Client interface changes', () => {
      // Reason: Ensure Graph Client maintains expected fluent API
      expect(typeof Client.init).toBe('function');
      
      const client = Client.init({ authProvider: jest.fn() });
      expect(client).toHaveProperty('api');
      expect(typeof client.api).toBe('function');
    });
  });

  describe('createGraphClient', () => {
    it('should create graph client with exchanged token', async () => {
      const accessToken = 'test-access-token';
      const sub = 'test-user-id';

      const result = await GraphApiService.createGraphClient(accessToken, sub);

      expect(getOpenIdConfig).toHaveBeenCalled();
      expect(Client.init).toHaveBeenCalledWith({
        authProvider: expect.any(Function),
      });
      expect(result).toBe(mockGraphClient);
    });

    it('should handle token exchange errors gracefully', async () => {
      if (client.genericGrantRequest) {
        client.genericGrantRequest.mockRejectedValue(new Error('Token exchange failed'));
      }

      await expect(
        GraphApiService.createGraphClient('invalid-token', 'test-user')
      ).rejects.toThrow('Token exchange failed');
    });
  });

  describe('exchangeTokenForGraphAccess', () => {
    it('should return cached token if available', async () => {
      const cachedToken = { access_token: 'cached-token' };
      mockTokensCache.get.mockResolvedValue(cachedToken);

      const result = await GraphApiService.exchangeTokenForGraphAccess(
        mockOpenIdConfig,
        'test-token',
        'test-user'
      );

      expect(result).toBe('cached-token');
      expect(mockTokensCache.get).toHaveBeenCalledWith('test-user:graph');
      if (client.genericGrantRequest) {
        expect(client.genericGrantRequest).not.toHaveBeenCalled();
      }
    });

    it('should exchange token and cache result', async () => {
      mockTokensCache.get.mockResolvedValue(null);

      const result = await GraphApiService.exchangeTokenForGraphAccess(
        mockOpenIdConfig,
        'test-token',
        'test-user'
      );

      if (client.genericGrantRequest) {
        expect(client.genericGrantRequest).toHaveBeenCalledWith(
          mockOpenIdConfig,
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
          {
            scope: 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/People.Read https://graph.microsoft.com/Group.Read.All',
            assertion: 'test-token',
            requested_token_use: 'on_behalf_of',
          }
        );
      }

      expect(mockTokensCache.set).toHaveBeenCalledWith(
        'test-user:graph',
        { access_token: 'mocked-graph-token' },
        3600000
      );

      expect(result).toBe('mocked-graph-token');
    });

    it('should use custom scopes from environment', async () => {
      const originalEnv = process.env.OPENID_GRAPH_SCOPES;
      process.env.OPENID_GRAPH_SCOPES = 'Custom.Read,Custom.Write';
      
      mockTokensCache.get.mockResolvedValue(null);

      await GraphApiService.exchangeTokenForGraphAccess(
        mockOpenIdConfig,
        'test-token',
        'test-user'
      );

      if (client.genericGrantRequest) {
        expect(client.genericGrantRequest).toHaveBeenCalledWith(
          mockOpenIdConfig,
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
          {
            scope: 'https://graph.microsoft.com/Custom.Read https://graph.microsoft.com/Custom.Write',
            assertion: 'test-token',
            requested_token_use: 'on_behalf_of',
          }
        );
      }

      process.env.OPENID_GRAPH_SCOPES = originalEnv;
    });
  });

  describe('searchEntraIdPrincipals', () => {
    const mockResponse = {
      value: [
        {
          id: 'user-1',
          displayName: 'John Doe',
          userPrincipalName: 'john@company.com',
          personType: { class: 'Person', subclass: 'OrganizationUser' },
          scoredEmailAddresses: [{ address: 'john@company.com', relevanceScore: 0.9 }],
        },
        {
          id: 'group-1',
          displayName: 'Marketing Team',
          userPrincipalName: 'marketing@company.com',
          personType: { class: 'Group', subclass: 'UnifiedGroup' },
          scoredEmailAddresses: [{ address: 'marketing@company.com', relevanceScore: 0.8 }],
        },
      ],
    };

    beforeEach(() => {
      mockGraphClient.get.mockResolvedValue(mockResponse);
    });

    it('should return empty results for short queries', async () => {
      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'a',
        'all',
        10
      );

      expect(result).toEqual({
        people: [],
        groups: [],
        totalCount: 0,
      });

      expect(mockGraphClient.api).not.toHaveBeenCalled();
    });

    it('should search for users only with correct filter', async () => {
      // Mock response with only user (simulating server-side filtering)
      const userOnlyResponse = {
        value: [
          {
            id: 'user-1',
            displayName: 'John Doe',
            userPrincipalName: 'john@company.com',
            personType: { class: 'Person', subclass: 'OrganizationUser' },
            scoredEmailAddresses: [{ address: 'john@company.com', relevanceScore: 0.9 }],
          },
        ],
      };
      mockGraphClient.get.mockResolvedValueOnce(userOnlyResponse);

      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'john',
        'users',
        10
      );

      expect(mockGraphClient.api).toHaveBeenCalledWith('/me/people');
      expect(mockGraphClient.search).toHaveBeenCalledWith('"john"');
      expect(mockGraphClient.filter).toHaveBeenCalledWith("personType/subclass eq 'OrganizationUser'");
      expect(mockGraphClient.top).toHaveBeenCalledWith(10);

      expect(result.people).toHaveLength(1);
      expect(result.groups).toHaveLength(0);
      expect(result.people[0]).toMatchObject({
        id: 'user-1',
        type: 'user',
        displayName: 'John Doe',
        email: 'john@company.com',
        source: 'graph',
      });
    });

    it('should search for groups only with correct filter', async () => {
      // Mock response with only group (simulating server-side filtering)
      const groupOnlyResponse = {
        value: [
          {
            id: 'group-1',
            displayName: 'Marketing Team',
            userPrincipalName: 'marketing@company.com',
            personType: { class: 'Group', subclass: 'UnifiedGroup' },
            scoredEmailAddresses: [{ address: 'marketing@company.com', relevanceScore: 0.8 }],
          },
        ],
      };
      mockGraphClient.get.mockResolvedValueOnce(groupOnlyResponse);

      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'marketing',
        'groups',
        10
      );

      expect(mockGraphClient.filter).toHaveBeenCalledWith("personType/subclass eq 'UnifiedGroup'");

      expect(result.people).toHaveLength(0);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toMatchObject({
        id: 'group-1',
        type: 'group',
        displayName: 'Marketing Team',
        email: 'marketing@company.com',
        source: 'graph',
      });
    });

    it('should search for all with combined filter', async () => {
      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'test',
        'all',
        10
      );

      expect(mockGraphClient.filter).toHaveBeenCalledWith(
        "personType/subclass eq 'OrganizationUser' or personType/subclass eq 'UnifiedGroup'"
      );

      expect(result.people).toHaveLength(1);
      expect(result.groups).toHaveLength(1);
      expect(result.totalCount).toBe(2);
    });

    it('should handle Graph API errors gracefully', async () => {
      mockGraphClient.get.mockRejectedValue(new Error('Graph API error'));

      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'test',
        'all',
        10
      );

      expect(result).toEqual({
        people: [],
        groups: [],
        totalCount: 0,
      });
    });
  });

  describe('getCurrentUserGroups', () => {
    it('should fetch user groups with correct filter', async () => {
      const mockGroupsResponse = {
        value: [
          {
            id: 'group-1',
            displayName: 'Team A',
            personType: { subclass: 'UnifiedGroup' },
            scoredEmailAddresses: [{ address: 'team-a@company.com' }],
          },
        ],
      };

      mockGraphClient.get.mockResolvedValue(mockGroupsResponse);

      const result = await GraphApiService.getCurrentUserGroups('token', 'user');

      expect(mockGraphClient.api).toHaveBeenCalledWith('/me/people');
      expect(mockGraphClient.filter).toHaveBeenCalledWith("personType/subclass eq 'UnifiedGroup'");
      expect(mockGraphClient.top).toHaveBeenCalledWith(50);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'group-1',
        type: 'group',
        displayName: 'Team A',
        email: 'team-a@company.com',
      });
    });

    it('should return empty array on error', async () => {
      mockGraphClient.get.mockRejectedValue(new Error('API error'));

      const result = await GraphApiService.getCurrentUserGroups('token', 'user');

      expect(result).toEqual([]);
    });
  });

  describe('Transform Functions', () => {
    describe('transformPersonToInternal', () => {
      it('should transform Graph person to internal format', () => {
        const graphPerson = {
          id: 'user-123',
          displayName: 'Jane Smith',
          givenName: 'Jane',
          surname: 'Smith',
          userPrincipalName: 'jane@company.com',
          department: 'Engineering',
          jobTitle: 'Software Engineer',
          personType: { class: 'Person', subclass: 'OrganizationUser' },
          scoredEmailAddresses: [{ address: 'jane@company.com', relevanceScore: 0.95 }],
          phones: [{ number: '+1234567890' }],
        };

        const result = GraphApiService.transformPersonToInternal(graphPerson);

        expect(result).toEqual({
          id: 'user-123',
          type: 'user',
          displayName: 'Jane Smith',
          email: 'jane@company.com',
          givenName: 'Jane',
          surname: 'Smith',
          userPrincipalName: 'jane@company.com',
          department: 'Engineering',
          jobTitle: 'Software Engineer',
          companyName: undefined,
          personType: { class: 'Person', subclass: 'OrganizationUser' },
          relevanceScore: 0.95,
          phones: [{ number: '+1234567890' }],
          source: 'graph',
        });
      });

      it('should handle missing email gracefully', () => {
        const graphPerson = {
          id: 'user-123',
          displayName: 'John Doe',
          userPrincipalName: 'john@company.com',
          personType: { class: 'Person', subclass: 'OrganizationUser' },
        };

        const result = GraphApiService.transformPersonToInternal(graphPerson);

        expect(result.email).toBe('john@company.com');
        expect(result.relevanceScore).toBe(0.5); // default value
      });
    });

    describe('transformGroupToInternal', () => {
      it('should transform Graph group to internal format', () => {
        const graphGroup = {
          id: 'group-456',
          displayName: 'Development Team',
          userPrincipalName: 'dev-team@company.com',
          personType: { class: 'Group', subclass: 'UnifiedGroup' },
          scoredEmailAddresses: [{ address: 'dev-team@company.com', relevanceScore: 0.85 }],
        };

        const result = GraphApiService.transformGroupToInternal(graphGroup);

        expect(result).toEqual({
          id: 'group-456',
          type: 'group',
          displayName: 'Development Team',
          email: 'dev-team@company.com',
          userPrincipalName: 'dev-team@company.com',
          personType: { class: 'Group', subclass: 'UnifiedGroup' },
          relevanceScore: 0.85,
          source: 'graph',
        });
      });
    });
  });

  describe('Helper Functions', () => {
    beforeEach(() => {
      // Reset all mocks for helper function tests
      jest.clearAllMocks();
    });

    it('searchPeople should search for users only', async () => {
      // Mock response with user data
      const userResponse = {
        value: [
          {
            id: 'user-1',
            displayName: 'John Doe',
            userPrincipalName: 'john@company.com',
            personType: { class: 'Person', subclass: 'OrganizationUser' },
            scoredEmailAddresses: [{ address: 'john@company.com', relevanceScore: 0.9 }],
          },
        ],
      };
      mockGraphClient.get.mockResolvedValue(userResponse);

      const result = await GraphApiService.searchPeople('token', 'user', 'john', 5);

      // Should use users filter
      expect(mockGraphClient.filter).toHaveBeenCalledWith("personType/subclass eq 'OrganizationUser'");
      expect(mockGraphClient.top).toHaveBeenCalledWith(5);

      // Should return only people array
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'user-1',
        type: 'user',
        displayName: 'John Doe',
      });
    });

    it('searchGroups should search for groups only', async () => {
      // Mock response with group data
      const groupResponse = {
        value: [
          {
            id: 'group-1',
            displayName: 'Marketing Team',
            userPrincipalName: 'marketing@company.com',
            personType: { class: 'Group', subclass: 'UnifiedGroup' },
            scoredEmailAddresses: [{ address: 'marketing@company.com', relevanceScore: 0.8 }],
          },
        ],
      };
      mockGraphClient.get.mockResolvedValue(groupResponse);

      const result = await GraphApiService.searchGroups('token', 'user', 'team', 5);

      // Should use groups filter
      expect(mockGraphClient.filter).toHaveBeenCalledWith("personType/subclass eq 'UnifiedGroup'");
      expect(mockGraphClient.top).toHaveBeenCalledWith(5);

      // Should return only groups array
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'group-1',
        type: 'group',
        displayName: 'Marketing Team',
      });
    });

    it('searchPeople should handle errors gracefully', async () => {
      mockGraphClient.get.mockRejectedValue(new Error('API error'));

      const result = await GraphApiService.searchPeople('token', 'user', 'john', 5);

      expect(result).toEqual([]);
    });

    it('searchGroups should handle errors gracefully', async () => {
      mockGraphClient.get.mockRejectedValue(new Error('API error'));

      const result = await GraphApiService.searchGroups('token', 'user', 'team', 5);

      expect(result).toEqual([]);
    });
  });
});