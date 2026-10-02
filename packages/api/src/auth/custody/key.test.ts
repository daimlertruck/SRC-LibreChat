import { TOKEN_KEY_BYTES, TOKEN_KEY_PATTERN, generateTokenKey, parseTokenKey } from './key';

/** A genuine 43-character key value, mutated below into near misses. */
const base = Buffer.alloc(TOKEN_KEY_BYTES, 0xa5).toString('base64url');

describe('generateTokenKey', () => {
  it('returns a value matching TOKEN_KEY_PATTERN', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateTokenKey()).toMatch(TOKEN_KEY_PATTERN);
    }
  });

  it('round-trips through parseTokenKey to 32 bytes that re-encode to the same value', () => {
    for (let i = 0; i < 20; i++) {
      const generated = generateTokenKey();
      const parsed = parseTokenKey(generated);

      expect(parsed).toBeInstanceOf(Buffer);
      expect(parsed?.length).toBe(TOKEN_KEY_BYTES);
      expect(parsed?.toString('base64url')).toBe(generated);
    }
  });

  it('returns a different value on each call', () => {
    const generated = Array.from({ length: 20 }, () => generateTokenKey());
    expect(new Set(generated).size).toBe(generated.length);
  });
});

describe('parseTokenKey', () => {
  it('accepts the unmutated base value the near misses start from', () => {
    expect(parseTokenKey(base)?.equals(Buffer.alloc(TOKEN_KEY_BYTES, 0xa5))).toBe(true);
  });

  it('returns null for undefined', () => {
    expect(parseTokenKey(undefined)).toBeNull();
  });

  /** Node's base64url decoder is lenient, so each of these must be stopped by the pattern gate. */
  it.each<[string, string]>([
    ['with padding', `${base}=`],
    ['truncated by one character', base.slice(0, 42)],
    ['one character too long', `${base}A`],
    ['ending in "+"', `${base.slice(0, 42)}+`],
    ['ending in "/"', `${base.slice(0, 42)}/`],
    ['with trailing whitespace', `${base.slice(0, 42)} `],
    ['with leading whitespace', ` ${base.slice(0, 42)}`],
  ])('returns null for a key value %s', (_label, value) => {
    expect(TOKEN_KEY_PATTERN.test(value)).toBe(false);
    expect(parseTokenKey(value)).toBeNull();
  });

  it.each<[string, string]>([
    ['the empty string', ''],
    ['a single character', 'a'],
    ['a trailing newline', `${base}\n`],
    ['a multi-byte character', `${base.slice(0, 42)}é`],
    ['an emoji', `${base.slice(0, 41)}🔑`],
    ['standard base64 of 32 bytes', Buffer.alloc(TOKEN_KEY_BYTES, 0xff).toString('base64')],
    ['hex of 32 bytes', Buffer.alloc(TOKEN_KEY_BYTES, 0xa5).toString('hex')],
    ['an 8 KB value', 'a'.repeat(8192)],
    ['a dot in the middle', `${base.slice(0, 20)}.${base.slice(21)}`],
  ])('returns null for %s', (_label, value) => {
    expect(TOKEN_KEY_PATTERN.test(value)).toBe(false);
    expect(parseTokenKey(value)).toBeNull();
  });
});
