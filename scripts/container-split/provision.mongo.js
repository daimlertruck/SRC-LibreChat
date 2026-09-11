/* eslint-disable no-undef */
/**
 * Provision the two MongoDB credentials the auth/API container split requires.
 *
 * Run with mongosh against the LibreChat database, as a user that can manage
 * roles and users on it (`userAdmin` on this database, or `root`):
 *
 *   mongosh "$MONGO_ADMIN_URI" \
 *     --eval 'var AUTH_PASSWORD = "..."; var API_PASSWORD = "..."' \
 *     --file scripts/container-split/provision.mongo.js
 *
 * Dry run — prints the grant it would provision and writes nothing. Passwords
 * are not required in this mode:
 *
 *   mongosh "$MONGO_ADMIN_URI" --eval 'var DRY_RUN = true' \
 *     --file scripts/container-split/provision.mongo.js
 *
 * Role and user names can be overridden the same way, with
 * `AUTH_ROLE_NAME`, `AUTH_USER_NAME`, `API_ROLE_NAME`, and `API_USER_NAME`.
 *
 * The per-container environment values, the `librechat.yaml` rules, and the
 * manual ban copy that accompany these grants are in
 * `scripts/container-split/env-matrix.md`.
 *
 * Roles and users are created on the database mongosh is connected to, so each
 * container's connection string carries `authSource=<that database>`.
 *
 * What this provisions
 * --------------------
 * Two credentials, one per container, matching the design's collection
 * ownership matrix:
 *
 *   - The auth surface (container 1) — the internet-facing container serving
 *     login, registration, 2FA, password reset, email verification, the admin
 *     login and OAuth paths, `/api/config`, `/api/banner`, and the SPA. Its
 *     grant reaches exactly twelve collections: read-write on `users`,
 *     `sessions`, `authtokens`, `balances`, `bans`, `groups`,
 *     `refreshtokenbridges`, and `openidrefreshflights`; read-only on `roles`,
 *     `configs`, `systemgrants`, and `banners`. Nothing else — no
 *     database-wide privilege, no pattern-based privilege, and no inherited
 *     role that could widen it.
 *
 *   - The API container (container 2) — reachable only through the auth gate,
 *     and holding read-write access to every collection in the database.
 *
 * The grant is the enforcement boundary, not the route table. Both containers
 * run the same image and mount every route, so the auth surface's collection
 * reach cannot be derived from what it serves; it is exactly what this script
 * provisions. A route the auth surface mounts but whose collection this grant
 * omits fails at the database layer, which is the intended outcome.
 *
 * Recompute this grant when routing changes
 * -----------------------------------------
 * The auth surface's privilege set is derived from the collections that the
 * paths *routed to it* need. Whenever a path moves between the two routed path
 * sets — added to the load balancer's auth-surface allowlist, or removed from
 * it and sent to the gate instead — the auth surface's grant must be
 * RECOMPUTED from the moved path's collection needs, not merely re-asserted by
 * re-running this script unchanged.
 *
 * Re-running it unchanged re-asserts the twelve collections below and proves
 * nothing about the moved path. A newly routed path that reads, say, `files`
 * or `tokens` will fail at the database layer, and on the group-sync and
 * capability-check paths that failure is caught and logged rather than
 * surfaced, so it degrades quietly instead of loudly. Work out what the moved
 * path touches, edit the two collection lists below, and provision again
 * before the changed routing takes effect.
 *
 * Idempotent. An existing role is updated with the full recomputed privilege
 * and inherited-role set rather than added to, and an existing user's role
 * array is replaced rather than appended to, so a previously broader grant is
 * narrowed by re-running rather than left in place.
 */

const dbName = db.getName();

/**
 * Read-write for the auth surface. Every one of these is forced by a path
 * routed to it: all passport strategies, registration, 2FA and `jwtStrategy`
 * role backfill (`users`); session create/find/delete (`sessions`); password
 * reset, email verification, and invite consumption (`authtokens`); the
 * `createUser` start-balance upsert and `setBalanceConfig` on login
 * (`balances`); the `checkBan` cache and ban violation log (`bans`); and the
 * OAuth callback's Entra group membership sync, which adds and removes members
 * and creates group documents (`groups`).
 *
 * `groups` needs write only where Entra group sync is enabled —
 * `USE_ENTRA_ID_FOR_PEOPLE_SEARCH` and `OPENID_REUSE_TOKENS` both on an
 * `openid` provider. Deployments without it can move `groups` to the read-only
 * list below, where the admin login paths' capability checks still work.
 *
 * `refreshtokenbridges` and `openidrefreshflights` are read-write, not
 * read-only. Both are written *primarily* by the auth surface's own refresh
 * and logout paths (`/api/auth/refresh` and `/api/auth/logout`) — the
 * `RefreshTokenBridge` rotation bridge and the `OpenIDRefreshFlight`
 * cross-worker inline-refresh coordination — so the auth surface must be able
 * to write both. The API container also writes both on its OBO inline-refresh
 * path when a tool call's access token has expired, but that shared write does
 * not make them the API container's alone: the auth surface is the primary
 * writer, which is why both belong in this read-write list rather than the
 * read-only one below.
 */
