export type { Rng } from './rng.ts';
export { SeededRng } from './rng.ts';
export { RollError, type RollErrorCode } from './errors.ts';
export {
  MAX_DICE,
  MAX_MODIFIER,
  MAX_SIDES,
  parseDice,
  rollDice,
  rollDie,
  type DiceExpression,
  type DiceRoll,
} from './dice.ts';
