const cookies = require('cookie');
const jwksRsa = require('jwks-rsa');
const { logger, getTenantId, runAsSystem } = require('@librechat/data-schemas');
const { CacheKeys, SystemRoles } = require('librechat-data-provider');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const {
  isEnabled,
  findOpenIDUser,
  getOpenIdEmail,
  getOpenIdIssuer,
  normalizeOpenIdIssuer,
  buildAuthUserDocCacheKey,
  getAuthUserDocCacheMode,
  getCachedAuthUserDoc,
  getValidOpenIdReuseUserId,
  invalidateCachedAuthUserDoc,
  setCachedAuthUserDoc,
  getHttpsProxyAgent,
  isAccessTokenJwt,
  math,
} = require('@librechat/api');
const { updateUser, findUser, isAgentTriggerPrincipalActive } = require('~/models');
const getLogStores = require('~/cache/getLogStores');

const parseOpenIdAudiences = () =>
  (process.env.OPENID_AUDIENCE ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const getOpenIdJwtAudience = () => {
  const audiences = [process.env.OPENID_CLIENT_ID, ...parseOpenIdAudiences()].filter(Boolean);
  const uniqueAudiences = [...new Set(audiences)];

  return uniqueAudiences.length > 1 ? uniqueAudiences : uniqueAudiences[0];
};

/** The configured audiences a reused bearer is weighed against when deciding whether it is an access token */
const getOpenIdAudienceConfig = () => {
  const clientId = process.env.OPENID_CLIENT_ID;
  return {
    clientId,
    resources: new Set(parseOpenIdAudiences().filter((audience) => audience !== clientId)),
  };
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const issuerMatchesTemplate = (expectedIssuer, actualIssuer) => {
  if (!expectedIssuer.includes('{tenantid}')) {
    return false;
  }

  const escapedTemplate = expectedIssuer.split('{tenantid}').map(escapeRegExp).join('[^/]+');
  return new RegExp(`^${escapedTemplate}$`).test(actualIssuer);
};

const isOpenIdIssuerAllowed = (payload, openIdConfig) => {
  const actualIssuer = normalizeOpenIdIssuer(payload?.iss);
  const expectedIssuer = normalizeOpenIdIssuer(openIdConfig.serverMetadata().issuer);

  if (!actualIssuer || !expectedIssuer) {
    return false;
  }

  return actualIssuer === expectedIssuer || issuerMatchesTemplate(expectedIssuer, actualIssuer);
};

const getAuthUserDocCacheStore = () => getLogStores(CacheKeys.AUTH_USER_DOC);

const getUserId = (user) => user?.id?.toString?.() ?? user?._id?.toString?.();

const getAuthUserCacheScope = (tenantId, userId) => {
  if (tenantId) {
    return { tenantId };
  }
  if (userId) {
    return { userId };
  }
  return {};
};

const isUserInAuthCacheScope = (user, { tenantId, userId }) => {
  if (tenantId) {
    return (user?.tenantId || undefined) === tenantId;
  }
  if (userId) {
    return getUserId(user) === userId;
  }
  return !user?.tenantId;
};

/**
 * @function openIdJwtLogin
 * @param {import('openid-client').Configuration} openIdConfig - Configuration object for the JWT strategy.
 * @returns {JwtStrategy}
 * @description This function creates a JWT strategy for OpenID authentication.
 * It uses the jwks-rsa library to retrieve the signing key from a JWKS endpoint.
 * The strategy extracts the JWT from the Authorization header as a Bearer token.
 * The JWT is then verified using the signing key, and the user is retrieved from the database.
 *
 * Includes email fallback mechanism:
 * 1. Primary lookup: Search user by openidId (sub claim)
 * 2. Fallback lookup: If not found, search by email claim
 * 3. User migration: If found by email without openidId, migrate the user by adding openidId
 * 4. Provider validation: Ensures users registered with other providers cannot use OpenID
 *
 * This enables seamless migration for existing users when SharePoint integration is enabled.
 */
const openIdJwtLogin = (openIdConfig) => {
  let jwksRsaOptions = {
    cache: process.env.OPENID_JWKS_URL_CACHE_ENABLED
      ? isEnabled(process.env.OPENID_JWKS_URL_CACHE_ENABLED)
      : true,
    cacheMaxAge: math(process.env.OPENID_JWKS_URL_CACHE_TIME, 60000),
    jwksUri: openIdConfig.serverMetadata().jwks_uri,
  };

  const requestAgent = getHttpsProxyAgent(jwksRsaOptions.jwksUri);
  if (requestAgent) {
    jwksRsaOptions.requestAgent = requestAgent;
  }

  const audienceConfig = getOpenIdAudienceConfig();

  return new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: jwksRsa.passportJwtSecret(jwksRsaOptions),
      audience: getOpenIdJwtAudience(),
      passReqToCallback: true,
    },
    /**
     * @param {import('@librechat/api').ServerRequest} req
     * @param {import('openid-client').IDToken} payload
     * @param {import('passport-jwt').VerifyCallback} done
     */
    async (req, payload, done) => {
      try {
        if (!isOpenIdIssuerAllowed(payload, openIdConfig)) {
          done(null, false, { message: 'Invalid issuer' });
          return;
        }

        const authHeader = req.headers.authorization;
        const rawToken = authHeader?.replace('Bearer ', '');
        const openidIssuer = getOpenIdIssuer(payload, openIdConfig);
        const tenantId = getTenantId();
        const cookieHeader = req.headers.cookie;
        const parsedCookies = cookieHeader ? cookies.parse(cookieHeader) : {};
        const openIdReuseUserId = getValidOpenIdReuseUserId(parsedCookies.openid_user_id);
        const authUserCacheScope = getAuthUserCacheScope(tenantId, openIdReuseUserId);
        const authUserCacheKey = buildAuthUserDocCacheKey({
          strategy: 'openid-jwt',
          subject: payload?.sub,
          issuer: openidIssuer,
          ...authUserCacheScope,
        });
        const authUserCacheMode = getAuthUserDocCacheMode();
        const authUserCacheStore =
          authUserCacheMode !== 'off' && authUserCacheKey ? getAuthUserDocCacheStore() : undefined;
        const cachedUser =
          authUserCacheMode !== 'off' && authUserCacheStore && authUserCacheKey
            ? await getCachedAuthUserDoc(authUserCacheStore, authUserCacheKey)
            : undefined;

        const servedCachedUser =
          authUserCacheMode === 'on' &&
          cachedUser &&
          isUserInAuthCacheScope(cachedUser, authUserCacheScope);
        const lookupResult = servedCachedUser
          ? { user: cachedUser, error: null, migration: false }
          : await findOpenIDUser({
              findUser,
              email: payload ? getOpenIdEmail(payload) : undefined,
              openidId: payload?.sub,
              openidIssuer,
              idOnTheSource: payload?.oid,
              strategyName: 'openIdJwtLogin',
            });
        const { user, error, migration } = lookupResult;

        if (error) {
          done(null, false, { message: error });
          return;
        }

        if (user) {
          user.id = user._id.toString();
          if (!(await runAsSystem(() => isAgentTriggerPrincipalActive(user.id)))) {
            done(null, false, {
              message: 'Account deletion is in progress',
              code: 'ACCOUNT_DELETION_IN_PROGRESS',
            });
            return;
          }
          /** Absent on the full doc means local user; null skips getUserPrincipals' fallback lookup */
          user.idOnTheSource ??= null;

          const updateData = {};
          if (migration) {
            updateData.provider = 'openid';
            updateData.openidId = payload?.sub;
            if (openidIssuer) {
              updateData.openidIssuer = openidIssuer;
            }
          }
          if (!user.role) {
            user.role = SystemRoles.USER;
            updateData.role = user.role;
          }

          if (Object.keys(updateData).length > 0) {
            await updateUser(user.id, updateData);
          }

          if (authUserCacheStore && authUserCacheKey) {
            if (Object.keys(updateData).length > 0) {
              await invalidateCachedAuthUserDoc(authUserCacheStore, {
                userId: user.id,
                cacheKey: authUserCacheKey,
              });
            } else if (!servedCachedUser && isUserInAuthCacheScope(user, authUserCacheScope)) {
              await setCachedAuthUserDoc(authUserCacheStore, authUserCacheKey, user);
            }
          }

          /**
           * Key custody retired the server-readable token copies this strategy used to read —
           * `req.session.openidTokens` and the `openid_access_token` / `openid_id_token` /
           * `refreshToken` cookies are no longer written for the OpenID-reuse path. Token-dependent
           * features now resolve the live set from the custody record through the token provider, so
           * this strategy only populates `federatedTokens` from the request's own verified bearer
           * when that bearer is identifiable as an access token.
           *
           * The raw bearer stands in for the access token only when it is identifiable as one. It
           * cleared this strategy's audience check, but an ID token clears the same check, and an ID
           * token used as the OBO assertion is rejected by the IdP (Entra answers `AADSTS240002`). An
           * unrecognised token is left unset so a consumer that needs it fails closed with an
           * actionable error. This is the remote-agent / verified-bearer path; a custody-login
           * browser session carries the id_token as its bearer, so `federatedTokens` is left empty
           * and the custody token provider supplies the tokens instead.
           */
          const reusableRawToken = isAccessTokenJwt(rawToken, payload, audienceConfig)
            ? rawToken
            : undefined;
          if (!reusableRawToken) {
            logger.debug(
              '[openIdJwtLogin] Request bearer is not identifiable as an access token; leaving federatedTokens access token unset (custody supplies tokens on the reuse path)',
            );
          }

          user.federatedTokens = {
            access_token: reusableRawToken,
            id_token: undefined,
            refresh_token: undefined,
            expires_at: reusableRawToken ? payload.exp : undefined,
          };

          done(null, user);
        } else {
          logger.warn(
            '[openIdJwtLogin] openId JwtStrategy => no user found with the sub claims: ' +
              payload?.sub +
              (payload?.email ? ' or email: ' + payload.email : ''),
          );
          done(null, false);
        }
      } catch (err) {
        done(err, false);
      }
    },
  );
};

module.exports = openIdJwtLogin;
