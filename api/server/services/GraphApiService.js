const { Client } = require('@microsoft/microsoft-graph-client');
const getLogStores = require('~/cache/getLogStores');
const { CacheKeys } = require('librechat-data-provider');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const { logger } = require('~/config');
const client = require('openid-client');

/**
 * @import { TPrincipalSearchResult } from 'librechat-data-provider'
 */

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
 * Search for principals (people and groups) using Microsoft Graph API
 * Uses searchContacts first, then searchUsers and searchGroups to fill remaining slots
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @param {string} query - Search query string
 * @param {string} type - Type filter ('users', 'groups', or 'all')
 * @param {number} limit - Maximum number of results
 * @returns {Promise<TPrincipalSearchResult[]>} Array of principal search results
 */
const searchEntraIdPrincipals = async (accessToken, sub, query, type = 'all', limit = 10) => {
  try {
    if (!query || query.trim().length < 2) {
      return [];
    }

    const graphClient = await createGraphClient(accessToken, sub);
    let allResults = [];

    // Step 1: Search contacts first (most relevant results from /me/people)
    // Reason: Map type parameter from 'users'/'groups' to 'user'/'group' for contacts function
    const contactType = type === 'users' ? 'user' : type === 'groups' ? 'group' : 'all';
    const contactResults = await searchContacts(graphClient, query, limit, contactType);
    allResults.push(...contactResults);

    // Step 2: If contacts already reach the limit, no need to call other functions
    if (allResults.length >= limit) {
      return allResults.slice(0, limit);
    }

    // Step 3: Search additional endpoints based on type filter
    if (type === 'users') {
      // Only search additional users from /users endpoint
      const userResults = await searchUsers(graphClient, query, limit);
      allResults.push(...userResults);
    } else if (type === 'groups') {
      // Only search additional groups from /groups endpoint
      const groupResults = await searchGroups(graphClient, query, limit);
      allResults.push(...groupResults);
    } else if (type === 'all') {
      // Search both users and groups with full limit, then merge
      const [userResults, groupResults] = await Promise.all([
        searchUsers(graphClient, query, limit),
        searchGroups(graphClient, query, limit)
      ]);
      
      allResults.push(...userResults, ...groupResults);
    }

    // Step 4: Remove duplicates based on idOnTheSource and apply final limit
    const seenIds = new Set();
    const uniqueResults = allResults.filter(result => {
      if (seenIds.has(result.idOnTheSource)) {
        return false;
      }
      seenIds.add(result.idOnTheSource);
      return true;
    });

    return uniqueResults.slice(0, limit);
  } catch (error) {
    logger.error('[searchEntraIdPrincipals] Error searching principals:', error);
    return [];
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
    source: 'entra',
    openidId: person.id, // Reason: Include openidId for duplicate removal against local users
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
    type: 'group',
    displayName: group.displayName,
    email: primaryEmail,
    userPrincipalName: group.userPrincipalName,
    personType: {
      class: group.personType?.class,
      subclass: group.personType?.subclass,
    },
    relevanceScore: group.scoredEmailAddresses?.[0]?.relevanceScore || 0.5,
    source: 'entra',
    idOnTheSource: group.id, // Reason: Include Entra ID for duplicate removal and mapping to group schema
  };
};



/**
 * Search for contacts (users and groups) using Microsoft Graph /me/people endpoint
 * Returns mapped TPrincipalSearchResult objects
 * @param {Client} graphClient - Authenticated Microsoft Graph client
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results (default: 10)
 * @param {string} type - Type filter ('user', 'group', or 'all') (default: 'all')
 * @returns {Promise<TPrincipalSearchResult[]>} Array of mapped contact results
 */
const searchContacts = async (graphClient, query, limit = 10, type = 'all') => {
  try {
    if (!query || query.trim().length < 2) {
      return [];
    }

    // Reason: Build dynamic filter based on type parameter
    let filter = '';
    if (type === 'user') {
      filter = "personType/subclass eq 'OrganizationUser'";
    } else if (type === 'group') {
      filter = "personType/class eq 'Group'";
    } else if (type === 'all') {
      filter = "(personType/subclass eq 'OrganizationUser') or (personType/class eq 'Group')";
    }

    let apiCall = graphClient
      .api('/me/people')
      .search(`"${query}"`)
      .select('id,displayName,givenName,surname,userPrincipalName,jobTitle,department,companyName,scoredEmailAddresses,personType,phones,mail')
      .top(limit);

    // Apply filter if specified
    if (filter) {
      apiCall = apiCall.filter(filter);
    }

    const contactsResponse = await apiCall.get();
    return (contactsResponse.value || []).map(mapContactToTPrincipalSearchResult);
  } catch (error) {
    logger.error('[searchContacts] Error searching contacts:', error);
    return [];
  }
};

