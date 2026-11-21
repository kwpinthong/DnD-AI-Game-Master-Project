import type { Rng } from './rng.ts';

/** Rolls one die with `sides` faces. Dice expressions ("2d6+3") come with the rules engine task. */
export function rollDie(sides: number, rng: Rng): number {
  if (!Number.isInteger(sides) || sides < 1) {
    throw new RangeError(`A die needs a whole number of sides >= 1, got ${sides}`);
  }
  return rng.nextInt(1, sides);
}
