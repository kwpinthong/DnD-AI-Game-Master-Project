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
export {
  ACTIVE_SKILL_STAMINA,
  ANY_TAG,
  RANK_DICE_CAP,
  TAG_SOURCE_KINDS,
  applyTagging,
  chargeOnCrit,
  isQualitativeSource,
  matchingSources,
  sourceMatches,
  tagBonus,
  tagBonusCap,
  tagTargetBonus,
  validateTagging,
  type Activation,
  type JudgedRef,
  type SourceRank,
  type TagBonusLog,
  type TagClaim,
  type TagContext,
  type TaggingLog,
  type TagSource,
  type TagSourceKind,
} from './resolution/tags.ts';
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
export * from './crossplayer/types.ts';
export { orderPhaseActions, replayPhaseActions, resolvePhaseActions, validatePhaseActions } from './crossplayer/phase.ts';
export * from './phase/types.ts';
export {
  REST,
  createPhaseState,
  gainStamina,
  isDrowsy,
  nextPoint,
  phaseStep,
  restorePhaseState,
  secretQuotaUsed,
  turnNumber,
} from './phase/engine.ts';
export { socialTitle, STARTING_STATS } from './character.ts';
export {
  injuryText,
  NPC_NAME_REVEAL_AFFINITY,
  PLAYER_NAME_REVEAL_RELATIONSHIP,
  RELATIONSHIP_MAX,
  RELATIONSHIP_MIN,
  revealsNpcName,
  revealsPlayerName,
  type InjuryText,
} from './visibility.ts';
export { KARMA_MAX, KARMA_MIN, karmaTierProblems, karmaTitle, type KarmaTier } from './karma.ts';
