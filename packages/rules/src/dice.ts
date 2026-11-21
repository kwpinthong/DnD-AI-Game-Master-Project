import { RollError } from './errors.ts';
import type { Rng } from './rng.ts';

export const MAX_DICE = 100;
export const MAX_SIDES = 1000;
export const MAX_MODIFIER = 1000;

/** A parsed dice expression `NdS±M`. */
export interface DiceExpression {
  /** Canonical form, e.g. "1d20+4", "2d6-1", "1d100". */
  readonly notation: string;
  readonly count: number;
  readonly sides: number;
  readonly modifier: number;
}

/** The outcome of one dice expression, every die kept so it can be logged and replayed. */
export interface DiceRoll extends DiceExpression {
  /** Face of each die in the order rolled. */
  readonly faces: readonly number[];
  /** Sum of faces plus the modifier. */
  readonly total: number;
  /** Natural 20 on a single d20 (Q-053: no widened range). */
  readonly crit: boolean;
  /** Natural 1 on a single d20 (Q-053: no widened range). */
  readonly fumble: boolean;
}

/** Rolls one die with `sides` faces. */
export function rollDie(sides: number, rng: Rng): number {
  if (!Number.isInteger(sides) || sides < 1) {
    throw new RangeError(`A die needs a whole number of sides >= 1, got ${sides}`);
  }
  return rng.nextInt(1, sides);
}

const NOTATION = /^(\d*)d(\d+)(?:([+-])(\d+))?$/;

/**
 * Parses dice notation: `d20`, `d20+4`, `2d6+3`, `d100`. Case and spaces are ignored ("2D6 + 3").
 * One dice group and at most one modifier; anything else is a RollError.
 */
export function parseDice(input: string): DiceExpression {
  const compact = input.replace(/\s+/g, '').toLowerCase();
  if (compact === '') throw new RollError('empty', 'Dice notation is empty');

  const match = NOTATION.exec(compact);
  if (match === null) {
    throw new RollError('syntax', `Dice notation ${JSON.stringify(input)} is not like "d20", "d20+4" or "2d6+3"`);
  }
  const [, countText = '', sidesText = '', sign, modifierText] = match;

  const count = countText === '' ? 1 : Number(countText);
  if (count < 1 || count > MAX_DICE) {
    throw new RollError('count', `Dice notation ${JSON.stringify(input)} rolls ${count} dice; use 1..${MAX_DICE}`);
  }
  const sides = Number(sidesText);
  if (sides < 1 || sides > MAX_SIDES) {
    throw new RollError('sides', `Dice notation ${JSON.stringify(input)} has a d${sides}; use d1..d${MAX_SIDES}`);
  }
  const modifier = modifierText === undefined ? 0 : (sign === '-' ? -1 : 1) * Number(modifierText);
  if (Math.abs(modifier) > MAX_MODIFIER) {
    throw new RollError('modifier', `Dice notation ${JSON.stringify(input)} has modifier ${modifier}; use -${MAX_MODIFIER}..+${MAX_MODIFIER}`);
  }

  const suffix = modifier === 0 ? '' : modifier > 0 ? `+${modifier}` : `${modifier}`;
  return { notation: `${count}d${sides}${suffix}`, count, sides, modifier };
}

/** Rolls a dice expression (notation string or parsed) with the given RNG. */
export function rollDice(dice: string | DiceExpression, rng: Rng): DiceRoll {
  const expression = typeof dice === 'string' ? parseDice(dice) : dice;
  const faces = Array.from({ length: expression.count }, () => rollDie(expression.sides, rng));
  const total = faces.reduce((sum, face) => sum + face, expression.modifier);
  const singleD20 = expression.count === 1 && expression.sides === 20;

  return {
    ...expression,
    faces,
    total,
    crit: singleD20 && faces[0] === 20,
    fumble: singleD20 && faces[0] === 1,
  };
}
