/** Source of randomness for the rules engine. The server injects a crypto RNG; tests inject SeededRng. */
export interface Rng {
  /** Uniform integer in [min, max], both inclusive. */
  nextInt(min: number, max: number): number;
}

/** Deterministic RNG (mulberry32) for tests and replays. Never use it for real rolls. */
export class SeededRng implements Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  nextInt(min: number, max: number): number {
    return min + Math.floor(this.#nextFloat() * (max - min + 1));
  }

  #nextFloat(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
