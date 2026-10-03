import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { TokenCustodyService } from '~/auth/custody/service';
import type { ImageAuthorizationDeps } from './authorization';
import { generateTokenKey, hashTokenKey, parseTokenKey } from '~/auth/custody/key';
import { createImageAuthorizationMiddleware } from './authorization';

const VIEWER_ID = '65cfb246f7ecadb8b1e8036b';
const OWNER_ID = '65cfb246f7ecadb8b1e8036c';
const AGENT_DB_ID = '65cfb246f7ecadb8b1e8036d';
const AGENT_PATH = `/images/${OWNER_ID}/agent-agent_abc123-avatar-12345.png`;
const USER_AVATAR_PATH = `/images/${OWNER_ID}/avatar-12345.png`;

function createResponse(): Response {
  const response = {
    locals: {},
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  return response as unknown as Response;
}

/**
 * A fake custody service exposing only `custodyExists`, the existence-and-`userId` read behind
 * `verifyCustodyBinding`. Image authorization reaches nothing else on the service, so the remaining
 * methods throw if the migration ever routes a token open through this path.
 */
function createCustody(exists = true): TokenCustodyService {
  const unreachable = (name: string) => () => {
    throw new Error(`${name} must not be called by image authorization`);
  };
  return {
    custodyExists: jest.fn().mockResolvedValue(exists),
    createCustody: unreachable('createCustody'),
    openCustody: unreachable('openCustody'),
    rotateCustody: unreachable('rotateCustody'),
    reloadAfterInvalidGrant: unreachable('reloadAfterInvalidGrant'),
    deleteCustody: unreachable('deleteCustody'),
    deleteAllForUser: unreachable('deleteAllForUser'),
  } as unknown as TokenCustodyService;
}

function createDeps(): ImageAuthorizationDeps {
  return {
    parseCookies: (header: string) =>
      Object.fromEntries(
        header.split(';').map((part: string) => {
          const [key, ...value] = part.trim().split('=');
          return [key, value.join('=')];
        }),
      ),
    isOpenIdReuseEnabled: jest.fn().mockReturnValue(false),
    getBasePath: jest.fn().mockReturnValue(''),
    findSession: jest.fn().mockResolvedValue({ _id: 'active-session' }),
    custody: createCustody(true),
    getTenantId: jest.fn().mockReturnValue(undefined),
    getUserById: jest.fn().mockResolvedValue({
      role: 'USER',
      tenantId: 'tenant-a',
      idOnTheSource: null,
    }),
    getAgent: jest.fn().mockResolvedValue(null),
    getAssistant: jest.fn().mockResolvedValue(null),
    getUserPrincipals: jest
      .fn()
      .mockResolvedValue([{ principalType: 'user', principalId: VIEWER_ID }]),
    hasCapabilityForPrincipals: jest.fn().mockResolvedValue(false),
    hasPermission: jest.fn().mockResolvedValue(false),
  } as unknown as ImageAuthorizationDeps;
}

function createRequest(path: string, cookie?: string): Request {
  return {
    originalUrl: path,
    headers: cookie ? { cookie } : {},
  } as unknown as Request;
}

function signUser(userId: string): string {
  return jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET as string, { expiresIn: '1h' });
}

/**
 * Mints the token key cookie value and the `openid_user_id` marker JWT that bind an OpenID session
 * after the key-custody migration: the marker carries `{ id, tokenKeyHash }` signed with
 * `JWT_REFRESH_SECRET`, where `tokenKeyHash` is `hashTokenKey` of the presented key.
 */
function makeOpenIdCookies(
  userId: string,
  tokenKey: string = generateTokenKey(),
): { tokenKey: string; tokenKeyHash: string; marker: string } {
  const tokenKeyHash = hashTokenKey(parseTokenKey(tokenKey) as Buffer);
  const marker = jwt.sign({ id: userId, tokenKeyHash }, process.env.JWT_REFRESH_SECRET as string, {
    expiresIn: '1h',
  });
  return { tokenKey, tokenKeyHash, marker };
}

