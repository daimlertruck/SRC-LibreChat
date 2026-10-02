/**
 * Key custody: the token key helpers, the AEAD primitives, the custody service, the request-scoped
 * loader and the shared cookie-pair binding check. This barrel is the single entry point the `/api`
 * CJS call sites (`AuthService.js`, `AuthController.js`) reach through `@librechat/api`; the sealing,
 * identity and rotation logic all lives behind it.
 */
export * from './key';
export * from './cookie';
export * from './aead';
export * from './service';
export * from './loader';
export * from './binding';
