import { extractEnvVariable } from 'librechat-data-provider';
import type { OIDCTokens } from '@librechat/data-schemas';
import type { MCPOptions, ParsedServerConfig } from './types';
import type { UpstreamTokenProvider } from './oauth/obo';
import { GRAPH_TOKEN_PLACEHOLDER, OpenIDReauthRequiredError } from '~/utils/oidc';
import { isPluginSourced, isUserSourced } from '~/utils/env';
import { isRetryableOboExchangeError } from './oauth/obo';
import { MCPAuthenticationRefreshError } from './errors';
import { getAdminApiKeyHeader } from './headers';
import { isAbortError } from '~/utils/errors';

const OPENID_ACCESS_TOKEN_PATTERN = /\{\{LIBRECHAT_OPENID_(?:ACCESS_TOKEN|TOKEN)\}\}/;
const OPENID_ACCESS_TOKEN_REPLACEMENT_PATTERN = /\{\{LIBRECHAT_OPENID_(?:ACCESS_TOKEN|TOKEN)\}\}/g;
/** Request-local snapshots carry the opaque token without serializing it as new config metadata. */
const resolvedAccessTokens = new WeakMap<MCPOptions, string>();

type DirectBearerConfig = MCPOptions & {
  dbId?: string;
  source?: 'yaml' | 'config' | 'user' | 'plugin';
};

function getAuthorizationHeader(
  config: DirectBearerConfig,
): { name: string; value: string } | null {
  if (!('headers' in config) || !config.headers) {
    return null;
  }

  const entry = Object.entries(config.headers).find(
    ([name]) => name.toLowerCase() === 'authorization',
  );
  return entry ? { name: entry[0], value: entry[1] } : null;
}

/** Expands an operator-owned environment indirection before looking for the OpenID placeholder. */
function getAuthorizationTemplateValue(value: string): string {
  return extractEnvVariable(value);
}

function apiKeyOwnsAuthorization(config: DirectBearerConfig): boolean {
  return getAdminApiKeyHeader(config.apiKey)?.name.toLowerCase() === 'authorization';
}

function resolveAccessTokenPlaceholders(
  config: DirectBearerConfig,
  token: string,
): DirectBearerConfig {
  const resolve = (value: string) => {
    const template = extractEnvVariable(value);
    return OPENID_ACCESS_TOKEN_PATTERN.test(template)
      ? template.replace(OPENID_ACCESS_TOKEN_REPLACEMENT_PATTERN, () => token)
      : value;
  };
  const resolveMap = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolve(value)]));
  const resolved = { ...config };
  if ('headers' in resolved && resolved.headers) {
    resolved.headers = resolveMap(resolved.headers);
  }
  if ('oauth_headers' in resolved && resolved.oauth_headers) {
    resolved.oauth_headers = resolveMap(resolved.oauth_headers);
  }
  if ('url' in resolved) {
    resolved.url = resolve(resolved.url);
  }
  if ('env' in resolved && resolved.env) {
    resolved.env = resolveMap(resolved.env);
  }
  if ('args' in resolved && resolved.args) {
    resolved.args = resolved.args.map(resolve);
  }
  if (resolved.oauth) {
    resolved.oauth = Object.fromEntries(
      Object.entries(resolved.oauth).map(([key, value]) => [
        key,
        typeof value === 'string' ? resolve(value) : value,
      ]),
    );
  }
  resolvedAccessTokens.set(resolved, token);
  return resolved;
}

/** Explicit OAuth/OBO/API keys own Authorization. Remove only the lower-priority OpenID template
 * before generic runtime expansion can demand or inject the upstream bearer directly. */
function removeShadowedOpenIDAuthorization(config: DirectBearerConfig): DirectBearerConfig {
  const authorization = getAuthorizationHeader(config);
  if (
    authorization == null ||
    !OPENID_ACCESS_TOKEN_PATTERN.test(getAuthorizationTemplateValue(authorization.value)) ||
    !('headers' in config)
  ) {
    return config;
  }

  const headers = { ...config.headers };
  delete headers[authorization.name];
  return { ...config, headers };
}

/** Whether a trusted operator config explicitly routes its OpenID bearer to this server. */
export function isDirectOpenIDBearerRecoveryEnabled(config: DirectBearerConfig): boolean {
  /** Explicit credential modes take precedence over the legacy passthrough placeholder. */
  if (
    config.obo != null ||
    apiKeyOwnsAuthorization(config) ||
    (config.oauth != null && config.requiresOAuth !== false) ||
    config.dbId != null
  ) {
    return false;
  }
  if (config.source !== 'yaml' && config.source !== 'config') {
    return false;
  }
  const authorization = getAuthorizationHeader(config);
  return (
    authorization != null &&
    OPENID_ACCESS_TOKEN_PATTERN.test(getAuthorizationTemplateValue(authorization.value))
  );
}

