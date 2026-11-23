import { ACTION_KINDS, ACTION_TAGS, PLAYER_INTENTS, SEVERITIES, STATUS_SCOPES } from '@isekai/rules';
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
/**
 * GEN-158: fields whose usual value is 0 / null / [] / false carry it as a default, so the AI may leave them out
 * (the service sends the input-side JSON schema) and writes about half the tokens. A value given is checked as before.
 */
const Zero = Int.default(0);
const NoSeverity = Severity.default(null);
const NoText = z.string().nullable().default(null);

const StatusRequest = z.object({
  label: z.string().max(30),
  polarity: z.enum(['buff', 'debuff']),
  mods: z.array(z.object({ scope: z.enum(STATUS_SCOPES), value: Int })).max(2),
  phases: Int,
  visible: z.boolean(),
});

const Effects = z
  .object({
    repDelta: Zero,
    karmaDelta: Zero,
    affinity: z.array(z.object({ npcId: z.string(), delta: Int })).max(3).default([]),
    damage: NoSeverity,
    selfDamage: NoSeverity,
    heal: NoSeverity,
    addStatus: z.array(StatusRequest).max(2).default([]),
    removeStatus: z.array(z.string()).max(2).default([]),
  })
  .prefault({});
export type GmEffects = z.infer<typeof Effects>;

const Modifier = z.union([
  z.object({ source: z.enum(['item', 'skill']), ref: z.string(), value: Int }),
  z.object({ source: z.literal('stat') }),
  z.object({ source: z.literal('rep'), mode: z.enum(['favor', 'fear']) }),
  z.object({ source: z.literal('karma'), align: z.enum(['light', 'dark']) }),
  z.object({ source: z.literal('affinity'), ref: z.string() }),
]);

const PlayerEffects = z.object({ damage: NoSeverity, heal: NoSeverity, takeItem: NoText, giveItem: NoText }).prefault({});
const GearRef = z.object({ ref: z.string(), value: Int }).nullable().default(null);

export const GmAction = z.object({
  /** Must be the id the server gave, in the server's order. */
  actionId: z.string(),
  /** The actor's player ref (the `ref` of {{p:ref}}). */
  actor: z.string(),
  kind: z.enum(ACTION_KINDS),
  tags: z.array(z.enum(ACTION_TAGS)).max(2).default([]),
  opposed: z.boolean().default(false),
  staminaCost: Int,
  check: z.union([z.object({ type: z.literal('dc'), dc: Int }), z.object({ type: z.literal('pvp') }), z.object({ type: z.literal('none') })]),
  modifiers: z.array(Modifier).max(6).default([]),
  /** Scenario NPC id, or null. */
  targetNpc: NoText,
  targetPlayer: z
    .object({
      player: z.string(),
      intent: z.enum(PLAYER_INTENTS),
      defenseRef: GearRef,
      perceptionRef: GearRef,
      onSuccess: PlayerEffects,
      onFail: PlayerEffects,
    })
    .nullable()
    .default(null),
  /**
   * GEN-117 (Q-292): player refs this action really looks at (มอง / สังเกต / คุย, or a direct pair action) beyond
   * `targetPlayer`. Only the actor's narration may then describe how they look. Empty = looks at nobody.
   */
  looksAt: z.array(z.string()).max(3).default([]),
  witnessNpcIds: z.array(z.string()).max(6).default([]),
  repDeltaIfCaught: Zero,
  onSuccess: Effects,
  onFail: Effects,
  /** GEN-064: tags from the game data only. */
  tagging: z
    .object({
      verbTags: z.array(z.string()).max(4).default([]),
      targetTags: z.array(z.string()).max(4).default([]),
      activate: z.array(z.object({ ref: z.string(), stamina: Int.nullable() })).max(3).default([]),
    })
    .prefault({}),
  /** Scenario location id the actor goes to when the action succeeds; null = stays. */
  moveTo: NoText,
  awareness: z.enum(['watch', 'asleep', 'normal']),
  /** INVESTIGATE: a success finds Hidden Evidence left at the place today (GEN-067, Q-135). */
  investigate: z.boolean().default(false),
  /**
   * Q-180, applied to the actor only when this action succeeds: unlock-condition flags the AI judged happened
   * (names from the rules' flag list, e.g. protected_others) ...
   */
  skillFlags: z.array(z.string()).max(3).default([]),
  /**
   * ... and skills / items given: a skill whose unlock conditions hold or that `npcId` gives as an open reward;
   * an item only as an open reward of `npcId`. Anything else is refused and repaired (Q-049).
   */
  grants: z
    .array(z.object({ kind: z.enum(['skill', 'item']), name: z.string(), npcId: z.string().nullable() }))
    .max(2)
    .default([]),
  /**
   * GEN-093 (Q-203), only on the night of day 10 while its event is active: the Day10_Strategies plan this
   * action is part of (`id`, never D10-DRIFT) and the actor's role in it; null = no plan. The server records it
   * per player with the action's result; the day 12 finale reads it.
   */
  strategy: z
    .object({ id: z.string(), role: z.enum(['leader', 'support']) })
    .nullable()
    .default(null),
  /** What the actor does, in tokens: the GM's own log and memory (not narration). */
  intentSummary: z.string().min(1).max(200),
  reason: z.string().max(300),
});
export type GmAction = z.infer<typeof GmAction>;

