import { RollError } from './errors.ts';
import type { Rng } from './rng.ts';

/** Uniform whole number in [min, max], both inclusive, e.g. rest recovery +15..25. */
export function rollRange(min: number, max: number, rng: Rng): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new RollError('range', `Range ${min}..${max} needs whole numbers with min <= max`);
  }
  return rng.nextInt(min, max);
}

/** One row of a weight table. Weights are whole numbers >= 0, e.g. origin 70 / 29 / 1. */
export interface WeightedEntry<T> {
  readonly value: T;
  readonly weight: number;
}

/** Picks one value with probability weight / total weight. */
export function pickWeighted<T>(table: readonly WeightedEntry<T>[], rng: Rng): T {
  let total = 0;
  for (const { weight } of table) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RollError('table', `Weight table has weight ${weight}; weights must be whole numbers >= 0`);
    }
    total += weight;
  }
  if (total === 0) throw new RollError('table', 'Weight table has total weight 0; nothing can be picked');

  let ticket = rng.nextInt(1, total);
  for (const entry of table) {
    ticket -= entry.weight;
    if (ticket <= 0) return entry.value;
  }
  throw new Error(`Rng returned a value outside 1..${total}`);
}
