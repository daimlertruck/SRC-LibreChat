const api = require('@librechat/api');
const {
  getOpenIDAppAuthToken,
  setOpenIDAuthTokens,
  getTokenCustodyService,
} = require('./AuthService');
const flight = require('./OpenIDRefreshFlight');

module.exports = api.createOpenIDRefreshRecoveryService({
  setOpenIDAuthTokens,
  getOpenIDAppAuthToken,
  // The custody-native publication persists a rotated set through rotateCustody and
  // establishes a fresh login's record through setOpenIDAuthTokens/createCustody; it writes no
  // `sessions` row and no bridge.
  getCustody: getTokenCustodyService,
  setTokenKeyCookie: api.setTokenKeyCookie,
  createOpenIDRefreshFlightKey: flight.createOpenIDRefreshFlightKey,
  revokeOpenIDRefreshFlights: flight.revokeOpenIDRefreshFlights,
});
