const mongoose = require('mongoose');
const User = require('./User');
const Group = require('./Group');
const { searchUsers } = require('./userMethods');
const { logger } = require('~/config');

/**
 * Find a group by its ID
 * @param {string|mongoose.Types.ObjectId} groupId - The group ID
 * @param {Object} projection - Optional projection of fields to return
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Object|null>} The group document or null if not found
 */
const findGroupById = async function (groupId, projection = {}, session = null) {
  const query = Group.findOne({ _id: groupId }, projection);
  if (session) {
    query.session(session);
  }
  return await query.lean();
};

/**
 * Find a group by its external ID (e.g., Entra ID)
 * @param {string} idOnTheSource - The external ID
 * @param {string} source - The source ('entra' or 'local')
 * @param {Object} projection - Optional projection of fields to return
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Object|null>} The group document or null if not found
 */
const findGroupByExternalId = async function (idOnTheSource, source = 'entra', projection = {}, session = null) {
  const query = Group.findOne({ idOnTheSource, source }, projection);
  if (session) {
    query.session(session);
  }
  return await query.lean();
};

/**
 * Find groups by name pattern (case-insensitive partial match)
 * @param {string} namePattern - The name pattern to search for
 * @param {string} source - Optional source filter ('entra', 'local', or null for all)
 * @param {number} limit - Maximum number of results to return
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Array>} Array of matching groups
 */
const findGroupsByNamePattern = async function (namePattern, source = null, limit = 20, session = null) {
  const query = { name: new RegExp(namePattern, 'i') };
  if (source) {
    query.source = source;
  }

  const dbQuery = Group.find(query).limit(limit);
  if (session) {
    dbQuery.session(session);
  }
  return await dbQuery.lean();
};

/**
 * Find all groups a user is a member of
 * @param {string|mongoose.Types.ObjectId} userId - The user ID
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Array>} Array of groups the user is a member of
 */
const findGroupsByMemberId = async function (userId, session = null) {
  const query = Group.find({ memberIds: userId });
  if (session) {
    query.session(session);
  }
  return await query.lean();
};

/**
 * Create a new group
 * @param {Object} groupData - Group data including name, source, and optional idOnTheSource
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Object>} The created group
 */
const createGroup = async function (groupData, session = null) {
  const options = session ? { session } : {};
  return await Group.create([groupData], options).then(groups => groups[0]);
};

/**
 * Update or create a group by external ID
 * @param {string} idOnTheSource - The external ID
 * @param {string} source - The source ('entra' or 'local')
 * @param {Object} updateData - Data to update or set if creating
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Object>} The updated or created group
 */
const upsertGroupByExternalId = async function (idOnTheSource, source, updateData, session = null) {
  const options = { 
    new: true, 
    upsert: true 
  };
  
  if (session) {
    options.session = session;
  }
  
  return await Group.findOneAndUpdate(
    { idOnTheSource, source },
    { $set: updateData },
    options
  );
};

/**
 * Add a user to a group and maintain the two-way relationship
 * Updates both User.groupIds and Group.memberIds
 * 
 * @param {string|mongoose.Types.ObjectId} userId - The user ID
 * @param {string|mongoose.Types.ObjectId} groupId - The group ID to add
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<{user: Object, group: Object}>} The updated user and group documents
 */
const addUserToGroup = async function (userId, groupId, session = null) {
  const options = { new: true };
  if (session) {
    options.session = session;
  }
  
  // Update user and group, adding reciprocal references
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $addToSet: { groupIds: groupId } },
    options
  ).lean();
  
  const updatedGroup = await Group.findByIdAndUpdate(
    groupId,
    { $addToSet: { memberIds: userId } },
    options
  ).lean();
  
  return { user: updatedUser, group: updatedGroup };
};

/**
 * Remove a user from a group and maintain the two-way relationship
 * Updates both User.groupIds and Group.memberIds
 * 
 * @param {string|mongoose.Types.ObjectId} userId - The user ID
 * @param {string|mongoose.Types.ObjectId} groupId - The group ID to remove
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<{user: Object, group: Object}>} The updated user and group documents
 */
