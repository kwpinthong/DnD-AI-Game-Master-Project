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
