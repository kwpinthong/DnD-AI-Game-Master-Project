import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// PIN hashes use Node's built-in scrypt (GEN-022 picked scrypt for secrets; no native dependency).
// Format: scrypt$N$r$p$<salt base64>$<hash base64>, so the cost can be raised later and old
// hashes still verify.
const COST = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

function derive(pin: string, salt: Buffer, options: ScryptOptions, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** True when `stored` has the shape hashSecret writes (used to check CREATE_CODE_HASH at start). */
export function isSecretHash(stored: string): boolean {
  const [scheme, n, r, p, saltB64, hashB64, ...rest] = stored.split('$');
  const positive = (v: string | undefined) => /^[1-9][0-9]*$/.test(v ?? '');
  const base64 = (v: string | undefined) => /^[A-Za-z0-9+/]+={0,2}$/.test(v ?? '');
  return scheme === 'scrypt' && positive(n) && positive(r) && positive(p) && base64(saltB64) && base64(hashB64) && rest.length === 0;
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pin, salt, COST, KEY_LENGTH);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await derive(pin, Buffer.from(saltB64, 'base64'), { N: Number(n), r: Number(r), p: Number(p) }, expected.length);
  return timingSafeEqual(key, expected);
}

// The create code (Q-021) is hashed and checked the same way as PINs.
export const hashSecret = hashPin;
export const verifySecret = verifyPin;