describe('createImageAuthorizationMiddleware', () => {
  let deps: ImageAuthorizationDeps;
  let response: Response;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    process.env.JWT_REFRESH_SECRET = 'image-authorization-secret';
    deps = createDeps();
    response = createResponse();
    next = jest.fn();
  });

  it('authenticates an active session and allows the owner path', async () => {
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(`/images/${VIEWER_ID}/profile.png`, `refreshToken=${token}`),
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(deps.findSession).toHaveBeenCalledWith({ userId: VIEWER_ID, refreshToken: token });
  });

  it('rejects a signed refresh token whose session was revoked', async () => {
    (deps.findSession as jest.Mock).mockResolvedValue(null);
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(`/images/${VIEWER_ID}/profile.png`, `refreshToken=${token}`),
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it('binds an OpenID session from the key/marker pair with one custody existence check', async () => {
    const { tokenKey, tokenKeyHash, marker } = makeOpenIdCookies(VIEWER_ID);
    (deps.isOpenIdReuseEnabled as jest.Mock).mockReturnValue(true);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(
        `/images/${VIEWER_ID}/profile.png`,
        `token_provider=openid; openid_token_key=${tokenKey}; openid_user_id=${marker}`,
      ),
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    // The revocation read is the custody existence check, not a session lookup.
    expect(deps.custody.custodyExists).toHaveBeenCalledTimes(1);
    expect(deps.custody.custodyExists).toHaveBeenCalledWith({
      tokenKeyHash,
      expectedUserId: VIEWER_ID,
      /** No ambient tenant: the record must carry no tenant either. */
      expectedTenantId: null,
    });
    expect(deps.findSession).not.toHaveBeenCalled();
  });

  it('binds an OpenID session without a refreshToken cookie', async () => {
    const { tokenKey, marker } = makeOpenIdCookies(VIEWER_ID);
    (deps.isOpenIdReuseEnabled as jest.Mock).mockReturnValue(true);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(
        `/images/${VIEWER_ID}/profile.png`,
        `token_provider=openid; openid_token_key=${tokenKey}; openid_user_id=${marker}`,
      ),
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a marker whose tokenKeyHash claim does not match the presented key', async () => {
    const { marker } = makeOpenIdCookies(VIEWER_ID);
    const otherKey = generateTokenKey();
    (deps.isOpenIdReuseEnabled as jest.Mock).mockReturnValue(true);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(
        `/images/${VIEWER_ID}/profile.png`,
        `token_provider=openid; openid_token_key=${otherKey}; openid_user_id=${marker}`,
      ),
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    // A claim mismatch fails closed before any store read.
    expect(deps.custody.custodyExists).not.toHaveBeenCalled();
  });

  it('rejects when the custody record no longer exists (revoked or logged out)', async () => {
    const { tokenKey, marker } = makeOpenIdCookies(VIEWER_ID);
    (deps.isOpenIdReuseEnabled as jest.Mock).mockReturnValue(true);
    (deps.custody.custodyExists as jest.Mock).mockResolvedValue(false);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(
        `/images/${VIEWER_ID}/profile.png`,
        `token_provider=openid; openid_token_key=${tokenKey}; openid_user_id=${marker}`,
      ),
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.custody.custodyExists).toHaveBeenCalledTimes(1);
  });

  it('rejects a previous-format marker carrying only refreshTokenHash', async () => {
    const { tokenKey } = makeOpenIdCookies(VIEWER_ID);
    const legacyMarker = jwt.sign(
      { id: VIEWER_ID, refreshTokenHash: 'some-hash' },
      process.env.JWT_REFRESH_SECRET as string,
      { expiresIn: '1h' },
    );
    (deps.isOpenIdReuseEnabled as jest.Mock).mockReturnValue(true);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(
        `/images/${VIEWER_ID}/profile.png`,
        `token_provider=openid; openid_token_key=${tokenKey}; openid_user_id=${legacyMarker}`,
      ),
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.custody.custodyExists).not.toHaveBeenCalled();
  });

  it('scopes the custody existence check to the ambient tenant', async () => {
    const { tokenKey, tokenKeyHash, marker } = makeOpenIdCookies(VIEWER_ID);
    (deps.isOpenIdReuseEnabled as jest.Mock).mockReturnValue(true);
    (deps.getTenantId as jest.Mock).mockReturnValue('tenant-a');
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(
        `/images/${VIEWER_ID}/profile.png`,
        `token_provider=openid; openid_token_key=${tokenKey}; openid_user_id=${marker}`,
      ),
      response,
      next,
    );

    expect(deps.custody.custodyExists).toHaveBeenCalledWith({
      tokenKeyHash,
      expectedUserId: VIEWER_ID,
      expectedTenantId: 'tenant-a',
    });
  });

  it('uses the disabled fallback for an image path without an owner layout', async () => {
    deps.getImageConfig = jest.fn();
    const middleware = createImageAuthorizationMiddleware({ secureImageLinks: false }, deps);

    await middleware(createRequest('/images/logo.png'), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(deps.getUserById).not.toHaveBeenCalled();
  });

  it('uses the disabled fallback when the path owner no longer exists', async () => {
    deps.getImageConfig = jest.fn();
    (deps.getUserById as jest.Mock).mockResolvedValue(null);
    const middleware = createImageAuthorizationMiddleware({ secureImageLinks: false }, deps);

    await middleware(createRequest(`/images/${OWNER_ID}/orphaned.png`), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(deps.getImageConfig).not.toHaveBeenCalled();
  });

  it('normalizes repeated separators before applying a disabled fallback', async () => {
    deps.getImageConfig = jest.fn().mockResolvedValue({ secureImageLinks: true });
    const middleware = createImageAuthorizationMiddleware({ secureImageLinks: false }, deps);

    await middleware(createRequest(`/images//${OWNER_ID}/private.png`), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(deps.getImageConfig).toHaveBeenCalledTimes(1);
  });

  it('resolves principals once and applies the tenant to an agent capability check', async () => {
    (deps.getAgent as jest.Mock).mockResolvedValue({ _id: AGENT_DB_ID });
    (deps.hasPermission as jest.Mock).mockResolvedValue(true);
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(createRequest(AGENT_PATH, `refreshToken=${token}`), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(deps.getAgent).toHaveBeenCalledWith(
      {
        id: 'agent_abc123',
        'avatar.filepath': {
          $in: [AGENT_PATH, `${AGENT_PATH}?manual=false`, `${AGENT_PATH}?manual=true`],
        },
      },
      { _id: 1 },
    );
    expect(deps.getUserPrincipals).toHaveBeenCalledTimes(1);
    expect(deps.hasCapabilityForPrincipals).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
    expect(deps.hasPermission).toHaveBeenCalledTimes(1);
  });

  it('allows an anonymous request only when the agent has PUBLIC VIEW', async () => {
    (deps.getAgent as jest.Mock).mockResolvedValue({ _id: AGENT_DB_ID });
    (deps.hasPermission as jest.Mock).mockResolvedValue(true);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(createRequest(AGENT_PATH), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(deps.getUserPrincipals).not.toHaveBeenCalled();
    expect(deps.hasPermission).toHaveBeenCalledWith(
      [{ principalType: 'public' }],
      'agent',
      AGENT_DB_ID,
      1,
    );
  });

  it('does not apply a viewer role or group grant across tenant boundaries', async () => {
    (deps.getAgent as jest.Mock).mockResolvedValue({ _id: AGENT_DB_ID });
    (deps.getUserById as jest.Mock)
      .mockResolvedValueOnce({ tenantId: 'tenant-a' })
      .mockResolvedValueOnce({ role: 'USER', tenantId: 'tenant-b', idOnTheSource: null });
    (deps.hasPermission as jest.Mock).mockResolvedValue(true);
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(createRequest(AGENT_PATH, `refreshToken=${token}`), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(deps.getUserPrincipals).not.toHaveBeenCalled();
    expect(deps.hasCapabilityForPrincipals).not.toHaveBeenCalled();
    expect(deps.hasPermission).toHaveBeenCalledWith(
      [{ principalType: 'public' }],
      'agent',
      AGENT_DB_ID,
      1,
    );
  });

  it('preserves shared assistant avatars by matching their stored filepath', async () => {
    (deps.getAssistant as jest.Mock).mockResolvedValue({
      _id: '65cfb246f7ecadb8b1e8036e',
      assistant_id: 'asst_shared',
      endpoint: 'assistants',
    });
    const assistantPath = `/images/${OWNER_ID}/assistant-avatar.png`;
    const middleware = createImageAuthorizationMiddleware(
      { assistantEndpoints: [{ endpoint: 'assistants', privateAssistants: false }] },
      deps,
    );
    const token = signUser(VIEWER_ID);

    await middleware(createRequest(assistantPath, `refreshToken=${token}`), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(deps.getAssistant).toHaveBeenCalledWith(
      {
        avatarFilepath: [
          assistantPath,
          `${assistantPath}?manual=false`,
          `${assistantPath}?manual=true`,
        ],
      },
      { _id: 1, assistant_id: 1, endpoint: 1 },
    );
  });

  it('requires authentication for an otherwise shared assistant avatar', async () => {
    (deps.getAssistant as jest.Mock).mockResolvedValue({
      _id: '65cfb246f7ecadb8b1e8036e',
      assistant_id: 'asst_shared',
      endpoint: 'assistants',
    });
    const assistantPath = `/images/${OWNER_ID}/assistant-avatar.png`;
    const middleware = createImageAuthorizationMiddleware(
      { assistantEndpoints: [{ endpoint: 'assistants', privateAssistants: false }] },
      deps,
    );

    await middleware(createRequest(assistantPath), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('does not use a shared endpoint policy for a private endpoint assistant', async () => {
    (deps.getAssistant as jest.Mock).mockResolvedValue({
      _id: '65cfb246f7ecadb8b1e8036e',
      assistant_id: 'asst_private',
      endpoint: 'azureAssistants',
    });
    const assistantPath = `/images/${OWNER_ID}/assistant-avatar.png`;
    const middleware = createImageAuthorizationMiddleware(
      {
        assistantEndpoints: [
          { endpoint: 'assistants', privateAssistants: false },
          { endpoint: 'azureAssistants', privateAssistants: true },
        ],
      },
      deps,
    );

    await middleware(createRequest(assistantPath), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('allows an authenticated same-tenant viewer to load the stored user avatar', async () => {
    (deps.getUserById as jest.Mock)
      .mockResolvedValueOnce({
        tenantId: 'tenant-a',
        avatar: `${USER_AVATAR_PATH}?manual=true`,
      })
      .mockResolvedValueOnce({ tenantId: 'tenant-a' });
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(createRequest(USER_AVATAR_PATH, `refreshToken=${token}`), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(deps.getUserById).toHaveBeenNthCalledWith(
      1,
      OWNER_ID,
      'role tenantId idOnTheSource avatar',
    );
    expect(deps.getUserById).toHaveBeenNthCalledWith(2, VIEWER_ID, 'tenantId');
  });

  it('denies the stored user avatar to a viewer from another tenant', async () => {
    (deps.getUserById as jest.Mock)
      .mockResolvedValueOnce({
        tenantId: 'tenant-a',
        avatar: `${USER_AVATAR_PATH}?manual=true`,
      })
      .mockResolvedValueOnce({ tenantId: 'tenant-b' });
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(createRequest(USER_AVATAR_PATH, `refreshToken=${token}`), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it('normalizes a stored root image URL when the app uses a base path', async () => {
    (deps.getBasePath as jest.Mock).mockReturnValue('/chat');
    (deps.getUserById as jest.Mock)
      .mockResolvedValueOnce({
        tenantId: 'tenant-a',
        avatar: `${USER_AVATAR_PATH}?manual=true`,
      })
      .mockResolvedValueOnce({ tenantId: 'tenant-a' });
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(`/chat${USER_AVATAR_PATH}`, `refreshToken=${token}`),
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses the owner principal endpoint config instead of the startup fallback', async () => {
    (deps.getAssistant as jest.Mock).mockResolvedValue({
      _id: '65cfb246f7ecadb8b1e8036e',
      assistant_id: 'asst_private',
      endpoint: 'assistants',
    });
    deps.getImageConfig = jest.fn().mockResolvedValue({
      secureImageLinks: true,
      assistantEndpoints: [{ endpoint: 'assistants', privateAssistants: true }],
    });
    const assistantPath = `/images/${OWNER_ID}/assistant-avatar.png`;
    const middleware = createImageAuthorizationMiddleware(
      { assistantEndpoints: [{ endpoint: 'assistants', privateAssistants: false }] },
      deps,
    );

    await middleware(createRequest(assistantPath), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(deps.getImageConfig).toHaveBeenCalledWith({
      userId: OWNER_ID,
      user: expect.objectContaining({ tenantId: 'tenant-a' }),
    });
  });

  it('starts protected image authentication while owner config is resolving', async () => {
    let resolveConfig: ((config: { secureImageLinks: boolean }) => void) | undefined;
    deps.getImageConfig = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);
    const pending = middleware(
      createRequest(`/images/${VIEWER_ID}/profile.png`, `refreshToken=${token}`),
      response,
      next,
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(deps.getImageConfig).toHaveBeenCalledTimes(1);
    expect(deps.findSession).toHaveBeenCalledWith({ userId: VIEWER_ID, refreshToken: token });
    resolveConfig?.({ secureImageLinks: true });
    await pending;
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('honors an owner-scoped setting that disables secure image links', async () => {
    deps.getImageConfig = jest.fn().mockResolvedValue({
      secureImageLinks: false,
      assistantEndpoints: [],
    });
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(createRequest(`/images/${OWNER_ID}/private.png`), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.locals.privateImageCache).toBeUndefined();
  });

  it('honors an owner-scoped setting that enables protection over a disabled fallback', async () => {
    deps.getImageConfig = jest.fn().mockResolvedValue({
      secureImageLinks: true,
      assistantEndpoints: [],
    });
    const middleware = createImageAuthorizationMiddleware({ secureImageLinks: false }, deps);

    await middleware(createRequest(`/images/${OWNER_ID}/private.png`), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.locals.privateImageCache).toBe(true);
  });

  it('decodes an encoded deployment base path consistently with the request URL', async () => {
    (deps.getBasePath as jest.Mock).mockReturnValue('/libre%20chat');
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(`/libre%20chat/images/${VIEWER_ID}/profile.png`, `refreshToken=${token}`),
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('marks protected image responses as private before serving them', async () => {
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(`/images/${VIEWER_ID}/profile.png`, `refreshToken=${token}`),
      response,
      next,
    );

    expect(response.locals.privateImageCache).toBe(true);
  });

  it('rejects encoded traversal before any resource lookup', async () => {
    const token = signUser(VIEWER_ID);
    const middleware = createImageAuthorizationMiddleware({}, deps);

    await middleware(
      createRequest(`/images/${VIEWER_ID}/..%2F..%2Fetc%2Fpasswd`, `refreshToken=${token}`),
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.getAssistant).not.toHaveBeenCalled();
  });
});