export const GmTurnProposal = z.object({
  actions: z.array(GmAction).max(6),
  /** Constraint Lock (C4): stays until released with a reason. */
  constraints: z
    .object({
      add: z.array(z.object({ player: z.string(), text: z.string().min(1).max(200), reason: z.string().max(300) })).max(6).default([]),
      release: z.array(z.object({ id: Int, reason: z.string().max(300) })).max(6).default([]),
    })
    .prefault({}),
  eventOutcomes: EventOutcomeProposal.shape.eventOutcomes.default([]),
  /**
   * GEN-059, only while the day 12 finale event is active: the ending path the players completed this turn
   * (Good: the miracle veil, Evil: absorbing the meteor, Neutral: cancelling it with Astra and Serena); null =
   * none this turn. The server decides who survives from it when the game ends.
   */
  endingPath: z.enum(['good', 'evil', 'neutral']).nullable().default(null),
  /** Notes for the GM's own memory of today. */
  remember: z.array(z.string().min(1).max(200)).max(5).default([]),
});
export type GmTurnProposal = z.infer<typeof GmTurnProposal>;

/**
 * GEN-110: one line an NPC says with a narration. `npcId` = an NPC of the narration's `npcs` (the ones at the
 * place now). `dialogue` = the NPC talks about / to what the players did; `reaction` = a bystander's one line.
 * Who hears it follows the audience, never the AI: a place narration's lines go to everyone there, a player
 * narration's lines to that player alone. No limits here on purpose: the server trims (`npc-lines.ts`), so
 * an over-long answer never costs a repair or the turn.
 */
export const GmNpcLine = z.object({ npcId: z.string(), kind: z.enum(['dialogue', 'reaction']), text: z.string() });
export type GmNpcLine = z.infer<typeof GmNpcLine>;

/**
 * One narration for one audience (a place's feed, or one player's private column). GEN-116: the NPC lines are a second
 * stage (`GmDialogue`); an old stored narration with `npcLines` still parses (the key is dropped).
 */
export const GmNarration = z.object({
  segments: z.array(z.object({ actionId: z.string(), text: z.string().min(1).max(800) })).min(1).max(12),
});
export type GmNarration = z.infer<typeof GmNarration>;

/** GEN-116: the second stage of a turn: the NPC lines of one audience, written after its narration was shown. */
export const GmDialogue = z.object({ npcLines: z.array(GmNpcLine) });
export type GmDialogue = z.infer<typeof GmDialogue>;

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

/**
 * The ending told once the game ended (GEN-059): one text for the whole table and one per player, every
 * player ref of the context exactly once.
 */
export const GmFinale = z.object({
  overall: z.string().min(1).max(2000),
  players: z.array(z.object({ player: z.string(), text: z.string().min(1).max(1200) })).max(12),
});
export type GmFinale = z.infer<typeof GmFinale>;

/** `output.name` of each GM request; the Mock provider answers by these names when it has no script. */
export const GM_OUTPUT = {
  turn: 'gm_turn_proposal',
  narration: 'gm_narration',
  dialogue: 'gm_dialogue',
  daySummary: 'gm_day_summary',
  journal: 'gm_journal',
  finale: 'gm_finale',
} as const;
