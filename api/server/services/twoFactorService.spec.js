const crypto = require('node:crypto');

jest.mock('node:crypto', () => {
  const actual = jest.requireActual('node:crypto');
  return {
    ...actual,
    timingSafeEqual: jest.fn((a, b) => actual.timingSafeEqual(a, b)),
  };
});

jest.mock('@librechat/data-schemas', () => ({
  hashBackupCode: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  readTotpSecret: jest.fn(async (storedSecret) => storedSecret),
}));

jest.mock('~/models', () => ({ updateUser: jest.fn() }));

const { generateTOTP, verifyTOTP, generateTOTPSecret } = require('./twoFactorService');

describe('verifyTOTP', () => {
  it('accepts a valid current TOTP code', async () => {
    const secret = generateTOTPSecret();
    const code = await generateTOTP(secret);
    await expect(verifyTOTP(secret, code)).resolves.toBe(true);
  });

  it('rejects an invalid code of the same length', async () => {
    const secret = generateTOTPSecret();
    const code = await generateTOTP(secret);
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(verifyTOTP(secret, wrong)).resolves.toBe(false);
  });

  it('compares codes in constant time via crypto.timingSafeEqual', async () => {
    const secret = generateTOTPSecret();
    const code = await generateTOTP(secret);
    crypto.timingSafeEqual.mockClear();
    await verifyTOTP(secret, code);
    expect(crypto.timingSafeEqual).toHaveBeenCalled();
  });
});
