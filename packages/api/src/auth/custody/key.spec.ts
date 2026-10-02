import crypto from 'node:crypto';
import { TOKEN_KEY_BYTES, TOKEN_KEY_PATTERN, hashTokenKey } from './key';

const keys: [string, Buffer][] = [
  ['all-zero', Buffer.alloc(TOKEN_KEY_BYTES)],
  ['all-0xff', Buffer.alloc(TOKEN_KEY_BYTES, 0xff)],
  ['ascending', Buffer.from(Array.from({ length: TOKEN_KEY_BYTES }, (_, i) => i))],
  ['random', crypto.randomBytes(TOKEN_KEY_BYTES)],
];

describe('hashTokenKey', () => {
  it.each(keys)('hashes the %s key identically across calls and buffer copies', (_label, key) => {
    expect(hashTokenKey(key)).toBe(hashTokenKey(key));
    expect(hashTokenKey(key)).toBe(hashTokenKey(Buffer.from(key)));
  });

  it.each(keys)(
    'hashes the %s key to 43-character base64url that is not the key itself',
    (_label, key) => {
      const hash = hashTokenKey(key);
      expect(hash).toMatch(TOKEN_KEY_PATTERN);
      expect(hash).not.toBe(key.toString('base64url'));
    },
  );

  it('gives a distinct hash for a key differing in any single byte', () => {
    const base = crypto.randomBytes(TOKEN_KEY_BYTES);
    const hashes = new Set([hashTokenKey(base)]);
    for (let position = 0; position < TOKEN_KEY_BYTES; position++) {
      const variant = Buffer.from(base);
      variant[position] ^= 0x01;
      hashes.add(hashTokenKey(variant));
    }
    expect(hashes.size).toBe(TOKEN_KEY_BYTES + 1);
  });

  it('gives distinct hashes for distinct random keys', () => {
    const fixed = keys.map(([, key]) => key);
    const random = Array.from({ length: 20 }, () => crypto.randomBytes(TOKEN_KEY_BYTES));
    const all = [...fixed, ...random];
    expect(new Set(all.map((key) => key.toString('hex'))).size).toBe(all.length);
    expect(new Set(all.map(hashTokenKey)).size).toBe(all.length);
  });
});
