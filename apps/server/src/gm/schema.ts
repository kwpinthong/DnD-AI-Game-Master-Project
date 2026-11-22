import { ACTION_KINDS, ACTION_TAGS, SEVERITIES, STATUS_SCOPES } from '@isekai/rules';
import { z } from 'zod';
import { EventOutcomeProposal } from '../timeline/trigger.ts';

/**
 * What the AI GM answers in the turn loop (GEN-057, ADR "Isekai Chronicles - AI GM" §3, §5.2, §6.3).
 * The shapes are kept structural: ids, tags, costs, caps and refs are checked by the server afterwards
 * (`check.ts`), so a wrong value comes back to the AI as a repair error list (Q-049) instead of a bare retry.
 * Every text uses {{p:ref}} / {{n:id}} tokens, never a real name (Q-045).
 */

const Severity = z.enum(SEVERITIES).nullable();
const Int = z.number().int();

const StatusRequest = z.object({
  label: z.string().max(30),
  polarity: z.enum(['buff', 'debuff']),
  mods: z.array(z.object({ scope: z.enum(STATUS_SCOPES), value: Int })).max(2),
  phases: Int,
  visible: z.boolean(),
});

const Effects = z.object({
  repDelta: Int,
  karmaDelta: Int,
  affinity: z.array(z.object({ npcId: z.string(), delta: Int })).max(3),
  damage: Severity,
  selfDamage: Severity,
  heal: Severity,
  addStatus: z.array(StatusRequest).max(2),
  removeStatus: z.array(z.string()).max(2),
});
export type GmEffects = z.infer<typeof Effects>;

const Modifier = z.union([
  z.object({ source: z.enum(['item', 'skill']), ref: z.string(), value: Int }),
  z.object({ source: z.literal('stat') }),
  z.object({ source: z.literal('rep'), mode: z.enum(['favor', 'fear']) }),
  z.object({ source: z.literal('karma'), align: z.enum(['light', 'dark']) }),
  z.object({ source: z.literal('affinity'), ref: z.string() }),
]);

const PlayerEffects = z.object({ damage: Severity, heal: Severity, takeItem: z.string().nullable(), giveItem: z.string().nullable() });
const GearRef = z.object({ ref: z.string(), value: Int }).nullable();

export const GmAction = z.object({
  /** Must be the id the server gave, in the server's order. */
  actionId: z.string(),
  /** The actor's player ref (the `ref` of {{p:ref}}). */
  actor: z.string(),
  kind: z.enum(ACTION_KINDS),
  tags: z.array(z.enum(ACTION_TAGS)).max(2),
  opposed: z.boolean(),
  staminaCost: Int,
  check: z.union([z.object({ type: z.literal('dc'), dc: Int }), z.object({ type: z.literal('pvp') }), z.object({ type: z.literal('none') })]),
  modifiers: z.array(Modifier).max(6),
  /** Scenario NPC id, or null. */
  targetNpc: z.string().nullable(),
  targetPlayer: z
    .object({
      player: z.string(),
      intent: z.enum(['harm', 'steal', 'help', 'give', 'rescue']),
      defenseRef: GearRef,
      perceptionRef: GearRef,
      onSuccess: PlayerEffects,
      onFail: PlayerEffects,
    })
    .nullable(),
  witnessNpcIds: z.array(z.string()).max(6),
  repDeltaIfCaught: Int,
  onSuccess: Effects,
  onFail: Effects,
  /** GEN-064: tags from the game data only. */
  tagging: z.object({
    verbTags: z.array(z.string()).max(4),
    targetTags: z.array(z.string()).max(4),
    activate: z.array(z.object({ ref: z.string(), stamina: Int.nullable() })).max(3),
  }),
  /** Scenario location id the actor goes to when the action succeeds; null = stays. */
  moveTo: z.string().nullable(),
  awareness: z.enum(['watch', 'asleep', 'normal']),
  /** INVESTIGATE: a success finds Hidden Evidence left at the place today (GEN-067, Q-135). */
  investigate: z.boolean(),
  /** What the actor does, in tokens: the GM's own log and memory (not narration). */
  intentSummary: z.string().min(1).max(200),
  reason: z.string().max(300),
});
export type GmAction = z.infer<typeof GmAction>;

export const GmTurnProposal = z.object({
  actions: z.array(GmAction).max(6),
  /** Constraint Lock (C4): stays until released with a reason. */
  constraints: z.object({
    add: z.array(z.object({ player: z.string(), text: z.string().min(1).max(200), reason: z.string().max(300) })).max(6),
    release: z.array(z.object({ id: Int, reason: z.string().max(300) })).max(6),
  }),
  eventOutcomes: EventOutcomeProposal.shape.eventOutcomes,
  /** Notes for the GM's own memory of today. */
  remember: z.array(z.string().min(1).max(200)).max(5),
});
export type GmTurnProposal = z.infer<typeof GmTurnProposal>;

/** One narration for one audience (a place's feed, or one player's private column). */
export const GmNarration = z.object({
  segments: z.array(z.object({ actionId: z.string(), text: z.string().min(1).max(800) })).min(1).max(12),
});
export type GmNarration = z.infer<typeof GmNarration>;

/** The recap of a finished day and the saga folded through it (ADR §6.3). */
export const GmDaySummary = z.object({
  recap: z.string().min(1).max(1800),
  saga: z.string().min(1).max(4500),
});
export type GmDaySummary = z.infer<typeof GmDaySummary>;

/** One player's journal of a finished day and their saga folded through it (ADR §6.3, Q-153). */
export const GmJournal = z.object({
  journal: z.string().min(1).max(750),
  saga: z.string().min(1).max(1800),
});
export type GmJournal = z.infer<typeof GmJournal>;

/** `output.name` of each GM request; the Mock provider answers by these names when it has no script. */
export const GM_OUTPUT = { turn: 'gm_turn_proposal', narration: 'gm_narration', daySummary: 'gm_day_summary', journal: 'gm_journal' } as const;
