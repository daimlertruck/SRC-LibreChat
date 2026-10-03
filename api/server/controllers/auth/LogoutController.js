const {
  isEnabled,
  math,
  clearCloudFrontCookies,
  loadOpenIDCustody,
  clearTokenKeyCookie,
} = require('@librechat/api');
const { logger, DEFAULT_REFRESH_TOKEN_EXPIRY } = require('@librechat/data-schemas');
const { logoutUser, getTokenCustodyService } = require('~/server/services/AuthService');
const { revokeOpenIDRefreshTokenChain } = require('~/server/services/OpenIDRefreshRecovery');
const { getOpenIdConfig } = require('~/strategies');

/** Parses and validates OPENID_MAX_LOGOUT_URL_LENGTH, returning defaultValue on invalid input */
function parseMaxLogoutUrlLength(defaultValue = 2000) {
  const raw = process.env.OPENID_MAX_LOGOUT_URL_LENGTH;
  const trimmed = raw == null ? '' : raw.trim();
  if (trimmed === '') {
    return defaultValue;
  }
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[logoutController] Invalid OPENID_MAX_LOGOUT_URL_LENGTH value "${raw}", using default ${defaultValue}`,
    );
    return defaultValue;
  }
  return parsed;
}

const logoutController = async (req, res) => {
  const isOpenIdUser = req.user?.openidId != null && req.user?.provider === 'openid';

  /**
   * The IdP refresh token and the id_token hint live only in the sealed custody record the
   * request's token key cookie points at. A logout that cannot open a record (no key cookie, a
   * wrong key, an expired record) carries no OpenID tokens and still clears the browser's cookies.
   */
  const custody = isOpenIdUser
    ? await loadOpenIDCustody(req, {
        custody: getTokenCustodyService(),
        /** Authenticated: the logged-in user's tenant is the one we know. */
        expectedTenantId: req.user?.tenantId ?? null,
      })
    : null;

  let refreshToken;
  let idToken;
  if (custody) {
    refreshToken = custody.tokens?.refreshToken;
    idToken = custody.tokens?.idToken;
  }
  /** The single IdP refresh token opened from the record, if any, for the revocation chain. */
  const logoutTokens = [refreshToken].filter(Boolean);

  try {
    if (isOpenIdUser) {
      const userId = req.user?.id ?? req.user?._id?.toString?.();
      const refreshIdentity = {
        appUserId: userId,
        openidSubject: custody?.identity?.openidSubject ?? req.user?.openidId,
        tenantId: custody?.identity?.tenantId ?? req.user?.tenantId,
        openidIssuer: custody?.identity?.openidIssuer ?? req.user?.openidIssuer,
      };
      /**
       * Open, then revoke, then delete. The chain runs with the token opened from the record; a
       * failed, timed-out or unreachable IdP is caught below so the delete-and-clear still runs and
       * logout is never blocked by the IdP. Deleting first would discard the only remaining copy of
       * the token to revoke, leaving a live credential at the IdP that nothing could withdraw.
       */
      if (refreshToken) {
        try {
          const revokedRefreshTokens = await revokeOpenIDRefreshTokenChain({
            req,
            user: req.user,
            identityContext: refreshIdentity,
            refreshTokens: [...logoutTokens],
            ttl: math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
          });
          logoutTokens.push(...revokedRefreshTokens);
        } catch (revokeErr) {
          logger.warn('[logoutController] IdP revocation failed at logout', revokeErr?.message);
        }
      }
      /**
       * Deletes every custody record for this user in this tenant, including other browser
       * sessions. A rejection here fails closed: no `logoutUser`, no cookies cleared, 500.
       */
      await getTokenCustodyService().deleteAllForUser({
        userId,
        tenantId: req.user?.tenantId,
      });
      /**
       * `req.session.openidTokens` is retired by key custody and no longer written, so there is
       * nothing to delete here. `openidLogoutIdToken` is unrelated (the end-session id_token hint
       * for `OPENID_USE_END_SESSION_ENDPOINT`) and is still cleared.
       */
      if (req.session) {
        delete req.session.openidLogoutIdToken;
      }
    }
    if (logoutTokens.length === 0) {
      logoutTokens.push(undefined);
    }
    let logout = { status: 200, message: 'Logout successful' };
    for (const token of new Set(logoutTokens)) {
      const result = await logoutUser(req, token);
      if (result.status !== 200) {
        logout = result;
      }
    }
    const { status, message } = logout;

    res.clearCookie('refreshToken');
    res.clearCookie('openid_access_token');
    res.clearCookie('openid_id_token');
    res.clearCookie('openid_user_id');
    res.clearCookie('token_provider');
    /** Also clear the token key cookie, so the browser drops the deleted record's key. */
    clearTokenKeyCookie(res);
    clearCloudFrontCookies(res, {
      userId: req.user?.id ?? req.user?._id?.toString?.(),
      tenantId: req.user?.tenantId,
    });
    const response = { message };
    if (
      isOpenIdUser &&
      isEnabled(process.env.OPENID_USE_END_SESSION_ENDPOINT) &&
      process.env.OPENID_ISSUER
    ) {
      let openIdConfig;
      try {
        openIdConfig = getOpenIdConfig();
      } catch (err) {
        logger.warn('[logoutController] OpenID config not available:', err.message);
      }
      if (openIdConfig) {
        const endSessionEndpoint = openIdConfig.serverMetadata().end_session_endpoint;
        if (endSessionEndpoint) {
          const endSessionUrl = new URL(endSessionEndpoint);
          const postLogoutRedirectUri =
            process.env.OPENID_POST_LOGOUT_REDIRECT_URI || `${process.env.DOMAIN_CLIENT}/login`;
          endSessionUrl.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);

          /**
           * OIDC RP-Initiated Logout cascading strategy:
           * 1. id_token_hint (most secure, identifies exact session)
           * 2. logout_hint + client_id (when URL would exceed safe length)
           * 3. client_id only (when no token available)
           *
           * JWT tokens from spec-compliant OIDC providers use base64url
           * encoding (RFC 7515), whose characters are all URL-safe, so
           * token length equals URL-encoded length for projection.
           * Non-compliant issuers using standard base64 (+/=) will cause
           * underestimation; increase OPENID_MAX_LOGOUT_URL_LENGTH if the
           * fallback does not trigger as expected.
           */
          const maxLogoutUrlLength = parseMaxLogoutUrlLength();
          let strategy = 'no_token';
          if (idToken) {
            const baseLength = endSessionUrl.toString().length;
            const projectedLength = baseLength + '&id_token_hint='.length + idToken.length;
            if (projectedLength > maxLogoutUrlLength) {
              strategy = 'too_long';
              logger.debug(
                `[logoutController] Logout URL too long (${projectedLength} chars, max ${maxLogoutUrlLength}), ` +
                  'switching to logout_hint strategy',
              );
            } else {
              strategy = 'use_token';
            }
          }

          if (strategy === 'use_token') {
            endSessionUrl.searchParams.set('id_token_hint', idToken);
          } else {
            if (strategy === 'too_long') {
              const logoutHint = req.user?.email || req.user?.username || req.user?.openidId;
              if (logoutHint) {
                endSessionUrl.searchParams.set('logout_hint', logoutHint);
              }
            }

            if (process.env.OPENID_CLIENT_ID) {
              endSessionUrl.searchParams.set('client_id', process.env.OPENID_CLIENT_ID);
            } else if (strategy === 'too_long') {
              logger.warn(
                '[logoutController] Logout URL exceeds max length and OPENID_CLIENT_ID is not set. ' +
                  'The OIDC end-session request may be rejected. ' +
                  'Consider setting OPENID_CLIENT_ID or increasing OPENID_MAX_LOGOUT_URL_LENGTH.',
              );
            } else {
              logger.warn(
                '[logoutController] Neither id_token_hint nor OPENID_CLIENT_ID is available. ' +
                  'Sign in again to establish an OpenID session with an ID token. ' +
                  'The OIDC end-session request may be rejected by the identity provider.',
              );
            }
          }

          response.redirect = endSessionUrl.toString();
        } else {
          logger.warn(
            '[logoutController] end_session_endpoint not found in OpenID issuer metadata. Please verify that the issuer is correct.',
          );
        }
      }
    }
    return res.status(status).send(response);
  } catch (err) {
    logger.error('[logoutController]', err);
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  logoutController,
};
