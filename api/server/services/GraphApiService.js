const { Client } = require('@microsoft/microsoft-graph-client');
const getLogStores = require('~/cache/getLogStores');
const { CacheKeys } = require('librechat-data-provider');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const { logger } = require('~/config');
const client = require('openid-client');

/**
 * Creates a Microsoft Graph client with on-behalf-of token exchange
 * @param {string} accessToken - OpenID Connect access token from user
 * @param {string} sub - Subject identifier from token claims
 * @returns {Promise<Client>} Authenticated Graph API client
 */
const createGraphClient = async (accessToken, sub) => {
  try {
    // Reason: Use existing OpenID configuration and token exchange pattern from openidStrategy.js
    const openidConfig = getOpenIdConfig();
    const exchangedToken = await exchangeTokenForGraphAccess(openidConfig, accessToken, sub);
    
    const graphClient = Client.init({
      authProvider: (done) => {
        done(null, exchangedToken);
      },
    });

    return graphClient;
  } catch (error) {
    logger.error('[createGraphClient] Error creating Graph client:', error);
    throw error;
  }
};

/**
 * Exchange OpenID token for Graph API access using on-behalf-of flow
 * Similar to exchangeAccessTokenIfNeeded in openidStrategy.js but for Graph scopes
 * @param {Configuration} config - OpenID configuration
 * @param {string} accessToken - Original access token
 * @param {string} sub - Subject identifier
 * @returns {Promise<string>} Graph API access token
 */
const exchangeTokenForGraphAccess = async (config, accessToken, sub) => {
  try {
    const tokensCache = getLogStores(CacheKeys.OPENID_EXCHANGED_TOKENS);
    const cacheKey = `${sub}:graph`;

    // Check cache first
    const cachedToken = await tokensCache.get(cacheKey);
    if (cachedToken) {
      return cachedToken.access_token;
    }

    // Reason: Use Graph API specific scopes for on-behalf-of flow
    const graphScopes = process.env.OPENID_GRAPH_SCOPES || 'User.Read,People.Read,Group.Read.All';
    const scopeString = graphScopes.split(',')
      .map(scope => `https://graph.microsoft.com/${scope}`)
      .join(' ');

    const grantResponse = await client.genericGrantRequest(
      config,
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
      {
        scope: scopeString,
        assertion: accessToken,
        requested_token_use: 'on_behalf_of',
      },
    );

    // Cache the exchanged token
    await tokensCache.set(
      cacheKey,
      {
        access_token: grantResponse.access_token,
      },
      grantResponse.expires_in * 1000,
    );

    return grantResponse.access_token;
  } catch (error) {
    logger.error('[exchangeTokenForGraphAccess] Token exchange failed:', error);
    throw error;
  }
};

/**
 * Search for principals (people and groups) using Microsoft Graph People API
 * Uses single /me/people endpoint with server-side filtering by personType subclass
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @param {string} query - Search query string
 * @param {string} type - Type filter ('users', 'groups', or 'all')
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Object>} Object containing people and groups arrays
 */
const searchEntraIdPrincipals = async (accessToken, sub, query, type = 'all', limit = 10) => {
  try {
    const results = {
      people: [],
      groups: [],
      totalCount: 0,
    };

    if (!query || query.trim().length < 2) {
      return results;
    }

    const graphClient = await createGraphClient(accessToken, sub);
    
    // Reason: Use single /me/people endpoint for both users and groups with intelligent relevance ranking
    let apiCall = graphClient
      .api('/me/people')
      .search(`"${query}"`)
      .select('id,displayName,givenName,surname,userPrincipalName,jobTitle,department,companyName,scoredEmailAddresses,personType,phones');

    // Reason: Apply dynamic OData filtering by subclass for better performance and specificity
    let filter = '';
    if (type === 'users') {
      // Filter for OrganizationUser subclass (users)
      filter = "personType/subclass eq 'OrganizationUser'";
    } else if (type === 'groups') {
      // Filter for UnifiedGroup subclass (groups)
      filter = "personType/subclass eq 'UnifiedGroup'";
    } else if (type === 'all') {
      // Combined filter for both users and groups
      filter = "personType/subclass eq 'OrganizationUser' or personType/subclass eq 'UnifiedGroup'";
    }

    if (filter) {
      apiCall = apiCall.filter(filter);
    }

    apiCall = apiCall.top(limit);

    const searchResponse = await apiCall.get();
    const allResults = searchResponse.value || [];

    // Reason: Process results based on personType for consistent API response format
    for (const item of allResults) {
      if (item.personType?.subclass === 'OrganizationUser') {
        results.people.push(transformPersonToInternal(item));
      } else if (item.personType?.subclass === 'UnifiedGroup') {
        results.groups.push(transformGroupToInternal(item));
      }
    }

    results.totalCount = results.people.length + results.groups.length;
    return results;
  } catch (error) {
    logger.error('[searchEntraIdPrincipals] Error searching principals:', error);
    return {
      people: [],
      groups: [],
      totalCount: 0,
    };
  }
};

