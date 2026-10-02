import type { Request } from 'express';

import {
  TOKEN_KEY_BYTES,
  TOKEN_KEY_COOKIE,
  TOKEN_KEY_PATTERN,
  generateTokenKey,
  hashTokenKey,
  parseTokenKey,
  readTokenKey,
} from './key';

/**
 * Covers the one boundary from cookie text to key material (`parseTokenKey` /
 * `readTokenKey`) and checks the key module never emits the key, its encoding,
 * a substring of either, or the raw hex.
 */

/** A genuine 43-char base64url key to derive near-miss rejection cases from. */
const VALID_KEY = generateTokenKey();
/** The 43rd character is dropped/replaced below to build wrong-length values. */
const BODY_42 = VALID_KEY.slice(0, 42);

describe('parseTokenKey', () => {
  it('accepts a genuine 43-char base64url value and returns the 32 raw bytes', () => {
    const parsed = parseTokenKey(VALID_KEY);
    expect(parsed).toBeInstanceOf(Buffer);
    expect((parsed as Buffer).length).toBe(TOKEN_KEY_BYTES);
    expect((parsed as Buffer).toString('base64url')).toBe(VALID_KEY);
  });

  // Each row is a value that MUST be rejected: no throw, null (never a Buffer).
  // `input` is typed `string | undefined` so the `undefined` row type-checks.
  const rejectionCases: ReadonlyArray<{ name: string; input: string | undefined }> = [
    { name: 'undefined', input: undefined },
    { name: 'empty string', input: '' },
    { name: 'wrong length (42 chars)', input: BODY_42 },
    { name: 'wrong length (44 chars)', input: `${VALID_KEY}A` },
    { name: '"=" padding', input: `${BODY_42}=` },
    { name: '"+" outside the base64url alphabet', input: `${BODY_42}+` },
    { name: '"/" outside the base64url alphabet', input: `${BODY_42}/` },
    { name: 'leading whitespace', input: ` ${BODY_42}` },
    { name: 'trailing whitespace', input: `${BODY_42} ` },
    { name: 'embedded whitespace', input: `${VALID_KEY.slice(0, 21)} ${VALID_KEY.slice(22)}` },
    { name: 'embedded newline', input: `${VALID_KEY.slice(0, 21)}\n${VALID_KEY.slice(22)}` },
    // A cookie value truncated in transit: the leading bytes of a real key.
    { name: 'truncated cookie value', input: VALID_KEY.slice(0, 30) },
  ];

  it.each(rejectionCases)(
    'rejects $name: returns null, does not throw, returns no Buffer',
    ({ input }) => {
      let result: Buffer | null = 'sentinel' as unknown as Buffer | null;
      expect(() => {
        result = parseTokenKey(input);
      }).not.toThrow();
      expect(result).toBeNull();
      expect(result).not.toBeInstanceOf(Buffer);
    },
  );

  it.each(rejectionCases.filter((c) => c.input !== undefined))(
    'every rejected non-undefined case ($name) also fails TOKEN_KEY_PATTERN',
    ({ input }) => {
      // The strict pattern gate is what makes the rejection total; the embedded
      // and truncated cases confirm no lenient decode slips through.
      expect(TOKEN_KEY_PATTERN.test(input as string)).toBe(false);
    },
  );
});

describe('readTokenKey', () => {
  /** Minimal Request stand-in carrying only the cookies the reader inspects. */
  const asRequest = (cookies?: Record<string, string>): Request =>
    ({ cookies }) as unknown as Request;

  it('returns null for a request with no cookies object', () => {
    expect(readTokenKey(asRequest(undefined))).toBeNull();
  });

  it('returns null for a request with an empty cookies object', () => {
    expect(readTokenKey(asRequest({}))).toBeNull();
  });

  it('returns null for a request whose cookies lack the token key cookie', () => {
    expect(readTokenKey(asRequest({ some_other_cookie: VALID_KEY }))).toBeNull();
  });

  it('returns null for a request whose token key cookie is malformed', () => {
    expect(readTokenKey(asRequest({ [TOKEN_KEY_COOKIE]: BODY_42 }))).toBeNull();
  });

  it('returns the 32 raw bytes for a request carrying a valid token key cookie', () => {
    const parsed = readTokenKey(asRequest({ [TOKEN_KEY_COOKIE]: VALID_KEY }));
    expect(parsed).toBeInstanceOf(Buffer);
    expect((parsed as Buffer).length).toBe(TOKEN_KEY_BYTES);
    expect((parsed as Buffer).toString('base64url')).toBe(VALID_KEY);
  });
});

describe('key non-publication', () => {
  /** Every console channel the module could conceivably write to. */
  const CONSOLE_CHANNELS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

  it('emits nothing to any console channel across accept and reject paths, and no output carries the key', () => {
    const captured: string[] = [];
    const spies = CONSOLE_CHANNELS.map((channel) =>
      jest.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      }),
    );

    // A fresh key so the assertions below cannot pass by matching the shared
    // VALID_KEY only; we search for THIS key's material specifically.
    const encodedKey = generateTokenKey();
    const rawKey = parseTokenKey(encodedKey) as Buffer;
    const rawHex = rawKey.toString('hex');
    const rawUtf8 = rawKey.toString('binary');
    // A mid-string substring of the encoded key — a partial leak would contain it.
    const encodedSubstring = encodedKey.slice(8, 32);

    let leaked: unknown;
    try {
      // Drive the module over its full surface: accept path, hashing, the reader,
      // and a spread of reject paths, so any stray write would be captured.
      parseTokenKey(encodedKey);
      hashTokenKey(rawKey);
      readTokenKey({ cookies: { [TOKEN_KEY_COOKIE]: encodedKey } } as unknown as Request);
      readTokenKey({ cookies: {} } as unknown as Request);
      readTokenKey({} as unknown as Request);
      for (const { input } of [
        { input: undefined },
        { input: '' },
        { input: `${encodedKey}=` },
        { input: `${encodedKey.slice(0, 42)}+` },
        { input: `${encodedKey.slice(0, 42)}/` },
        { input: ` ${encodedKey.slice(0, 42)}` },
        { input: encodedKey.slice(0, 30) },
      ] as ReadonlyArray<{ input: string | undefined }>) {
        parseTokenKey(input);
      }
    } catch (error) {
      // No path here should throw; if one does, capture it so we can assert the
      // thrown value does not leak the key either.
      leaked = error;
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }

    // No path threw.
    expect(leaked).toBeUndefined();

    // The module wrote nothing at all.
    expect(captured).toEqual([]);

    // And — belt and suspenders — nothing captured contains the key in any form.
    const haystack = captured.join('\n');
    expect(haystack).not.toContain(encodedKey);
    expect(haystack).not.toContain(encodedSubstring);
    expect(haystack).not.toContain(rawHex);
    expect(haystack).not.toContain(rawUtf8);
  });

  it('does not throw or return key material for hostile input', () => {
    // parseTokenKey is documented never to throw; assert that even hostile input
    // that would break a naive decoder neither throws nor surfaces key material.
    const encodedKey = generateTokenKey();
    const hostile = [`${encodedKey}\u0000`, `${encodedKey.slice(0, 42)}\n`, `\t${encodedKey}`];
    for (const value of hostile) {
      let thrown: unknown;
      let result: Buffer | null = null;
      try {
        result = parseTokenKey(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      expect(result).toBeNull();
    }
  });
});
