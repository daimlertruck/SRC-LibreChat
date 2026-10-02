const cookie = require('cookie');
const {
  createImageAuthorizationMiddleware,
  getAppConfigOptionsFromUser,
  getBasePath,
  isEnabled,
} = require('@librechat/api');
const { getTenantId } = require('@librechat/data-schemas');
const {
  findSession,
  getAgent,
  getAssistant,
  getUserById,
  getUserPrincipals,
  hasCapabilityForPrincipals,
  hasPermission,
} = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

const getAssistantEndpointConfigs = (appConfig) =>
  [
    appConfig?.endpoints?.assistants && {
      endpoint: 'assistants',
      ...appConfig.endpoints.assistants,
    },
    appConfig?.endpoints?.azureAssistants && {
      endpoint: 'azureAssistants',
      ...appConfig.endpoints.azureAssistants,
    },
  ].filter(Boolean);

/**
 * Thin Express adapter for the typed image-authorization service in `@librechat/api`.
 * @param {boolean | {secureImageLinks?: boolean, assistantEndpoints?: object[]}} [config]
 */
function createValidateImageRequest(config = {}) {
  const resolveDynamicConfig = typeof config !== 'boolean';
  const options =
    typeof config === 'boolean'
      ? { secureImageLinks: config }
      : {
          secureImageLinks: config.secureImageLinks,
          assistantEndpoints: config.assistantEndpoints,
        };

  const deps = {
    parseCookies: cookie.parse,
    isOpenIdReuseEnabled: () => isEnabled(process.env.OPENID_REUSE_TOKENS),
    getBasePath,
    findSession,
    // The OpenID-reuse binding check reaches the process-wide custody service lazily, so the
    // instance is constructed on first use rather than at module load and no require cycle forms
    // through AuthService at load time, matching the refresh controller and the OBO paths.
    get custody() {
      return require('~/server/services/AuthService').getTokenCustodyService();
    },
    getTenantId,
    getAgent,
    getAssistant,
    getUserById,
    getUserPrincipals,
    hasCapabilityForPrincipals,
    hasPermission,
  };
  if (resolveDynamicConfig) {
    deps.getImageConfig = async ({ userId, user }) => {
      const appConfig = await getAppConfig(
        getAppConfigOptionsFromUser({ ...user, id: userId }, user.tenantId),
      );
      return {
        secureImageLinks: appConfig.secureImageLinks,
        assistantEndpoints: getAssistantEndpointConfigs(appConfig),
      };
    };
  }

  return createImageAuthorizationMiddleware(options, deps);
}

module.exports = createValidateImageRequest;