/**
 * Get current user's group memberships from Microsoft Graph
 * Uses /me/people endpoint to get groups the user is a member of
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @returns {Promise<Array>} Array of groups the user belongs to
 */
const getCurrentUserGroups = async (accessToken, sub) => {
  try {
    const graphClient = await createGraphClient(accessToken, sub);
    
    // Reason: Use /me/people endpoint with server-side filtering for UnifiedGroup subclass
    const groupsResponse = await graphClient
      .api('/me/people')
      .filter("personType/subclass eq 'UnifiedGroup'")
      .select('id,displayName,userPrincipalName,personType,scoredEmailAddresses')
      .top(50) // Reasonable limit for user's groups
      .get();

    // Transform Graph API response to internal format
    return (groupsResponse.value || []).map(transformGroupToInternal);
  } catch (error) {
    logger.error('[getCurrentUserGroups] Error fetching user groups:', error);
    // Reason: Graceful degradation - return empty array on Graph API failure
    return [];
  }
};

/**
 * Transform Graph API person object to internal principal format
 * @param {Object} person - Person object from Graph API People endpoint
 * @returns {Object} Internal principal format
 */
const transformPersonToInternal = (person) => {
  const primaryEmail = person.scoredEmailAddresses?.[0]?.address || person.userPrincipalName;
  
  return {
    id: person.id,
    type: 'user',
    displayName: person.displayName,
    email: primaryEmail,
    givenName: person.givenName,
    surname: person.surname,
    userPrincipalName: person.userPrincipalName,
    department: person.department,
    jobTitle: person.jobTitle,
    companyName: person.companyName,
    personType: {
      class: person.personType?.class,
      subclass: person.personType?.subclass,
    },
    relevanceScore: person.scoredEmailAddresses?.[0]?.relevanceScore || 0.5,
    phones: person.phones || [],
    source: 'graph',
  };
};

/**
 * Transform Graph API group object to internal principal format
 * @param {Object} group - Group object from Graph API People endpoint
 * @returns {Object} Internal principal format
 */
const transformGroupToInternal = (group) => {
  const primaryEmail = group.scoredEmailAddresses?.[0]?.address || group.userPrincipalName;
  
  return {
    id: group.id,
    type: 'group',
    displayName: group.displayName,
    email: primaryEmail,
    userPrincipalName: group.userPrincipalName,
    personType: {
      class: group.personType?.class,
      subclass: group.personType?.subclass,
    },
    relevanceScore: group.scoredEmailAddresses?.[0]?.relevanceScore || 0.5,
    source: 'graph',
  };
};

/**
 * Search for people only using Microsoft Graph People API
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of people matching the search query
 */
const searchPeople = async (accessToken, sub, query, limit = 10) => {
  try {
    const result = await searchEntraIdPrincipals(accessToken, sub, query, 'users', limit);
    return result.people;
  } catch (error) {
    logger.error('[searchPeople] Error searching people:', error);
    return [];
  }
};

/**
 * Search for groups only using Microsoft Graph People API
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of groups matching the search query
 */
const searchGroups = async (accessToken, sub, query, limit = 10) => {
  try {
    const result = await searchEntraIdPrincipals(accessToken, sub, query, 'groups', limit);
    return result.groups;
  } catch (error) {
    logger.error('[searchGroups] Error searching groups:', error);
    return [];
  }
};

/**
 * Test Graph API connectivity and permissions
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @returns {Promise<Object>} Test results with available permissions
 */
const testGraphApiAccess = async (accessToken, sub) => {
  try {
    const graphClient = await createGraphClient(accessToken, sub);
    const results = {
      userAccess: false,
      peopleAccess: false,
      groupsAccess: false,
      errors: [],
    };

    // Test User.Read permission
    try {
      await graphClient.api('/me').select('id,displayName').get();
      results.userAccess = true;
    } catch (error) {
      results.errors.push(`User.Read: ${error.message}`);
    }

    // Test People.Read permission with OrganizationUser filter
    try {
      await graphClient.api('/me/people')
        .filter("personType/subclass eq 'OrganizationUser'")
        .top(1)
        .get();
      results.peopleAccess = true;
    } catch (error) {
      results.errors.push(`People.Read (OrganizationUser): ${error.message}`);
    }

    // Test People.Read permission with UnifiedGroup filter
    try {
      await graphClient.api('/me/people')
        .filter("personType/subclass eq 'UnifiedGroup'")
        .top(1)
        .get();
      results.groupsAccess = true;
    } catch (error) {
      results.errors.push(`People.Read (UnifiedGroup): ${error.message}`);
    }

    return results;
  } catch (error) {
    logger.error('[testGraphApiAccess] Error testing Graph API access:', error);
    return {
      userAccess: false,
      peopleAccess: false,
      groupsAccess: false,
      errors: [error.message],
    };
  }
};

module.exports = {
  createGraphClient,
  searchEntraIdPrincipals,
  searchPeople,
  searchGroups,
  getCurrentUserGroups,
  transformPersonToInternal,
  transformGroupToInternal,
  testGraphApiAccess,
  exchangeTokenForGraphAccess,
};