/**
 * Search for users using Microsoft Graph /users endpoint
 * Returns mapped TPrincipalSearchResult objects
 * @param {Client} graphClient - Authenticated Microsoft Graph client
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results (default: 10)
 * @returns {Promise<TPrincipalSearchResult[]>} Array of mapped user results
 */
const searchUsers = async (graphClient, query, limit = 10) => {
  try {
    if (!query || query.trim().length < 2) {
      return [];
    }

    // Reason: Search users by display name, email, and user principal name
    const usersResponse = await graphClient
      .api('/users')
      .search(`"displayName:${query}" OR "userPrincipalName:${query}" OR "mail:${query}" OR "givenName:${query}" OR "surname:${query}"`)
      .select('id,displayName,givenName,surname,userPrincipalName,jobTitle,department,companyName,mail,phones')
      .top(limit)
      .get();

    return (usersResponse.value || []).map(mapUserToTPrincipalSearchResult);
  } catch (error) {
    logger.error('[searchUsers] Error searching users:', error);
    return [];
  }
};

/**
 * Search for groups using Microsoft Graph /groups endpoint
 * Returns mapped TPrincipalSearchResult objects, includes all group types
 * @param {Client} graphClient - Authenticated Microsoft Graph client
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results (default: 10)
 * @returns {Promise<TPrincipalSearchResult[]>} Array of mapped group results
 */
const searchGroups = async (graphClient, query, limit = 10) => {
  try {
    if (!query || query.trim().length < 2) {
      return [];
    }

    // Reason: Search all groups by display name and email without filtering group types
    const groupsResponse = await graphClient
      .api('/groups')
      .search(`"displayName:${query}" OR "mail:${query}" OR "mailNickname:${query}"`)
      .select('id,displayName,mail,mailNickname,description,groupTypes,resourceProvisioningOptions')
      .top(limit)
      .get();

    return (groupsResponse.value || []).map(mapGroupToTPrincipalSearchResult);
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
      usersEndpointAccess: false,
      groupsEndpointAccess: false,
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

    // Test /users endpoint access (requires User.Read.All or similar)
    try {
      await graphClient.api('/users')
        .search('"displayName:test"')
        .select('id,displayName,userPrincipalName')
        .top(1)
        .get();
      results.usersEndpointAccess = true;
    } catch (error) {
      results.errors.push(`Users endpoint: ${error.message}`);
    }

    // Test /groups endpoint access (requires Group.Read.All or similar)
    try {
      await graphClient.api('/groups')
        .search('"displayName:test"')
        .select('id,displayName,mail')
        .top(1)
        .get();
      results.groupsEndpointAccess = true;
    } catch (error) {
      results.errors.push(`Groups endpoint: ${error.message}`);
    }

    return results;
  } catch (error) {
    logger.error('[testGraphApiAccess] Error testing Graph API access:', error);
    return {
      userAccess: false,
      peopleAccess: false,
      groupsAccess: false,
      usersEndpointAccess: false,
      groupsEndpointAccess: false,
      errors: [error.message],
    };
  }
};

/**
 * Map Graph API user object to TPrincipalSearchResult format
 * @param {Object} user - Raw user object from Graph API
 * @returns {TPrincipalSearchResult} Mapped user result
 */
const mapUserToTPrincipalSearchResult = (user) => {
  return {
    id: null,
    type: 'user',
    name: user.displayName,
    email: user.mail,
    username: user.userPrincipalName,
    source: 'entra',
    idOnTheSource: user.id,
  };
};

/**
 * Map Graph API group object to TPrincipalSearchResult format
 * @param {Object} group - Raw group object from Graph API
 * @returns {TPrincipalSearchResult} Mapped group result
 */
const mapGroupToTPrincipalSearchResult = (group) => {
  return {
    id: null,
    type: 'group',
    name: group.displayName,
    email: group.mail,
    source: 'entra',
    idOnTheSource: group.id,
  };
};

/**
 * Map Graph API /me/people contact object to TPrincipalSearchResult format
 * Handles both user and group contacts from the people endpoint
 * @param {Object} contact - Raw contact object from Graph API /me/people
 * @returns {TPrincipalSearchResult} Mapped contact result
 */
const mapContactToTPrincipalSearchResult = (contact) => {
  const isGroup = contact.personType?.class === 'Group';
  const primaryEmail = contact.scoredEmailAddresses?.[0]?.address || contact.mail;

  return {
    id: null,
    type: isGroup ? 'group' : 'user',
    name: contact.displayName,
    email: primaryEmail,
    username: !isGroup ? contact.userPrincipalName : undefined,
    source: 'entra',
    idOnTheSource: contact.id,
  };
};

module.exports = {
  createGraphClient,
  searchEntraIdPrincipals,
  getCurrentUserGroups,
  transformPersonToInternal,
  transformGroupToInternal,
  testGraphApiAccess,
  exchangeTokenForGraphAccess,
};