const removeUserFromGroup = async function (userId, groupId, session = null) {
  const options = { new: true };
  if (session) {
    options.session = session;
  }
  
  // Update user and group, removing reciprocal references
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $pull: { groupIds: groupId } },
    options
  ).lean();
  
  const updatedGroup = await Group.findByIdAndUpdate(
    groupId,
    { $pull: { memberIds: userId } },
    options
  ).lean();
  
  return { user: updatedUser, group: updatedGroup };
};

/**
 * Get all groups a user is a member of
 * @param {string|mongoose.Types.ObjectId} userId - The user ID
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Array>} Array of group documents
 */
const getUserGroups = async function (userId, session = null) {
  const query = User.findById(userId, { groupIds: 1 });
  if (session) {
    query.session(session);
  }
  const user = await query.lean();
  
  if (!user || !user.groupIds || user.groupIds.length === 0) {
    return [];
  }
  
  // Use our findGroupsByMemberId function instead of individual lookups
  return await findGroupsByMemberId(userId, session);
};

/**
 * Get a list of all principal identifiers for a user (user ID + group IDs + public)
 * For use in permission checks
 * @param {string|mongoose.Types.ObjectId} userId - The user ID
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Array<Object>>} Array of principal objects with type and id
 */
const getUserPrincipals = async function (userId, session = null) {
  const query = User.findById(userId, { groupIds: 1 });
  if (session) {
    query.session(session);
  }
  const user = await query.lean();
  
  if (!user) {
    return [];
  }
  
  // Start with the user's own ID
  const principals = [
    { principalType: 'user', principalId: user._id }
  ];
  
  // Add all groups the user is a member of
  if (user.groupIds && user.groupIds.length > 0) {
    user.groupIds.forEach(groupId => {
      principals.push({ principalType: 'group', principalId: groupId });
    });
  }
  
  // Always include the 'public' principal for public resources
  principals.push({ principalType: 'public', principalId: null });
  
  return principals;
};

/**
 * Sync a user's Entra ID group memberships
 * @param {string|mongoose.Types.ObjectId} userId - The user ID
 * @param {Array<Object>} entraGroups - Array of Entra groups with id and name
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Object>} The updated user with new group memberships
 */
const syncUserEntraGroups = async function (userId, entraGroups, session = null) {
  const options = { new: true };
  if (session) {
    options.session = session;
  }
  
  // Get the current user with their group memberships
  const query = User.findById(userId, { groupIds: 1 });
  if (session) {
    query.session(session);
  }
  const user = await query.lean();
  
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }
  
  // Track existing Entra groups to handle removals
  const entraIdMap = new Map();
  const addedGroups = [];
  const removedGroups = [];
  
  // Step 1: Create or update Entra groups and add the user
  for (const entraGroup of entraGroups) {
    entraIdMap.set(entraGroup.id, true);
    
    // Find or create the group
    let group = await findGroupByExternalId(entraGroup.id, 'entra', null, session);
    
    if (!group) {
      // Create a new local representation of the Entra group
      group = await createGroup({
        name: entraGroup.name,
        idOnTheSource: entraGroup.id,
        source: 'entra',
        memberIds: [userId]
      }, session);
      
      addedGroups.push(group);
    } else if (!group.memberIds?.includes(userId)) {
      // Add user to this group if not already a member
      const { group: updatedGroup } = await addUserToGroup(userId, group._id, session);
      addedGroups.push(updatedGroup);
    }
  }
  
  // Step 2: Find existing Entra groups for this user
  const groupsQuery = Group.find(
    { source: 'entra', memberIds: userId },
    { _id: 1, idOnTheSource: 1 }
  );
  if (session) {
    groupsQuery.session(session);
  }
  const existingGroups = await groupsQuery.lean();
  
  // Step 3: Remove user from Entra groups they're no longer a member of
  for (const group of existingGroups) {
    if (group.idOnTheSource && !entraIdMap.has(group.idOnTheSource)) {
      const { group: removedGroup } = await removeUserFromGroup(userId, group._id, session);
      removedGroups.push(removedGroup);
    }
  }
  
  // Get the updated user with new group memberships
  const userQuery = User.findById(userId);
  if (session) {
    userQuery.session(session);
  }
  const updatedUser = await userQuery.lean();
  
  return {
    user: updatedUser,
    addedGroups,
    removedGroups
  };
};

