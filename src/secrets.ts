import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Crockford base32: no I, L, O, U, so codes are easy to read aloud and retype.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(bytes: Buffer, length: number): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** 130-bit chat ID, lowercase base32 (URL-friendly). */
export function newChatId(): string {
  return base32(randomBytes(17), 26).toLowerCase();
}

/** 50-bit join code formatted XXXXX-XXXXX. Brute force is stopped by lockout, not entropy alone. */
export function newJoinCode(): string {
  const raw = base32(randomBytes(7), 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Normalise user-typed codes: case-insensitive, ignore spaces/dashes, map look-alikes. */
export function normaliseJoinCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

/** 256-bit bearer token with a type prefix so leaked tokens are recognisable. */
export function newToken(prefix: 'pt' | 'vk'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison of two strings (via their hashes, so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
