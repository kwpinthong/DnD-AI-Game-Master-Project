import { randomInt } from 'node:crypto';
import type { Rng } from '@isekai/rules';

/**
 * Production RNG for every real roll. node:crypto randomInt draws from the OS CSPRNG and uses
 * rejection sampling, so there is no modulo bias. Tests and replays use SeededRng instead.
 */
export class CryptoRng implements Rng {
  nextInt(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new RangeError(`CryptoRng needs whole numbers with min <= max, got ${min}..${max}`);
    }
    // randomInt's upper bound is exclusive and the span must stay below 2^48 (it throws RangeError otherwise).
    return randomInt(min, max + 1);
  }
}