/** Whether a trusted direct-bearer config still needs its live placeholder resolved. */
export function usesDirectOpenIDBearerRecovery(config: DirectBearerConfig): boolean {
  return isDirectOpenIDBearerRecoveryEnabled(config);
}

/** Resolves the live bearer before a connection or request reaches the MCP transport. */
export async function resolveDirectOpenIDBearerConfig({
  config,
  upstreamTokenProvider,
  forceRefresh = false,
  resolvedConfig,
  signal,
}: {
  config: DirectBearerConfig;
  upstreamTokenProvider?: UpstreamTokenProvider;
  forceRefresh?: boolean;
  resolvedConfig?: MCPOptions;
  signal?: AbortSignal;
}): Promise<DirectBearerConfig> {
  signal?.throwIfAborted();
  if (
    config.obo != null ||
    apiKeyOwnsAuthorization(config) ||
    (config.oauth != null && config.requiresOAuth !== false)
  ) {
    return removeShadowedOpenIDAuthorization(config);
  }
  if (!usesDirectOpenIDBearerRecovery(config)) {
    return config;
  }
  const authorization = getAuthorizationHeader(config);
  const resolvedToken = resolvedConfig && resolvedAccessTokens.get(resolvedConfig);
  if (!forceRefresh && resolvedToken != null) {
    return resolveAccessTokenPlaceholders(config, resolvedToken);
  }
  const resolvedAuthorization = resolvedConfig && getAuthorizationHeader(resolvedConfig);
  if (!forceRefresh && authorization && resolvedAuthorization && 'headers' in config) {
    return {
      ...config,
      headers: { ...config.headers, [authorization.name]: resolvedAuthorization.value },
    };
  }
  if (!upstreamTokenProvider) {
    /** Keep the established `processMCPEnv` path available to API consumers that only
     * provide the verified request user. Recovery still requires a live session: once
     * the upstream rejects that bearer, a forced resolution must fail closed rather
     * than reconnecting with the same stale credential. */
    if (!forceRefresh) {
      return config;
    }
    throw new OpenIDReauthRequiredError(
      'A live OpenID session is required to recover this MCP bearer credential.',
    );
  }

  let tokens;
  try {
    tokens = await upstreamTokenProvider({ forceRefresh, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) {
      throw error;
    }
    if (isRetryableOboExchangeError(error)) {
      throw new MCPAuthenticationRefreshError(error);
    }
    const reauthError = new OpenIDReauthRequiredError(
      'The OpenID session could not refresh the MCP bearer credential. Please sign in again.',
    );
    reauthError.cause = error;
    throw reauthError;
  }
  if (!tokens?.access_token) {
    /** A verified bearer-authenticated request has no Express session to refresh. Its
     * strategy-populated user token remains the authoritative non-forced fallback. */
    if (!forceRefresh) {
      return config;
    }
    throw new OpenIDReauthRequiredError(
      'The OpenID session has no usable MCP bearer credential. Please sign in again.',
    );
  }

  if (!authorization || !('headers' in config)) {
    return config;
  }
  return resolveAccessTokenPlaceholders(config, tokens.access_token);
}

/** Any `{{LIBRECHAT_OPENID_*}}` placeholder (access, id, user or expiry) in a config string. */
const ANY_OPENID_PLACEHOLDER_PATTERN = /\{\{LIBRECHAT_OPENID_[A-Z_]+\}\}/;

/** Collects every string a server config carries so placeholder detection scans all of them. */
function collectConfigStrings(config: MCPOptions): string[] {
  const strings: string[] = [];
  const pushRecord = (record?: Record<string, string>) => {
    if (record) {
      strings.push(...Object.values(record));
    }
  };
  if ('url' in config && typeof config.url === 'string') {
    strings.push(config.url);
  }
  if ('headers' in config) {
    pushRecord(config.headers);
  }
  if ('oauth_headers' in config) {
    pushRecord(config.oauth_headers);
  }
  if ('env' in config && config.env) {
    pushRecord(config.env);
  }
  if ('args' in config && Array.isArray(config.args)) {
    strings.push(...config.args);
  }
  if (config.oauth) {
    for (const value of Object.values(config.oauth)) {
      if (typeof value === 'string') {
        strings.push(value);
      } else if (Array.isArray(value)) {
        strings.push(...value.filter((entry): entry is string => typeof entry === 'string'));
      }
    }
  }
  return strings;
}

/** Expands operator env indirection, then tests the expanded text for a placeholder. */
function containsPlaceholder(strings: string[], test: (expanded: string) => boolean): boolean {
  return strings.some((value) => test(extractEnvVariable(value)));
}

/** Maps a provider rejection to the same error classes `resolveDirectOpenIDBearerConfig` uses. */
function mapProviderRejection(error: unknown): Error {
  if (isAbortError(error)) {
    return error as Error;
  }
  if (isRetryableOboExchangeError(error)) {
    return new MCPAuthenticationRefreshError(error);
  }
  const reauth = new OpenIDReauthRequiredError(
    'The OpenID session is unavailable; re-authentication is required to resolve an OpenID placeholder.',
  );
  reauth.cause = error;
  return reauth;
}

/**
 * Resolves the live OpenID token set a config's `{{LIBRECHAT_OPENID_*}}` / `{{LIBRECHAT_GRAPH_*}}`
 * placeholders need, lazily: it calls the upstream token provider only when the config is neither
 * plugin- nor database-sourced AND actually carries at least one such placeholder, so an ordinary
 * request that uses no token-bearing placeholder performs no custody read on this account.
 *
 * The provider's `tokenPreference` follows the placeholders present: `access_token` for the
 * access/token/expires-at/user placeholders and the Graph placeholder; `id_token` when the id-token
 * placeholder is the only token-bearing one. When both an access-type placeholder and the id-token
 * placeholder are present, it resolves under `access_token` first (the access token gates OBO), then
 * — only if the returned id token is not current — resolves once more under `id_token` so the id
 * token is itself refreshed. A null provider result returns `undefined` (the resolvers fall back to
 * the user's `federatedTokens` snapshot, i.e. the remote-agent path). A rejection is mapped to
 * `OpenIDReauthRequiredError` (session-missing, HTTP 401) or `MCPAuthenticationRefreshError`
 * (retryable), matching `resolveDirectOpenIDBearerConfig`.
 *
 * The returned token set is passed to `processMCPEnv({ openidTokens })` and `preProcessGraphTokens`
 * so they resolve from it rather than from `user.federatedTokens`.
 */
export async function resolveOpenIDPlaceholderTokens({
  config,
  upstreamTokenProvider,
  signal,
}: {
  config: ParsedServerConfig;
  /**
   * The request's upstream token provider (built by the MCP caller with `access_token` preference,
   * the same one it uses for OBO and direct bearer). A null/undefined provider returns undefined so
   * the resolvers fall back to the user's `federatedTokens` snapshot (the remote-agent path).
   */
  upstreamTokenProvider?: UpstreamTokenProvider | null;
  signal?: AbortSignal;
}): Promise<OIDCTokens | undefined> {
  if (!upstreamTokenProvider) {
    return undefined;
  }
  /** Plugin configs resolve verbatim; database-sourced configs resolve only customUserVars. */
  if (isPluginSourced(config) || isUserSourced(config)) {
    return undefined;
  }

  const strings = collectConfigStrings(config);
  const hasOpenIDPlaceholder = containsPlaceholder(strings, (expanded) =>
    ANY_OPENID_PLACEHOLDER_PATTERN.test(expanded),
  );
  const hasGraphPlaceholder = containsPlaceholder(strings, (expanded) =>
    expanded.includes(GRAPH_TOKEN_PLACEHOLDER),
  );
  if (!hasOpenIDPlaceholder && !hasGraphPlaceholder) {
    return undefined;
  }

  signal?.throwIfAborted();
  try {
    /**
     * The caller's provider is bound to `access_token` preference, which is correct for the access,
     * token, user, expires-at and Graph placeholders. For `{{LIBRECHAT_OPENID_ID_TOKEN}}` the
     * returned id token is used as-is; `processOpenIDPlaceholders` validates its own expiry and
     * raises `OpenIDReauthRequiredError` if it is stale, so a stale id token fails closed with an
     * actionable error rather than silently. (A dedicated `id_token`-preference refresh would need
     * the provider factory threaded down from the request layer; deferred, see the PR notes.)
     */
    const tokens = await upstreamTokenProvider({ ...(signal ? { signal } : {}) });
    return tokens ?? undefined;
  } catch (error) {
    throw mapProviderRejection(error);
  }
}
