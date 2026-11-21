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
export { pickWeighted, rollRange, type WeightedEntry } from './random.ts';
export * from './resolution/types.ts';
export {
  GRADE_OBS_MOD,
  NPC_HP_MAX,
  RULES,
  SEVERITY_BASE,
  TIER_CAP,
  affinityMod,
  computeStat,
  conditionsOf,
  karmaBand,
  repTier,
  staminaCostRange,
  type RepTier,
  type StatQuery,
} from './resolution/tables.ts';
export { validateProposal } from './resolution/validate.ts';
export { ReplayRng, replayResolution, resolveAction } from './resolution/resolve.ts';
export {
  RESCUE_AID_DC,
  SAFETY_MOD,
  WAKE,
  rescueOutcome,
  rescueScore,
  rollRescue,
  wakeAfter,
  type RescueOutcome,
  type Safety,
} from './resolution/rescue.ts';