const AUTH_READ_WRITE = [
  'users',
  'sessions',
  'authtokens',
  'balances',
  'bans',
  'groups',
  'refreshtokenbridges',
  'openidrefreshflights',
];

/**
 * Read-only for the auth surface: `findRolesByNames` for OIDC role sync
 * (`roles`), `getAppConfig` tenant and role overrides (`configs`), the
 * `requireAdminAccess` capability lookup (`systemgrants`), and the login page
 * (`banners`). Writes to these belong to the API container's bootstrap and
 * admin paths, so a write attempted here is refused and the documents are left
 * unchanged.
 */
const AUTH_READ_ONLY = ['roles', 'configs', 'systemgrants', 'banners'];

/**
 * Collections this feature introduces, which may not exist yet when the auth
 * surface first writes to one. It runs `MONGO_AUTO_CREATE=false`, so nothing
 * pre-creates them; the collection materializes from the first insert or
 * upsert, and implicit creation needs `createCollection` on that collection.
 *
 * `createIndex` is deliberately absent. The auth surface runs
 * `MONGO_AUTO_INDEX=false`, and the `authtokens` TTL index on `expiresAt` is
 * built by the API container when the model registers, or provisioned out of
 * band alongside the rest of the index set in deployments that disable
 * autoIndex everywhere.
 */
const IMPLICITLY_CREATED = ['authtokens', 'bans'];

/** Collection-scoped read actions. Nothing here applies at database scope. */
const READ_ACTIONS = ['find', 'listIndexes', 'collStats', 'planCacheRead', 'changeStream'];

const WRITE_ACTIONS = ['insert', 'update', 'remove'];

const CREATE_ACTIONS = ['createCollection'];

const privilegeFor = function (collection, actions) {
  return {
    resource: { db: dbName, collection: collection },
    actions: actions,
  };
};

const readWritePrivilege = function (collection) {
  const actions = READ_ACTIONS.concat(WRITE_ACTIONS);
  if (IMPLICITLY_CREATED.indexOf(collection) === -1) {
    return privilegeFor(collection, actions);
  }
  return privilegeFor(collection, actions.concat(CREATE_ACTIONS));
};

const readOnlyPrivilege = function (collection) {
  return privilegeFor(collection, READ_ACTIONS);
};

const authPrivileges = AUTH_READ_WRITE.map(readWritePrivilege).concat(
  AUTH_READ_ONLY.map(readOnlyPrivilege),
);

/**
 * Guards on the computed privilege set, checked before anything is written.
 *
 * The empty collection name is what makes a privilege database-wide in
 * MongoDB, so an empty `collection` on any resource here would silently reach
 * every collection in the database and defeat the whole point of the grant.
 * A collection listed in both modes would do the same, since privileges union
 * rather than override.
 */
const assertGrantIsScoped = function (privileges) {
  const unscoped = privileges.filter(function (privilege) {
    return !privilege.resource.collection || privilege.resource.db !== dbName;
  });
  if (unscoped.length !== 0) {
    throw new Error(
      'Refusing to provision: ' +
        unscoped.length +
        ' privilege(s) are not scoped to a named collection on ' +
        dbName,
    );
  }

  const overlap = AUTH_READ_WRITE.filter(function (collection) {
    return AUTH_READ_ONLY.indexOf(collection) !== -1;
  });
  if (overlap.length !== 0) {
    throw new Error(
      'Refusing to provision: ' + overlap.join(', ') + ' listed as both read-write and read-only',
    );
  }

  if (privileges.length !== AUTH_READ_WRITE.length + AUTH_READ_ONLY.length) {
    throw new Error('Refusing to provision: privilege count does not match the collection lists');
  }
};