/**
 * Search for principals (users and groups) by pattern matching on name/email
 * Returns combined results sorted by relevance
 * @param {string} searchPattern - The pattern to search for
 * @param {number} [limit=10] - Maximum number of results to return
 * @param {string} [typeFilter] - Optional filter: 'user', 'group', or null for all
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<Array>} Array of principals with type field and relevance sorting
 */
const searchPrincipals = async function (searchPattern, limit = 10, typeFilter = null, session = null) {
  if (!searchPattern || searchPattern.trim().length === 0) {
    return [];
  }

  const trimmedPattern = searchPattern.trim();
  const promises = [];

  // Search users if not filtering for groups only
  if (!typeFilter || typeFilter === 'user') {
    const userFields = 'name email username avatar provider';
    promises.push(
      searchUsers(trimmedPattern, limit * 2, userFields)
        .then(users => users.map(user => ({ ...user, type: 'user' })))
    );
  } else {
    promises.push(Promise.resolve([]));
  }

  // Search groups if not filtering for users only
  if (!typeFilter || typeFilter === 'group') {
    promises.push(
      findGroupsByNamePattern(trimmedPattern, null, limit * 2, session)
        .then(groups => groups.map(group => ({ ...group, type: 'group' })))
    );
  } else {
    promises.push(Promise.resolve([]));
  }

  const [users, groups] = await Promise.all(promises);

  // Combine all results
  const combined = [...users, ...groups];

  // Score all results for relevance
  const exactRegex = new RegExp(`^${trimmedPattern}$`, 'i');
  const startsWithPattern = trimmedPattern.toLowerCase();

  const scoredResults = combined.map(item => {
    // Get searchable text based on type
    const searchableFields = item.type === 'user' 
      ? [item.name, item.email, item.username].filter(Boolean)
      : [item.name].filter(Boolean);
    
    let maxScore = 0;
    
    for (const field of searchableFields) {
      const fieldLower = field.toLowerCase();
      let score = 0;
      
      // Exact match gets highest score
      if (exactRegex.test(field)) {
        score = 100;
      }
      // Starts with query gets high score
      else if (fieldLower.startsWith(startsWithPattern)) {
        score = 80;
      }
      // Contains query gets medium score
      else if (fieldLower.includes(startsWithPattern)) {
        score = 50;
      }
      // Default score for regex match
      else {
        score = 10;
      }
      
      maxScore = Math.max(maxScore, score);
    }
    
    return { ...item, _searchScore: maxScore };
  });

  // Sort by relevance and return top results
  return scoredResults
    .sort((a, b) => {
      // First sort by score (descending)
      if (b._searchScore !== a._searchScore) {
        return b._searchScore - a._searchScore;
      }
      // If scores are equal, prioritize users over groups
      if (a.type !== b.type) {
        return a.type === 'user' ? -1 : 1;
      }
      // Finally sort alphabetically
      const aName = a.name || a.email || '';
      const bName = b.name || b.email || '';
      return aName.localeCompare(bName);
    })
    .slice(0, limit)
    .map(result => {
      // Remove the search score from final results
      const { _searchScore, ...resultWithoutScore } = result;
      return resultWithoutScore;
    });
};

module.exports = {
  // Group-related functions
  findGroupById,
  findGroupByExternalId,
  findGroupsByNamePattern,
  findGroupsByMemberId,
  createGroup,
  upsertGroupByExternalId,
  
  // User-group relationship functions
  addUserToGroup,
  removeUserFromGroup,
  getUserGroups,
  getUserPrincipals,
  syncUserEntraGroups,
  
  // Search functions
  searchPrincipals
};