const authRoleName =
  typeof AUTH_ROLE_NAME !== 'undefined' ? AUTH_ROLE_NAME : 'librechatAuthSurface';
const authUserName =
  typeof AUTH_USER_NAME !== 'undefined' ? AUTH_USER_NAME : 'librechat_auth_surface';
const apiRoleName = typeof API_ROLE_NAME !== 'undefined' ? API_ROLE_NAME : 'librechatApiContainer';
const apiUserName =
  typeof API_USER_NAME !== 'undefined' ? API_USER_NAME : 'librechat_api_container';
const authPassword = typeof AUTH_PASSWORD !== 'undefined' ? AUTH_PASSWORD : null;
const apiPassword = typeof API_PASSWORD !== 'undefined' ? API_PASSWORD : null;

const dryRun = typeof DRY_RUN !== 'undefined' && DRY_RUN === true;

print('');
print('LibreChat container grant provisioning');
print('  database: ' + dbName);
print('  mode:     ' + (dryRun ? 'DRY RUN (no writes)' : 'apply'));
print('');

assertGrantIsScoped(authPrivileges);

print('Auth surface (container 1) — role ' + authRoleName + ', user ' + authUserName);
print('  read-write: ' + AUTH_READ_WRITE.join(', '));
print('  read-only:  ' + AUTH_READ_ONLY.join(', '));
print('  reaches nothing else: no database-wide or pattern-based privilege, no inherited role');
print('  implicit creation permitted on: ' + IMPLICITLY_CREATED.join(', '));
print('');
print('API container (container 2) — role ' + apiRoleName + ', user ' + apiUserName);
print('  read-write: every collection on ' + dbName + ' (inherits built-in readWrite)');
print('');

if (dryRun) {
  print('Computed auth surface privileges:');
  authPrivileges.forEach(function (privilege) {
    print('  ' + privilege.resource.collection + ': ' + privilege.actions.join(', '));
  });
  print('');
  print('Dry run complete. No roles or users were created or modified.');
} else {
  if (!authPassword || !apiPassword) {
    throw new Error(
      'AUTH_PASSWORD and API_PASSWORD are both required. Pass them with ' +
        '--eval \'var AUTH_PASSWORD = "..."; var API_PASSWORD = "..."\', or use DRY_RUN.',
    );
  }
  if (authPassword === apiPassword) {
    throw new Error(
      'Refusing to provision: the two containers must not share a password, since each ' +
        'credential is meant to be used by exactly one container',
    );
  }

  /**
   * `updateRole` replaces the fields it is given rather than merging them, so
   * passing both `privileges` and `roles` recomputes the grant from the lists
   * above and drops anything a previous run left behind.
   */
  const applyRole = function (name, privileges, inherited) {
    const definition = { privileges: privileges, roles: inherited };
    if (db.getRole(name) !== null) {
      db.updateRole(name, definition);
      print('  role ' + name + ': recomputed');
      return;
    }
    db.createRole({
      role: name,
      privileges: privileges,
      roles: inherited,
    });
    print('  role ' + name + ': created');
  };

  /** `updateUser` replaces the role array, narrowing a previously broader user. */
  const applyUser = function (name, password, roleName) {
    const grant = [{ role: roleName, db: dbName }];
    if (db.getUser(name) !== null) {
      db.updateUser(name, { pwd: password, roles: grant });
      print('  user ' + name + ': password and roles replaced');
      return;
    }
    db.createUser({ user: name, pwd: password, roles: grant });
    print('  user ' + name + ': created');
  };

  print('Provisioning...');
  applyRole(authRoleName, authPrivileges, []);
  applyRole(apiRoleName, [], [{ role: 'readWrite', db: dbName }]);
  applyUser(authUserName, authPassword, authRoleName);
  applyUser(apiUserName, apiPassword, apiRoleName);

  print('');
  print('Done.');
  print('');
  print('Give each container its own credential, and only its own:');
  print(
    '  container 1: mongodb://' + authUserName + ':<pw>@<host>/' + dbName + '?authSource=' + dbName,
  );
  print(
    '  container 2: mongodb://' + apiUserName + ':<pw>@<host>/' + dbName + '?authSource=' + dbName,
  );
  print('');
  print('Verify with:');
  print("  db.getRole('" + authRoleName + "', { showPrivileges: true })");
  print("  db.getUser('" + authUserName + "')");
  print('');
  print('Then boot each container against its own credential and confirm zero authorization');
  print('errors across its startup logs before any request-level verification.');
}

print('');
