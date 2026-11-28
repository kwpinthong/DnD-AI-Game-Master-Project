import type { ActionVisibility, Phase } from '@isekai/protocol';
import { ACTION_TAGS, karmaBand, type CrossPlayerState, type PeriodWeather, type TagContext, type Turn } from '@isekai/rules';
import { and, eq, isNull } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { NpcSpeech, VoiceForm } from '../assets/voice.ts';
import type { PromptBlock } from '../ai/provider.ts';
import { sheetNpcFor } from '../companions/sheet.ts';
import { itemsInGame, skillsInGame } from '../crossplayer/items.ts';
import { isLegacyOption, type StoredOption } from '../game/loot.ts';
import { titleOf } from '../game/character.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, member } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { SKILL_FLAGS } from '../skills/unlock-rules.ts';
import { buildEventContext, type EventContext } from '../timeline/context.ts';
import { namesVisibleTo, presencesInGame } from '../visibility/store.ts';
import { forAi, THAI_OUTPUT } from './language.ts';
import type { NewsSources } from './news.ts';
import { activeConstraints, dayLog, journalFor, memoryFor } from './store.ts';

/**
 * What the AI GM sees (GEN-057, ADR "Isekai Chronicles - AI GM" §6). Every request is one JSON object in
 * the user message. Players are `{{p:<ref>}}` tokens (the presence ref other players see, GEN-050), NPCs
 * `{{n:<id>}}`; a real name never goes into a prompt (Q-045): action text is tokenised before it is sent.
 * Karma is a band (-2..+2), never the number. No context is logged.
 */

export const playerToken = (ref: string) => `{{p:${ref}}}`;
export const npcToken = (id: string) => `{{n:${id}}}`;
export const TOKEN_PATTERN = /\{\{([pn]):([A-Za-z0-9_-]+)\}\}/g;
/** GEN-152: any {{...}} left after the p / n tokens are rendered ({{place}}, a wrong kind, a half token) is dropped, never shown raw. */
export const stripStrayTokens = (text: string) => text.replace(/\{\{[^}]*\}\}|\{\{|\}\}/g, '').replace(/ {2,}/g, ' ');

/** Rough, on the safe side for Thai (one token per non-ASCII character). Used for the context budget. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return other + Math.ceil(ascii / 4);
}

/** GEN-195: the most the Voice style block (gm/tone.ts styleBlock) may add to every narration / dialogue call. */
export const STYLE_BLOCK_TOKENS = 1_000;
/** ISK-009: the most an arrival (its `arrival` and beat) may add to a player narration. */
export const ARRIVAL_TOKENS = 300;
/** ADR §6.2 hard caps per call. GEN-195: the narration / dialogue caps grow by the style block, so it never stops a turn. */
export const CONTEXT_BUDGET = {
  gm_adjudicate: 20_000,
  narrate_player: 6_000 + STYLE_BLOCK_TOKENS + ARRIVAL_TOKENS,
  narrate_place: 5_000 + STYLE_BLOCK_TOKENS,
  /** GEN-116: the narration context without the journal, plus the narration. */
  npc_dialogue: 6_000 + STYLE_BLOCK_TOKENS,
  summarize_day: 14_000,
  summarize_journal: 6_000,
  /** GEN-059: the ending (every event outcome + one entry per player). */
  finale: 10_000,
} as const;
/** ADR §6.2 / §6.3: what of a player's journal their narrator gets (saga ≤ 600 + yesterday ≤ 250 tokens). */
export const JOURNAL_BUDGET = { saga: 600, yesterday: 250 } as const;
/** How much of today's turn log the adjudicator gets (newest kept). */
const TODAY_LOG_TOKENS = 3_000;

// --- The game as the GM loop reads it ---

export interface GmPlayer {
  memberId: string;
  ref: string;
  name: string;
  appearance: string;
  socialTitle: string;
  locationId: string;
}

export interface GmWorld {
  gameId: string;
  players: Map<string, GmPlayer>;
  byRef: Map<string, GmPlayer>;
  /** `names`: every name the NPC_Schedule tab may call it by (real name, other names, the sheet's aliases). */
  npcs: { id: string; name: string; alias: string; rank: string; locationId: string; names: string[] }[];
  places: { id: string; name: string; safety: string; tags: string[] }[];
  /** Who knows whose real name (GEN-050 / GEN-067), by viewer. */
  knownNames: (viewerMemberId: string) => ReadonlySet<string>;
  /** Real names → tokens, longest first, for player-written text. */
  tokenise: (text: string) => string;
}

export function loadWorld(db: DbOrTx, gameId: string, assets: GameAssets): GmWorld {
  const scenario = getGameScenario(db, gameId);
  const presences = new Map(presencesInGame(db, gameId).map((p) => [p.memberId, p]));
  const rows = db
    .select({ c: character })
    .from(character)
    .innerJoin(member, eq(member.id, character.memberId))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt)))
    .all();
  const players = new Map<string, GmPlayer>();
  for (const { c } of rows) {
    const p = presences.get(c.memberId);
    if (!p) continue;
    players.set(c.memberId, { memberId: c.memberId, ref: p.ref, name: c.name, appearance: c.appearance, socialTitle: titleOf(c), locationId: p.locationId });
  }
  const npcs = (scenario?.npcs ?? []).map((n) => ({
    id: n.id,
    name: n.name,
    alias: n.alias,
    rank: n.rank,
    locationId: n.locationId,
    names: [...new Set([n.name, ...(n.otherNames ?? []), ...(sheetNpcFor(assets, n)?.record.aliases ?? [])])],
  }));
  const places = (scenario?.locations ?? []).map((l) => ({ id: l.id, name: l.name, safety: l.safety, tags: [...(assets.location(l.name)?.tags ?? [])] }));
  const names = [
    ...[...players.values()].map((p) => ({ name: p.name, token: playerToken(p.ref) })),
    ...npcs.map((n) => ({ name: n.name, token: npcToken(n.id) })),
  ]
    .filter((n) => n.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const known = new Map<string, ReadonlySet<string>>();
  return {
    gameId,
    players,
    byRef: new Map([...players.values()].map((p) => [p.ref, p])),
    npcs,
    places,
    knownNames: (viewer) => {
      let set = known.get(viewer);
      if (!set) known.set(viewer, (set = namesVisibleTo(db, viewer)));
      return set;
    },
    tokenise: (text) => names.reduce((out, n) => out.split(n.name).join(n.token), text),
  };
}

// --- gm_adjudicate ---

export interface TurnAction {
  actionId: string;
  memberId: string;
  text: string;
  visibility: ActionVisibility;
}

export interface PlayerContext {
  ref: string;
  appearance: string;
  socialTitle: string;
  place: string;
  hp: number;
  stamina: number;
  karmaBand: number;
  drowsy: boolean;
  /** `effect`: the qualitative text the AI judges (GEN-055); the numbers come through `tagSources`. */
  items: { id: string; name: string; tier: string; effect: string }[];
  skills: { id: string; name: string; tier: string; effect: string }[];
  tagSources: { id: string; kind: string; verbTags: string[]; targetTags: string[]; trigger: string; dailyLimit: number; usesToday: number }[];
  constraints: { id: number; text: string; reason: string; sinceDay: number }[];
  /** Timed curses on the player now (GEN-095): the server applies the d20 part; `effect` is the sheet text to judge the rest by. */
  curses: { label: string; source: string; effect: string }[];
}

export interface TurnContext {
  kind: 'gm_turn';
  turn: { day: number; phase: Phase; turn: Turn };
  /** The period's weather chosen by the AI GM within the server's limits (GEN-068, Q-089); null = none. */
  weather: string | null;
  /** Action ids in the server's order (GEN-060 §10.5). Answer every one, in this order. */
  order: string[];
  actions: { actionId: string; actor: string; place: string; visibility: ActionVisibility; text: string }[];
  /** Players who rest / sleep this turn (no action to judge). */
  resting: string[];
  players: PlayerContext[];
  places: { id: string; name: string; safety: string; tags: string[] }[];
  /**
   * `place`: where the NPC is now (GEN-175: NPC_Schedule + linger); '' = at none of the places (cannot be targeted).
   * `placeFor` (GEN-188): player ref → the NPC's place for that actor (karma-only schedule rows), only when it differs from `place`.
   */
  npcs: { id: string; alias: string; rank: string; place: string; placeFor?: Record<string, string>; curses: string[] }[];
  /** Every verb / target tag the game data has (GEN-064). */
  tagVocabulary: string[];
  events: { active: Omit<EventContext['active'][number], 'defaultOutcome'>[]; past: EventContext['past'] };
  memory: { saga: string | null; yesterday: string | null; today: string[] };
  /** GEN-118: last in the JSON, where the AI stops reading: the real AI stopped after an action with no effect and left the others out. */
  mustAnswer: string;
}

export interface TurnContextInput {
  world: GmWorld;
  state: CrossPlayerState;
  tags: Readonly<Record<string, TagContext>>;
  vocabulary: readonly string[];
  drowsy: ReadonlySet<string>;
  at: { day: number; phase: Phase; turn: Turn };
  /** In the server's order. */
  actions: readonly TurnAction[];
  resting: readonly string[];
  /** The period's weather (GEN-068); null = none chosen. */
  weather?: PeriodWeather | null;
  /** Game data: each skill / item's Rank and qualitative text (GEN-055). */
  assets?: GameAssets;
}

export function buildTurnContext(db: DbOrTx, input: TurnContextInput): TurnContext {
  const { world, state, at } = input;
  const skills = skillsInGame(db, world.gameId);
  const items = [...itemsInGame(db, world.gameId).values()];
  const gear = (o: StoredOption) => ({ id: o.id, name: world.tokenise(o.name), tier: optionTier(o, input.assets), effect: qualitativeText(o, input.assets) });
  const constraints = activeConstraints(db, world.gameId);
  const ref = (memberId: string) => world.players.get(memberId)?.ref ?? memberId;

  const players: PlayerContext[] = Object.values(state.players).flatMap((s) => {
    const p = world.players.get(s.id);
    if (!p) return [];
    const ctx = input.tags[s.id];
    return [
      {
        ref: p.ref,
        appearance: world.tokenise(p.appearance),
        socialTitle: p.socialTitle,
        place: s.locationId,
        hp: s.hp,
        stamina: s.stamina,
        karmaBand: karmaBand(s.karma),
        drowsy: input.drowsy.has(s.id),
        items: items.filter((i) => i.holderMemberId === s.id).map(gear),
        skills: (skills.get(s.id) ?? []).map(gear),
        tagSources: (ctx?.sources ?? []).map((src) => ({
          id: src.id,
          kind: src.kind,
          verbTags: [...src.verbTags],
          targetTags: [...src.targetTags],
          trigger: src.trigger,
          dailyLimit: src.dailyLimit,
          usesToday: ctx?.usesToday[src.id] ?? 0,
        })),
        constraints: constraints.filter((c) => c.memberId === s.id).map((c) => ({ id: c.id, text: c.text, reason: c.reason, sinceDay: c.day })),
        curses: s.statuses
          .filter((st) => st.origin === 'curse')
          .map((st) => ({ label: st.label, source: st.ref ?? '', effect: curseText(st.ref, input.assets) })),
      },
    ];
  });

  // GEN-093: with the assets, an active strategy event lists its Day10_Strategies plans.
  const events = buildEventContext(db, world.gameId, at.day, at.phase, input.assets);
  return {
    kind: 'gm_turn',
    turn: at,
    weather: input.weather ? weatherLabel(input.weather) : null,
    order: input.actions.map((a) => a.actionId),
    actions: input.actions.map((a) => ({
      actionId: a.actionId,
      actor: ref(a.memberId),
      place: state.players[a.memberId]?.locationId ?? '',
      visibility: a.visibility,
      text: world.tokenise(a.text),
    })),
    resting: input.resting.map(ref),
    players,
    places: world.places,
    // GEN-175: where the rules have the NPC now (schedule + linger), so a target the AI picks from this list is accepted.
    // GEN-188: the per-actor places the rules check with (GEN-184), by player ref; absent when everyone sees the same (no extra tokens).
    npcs: world.npcs.map((n) => {
      const placeFor = state.npcs[n.id]?.placeFor;
      return {
        id: n.id,
        alias: n.alias,
        rank: n.rank,
        place: state.npcs[n.id]?.locationId ?? n.locationId,
        ...(placeFor ? { placeFor: Object.fromEntries(Object.entries(placeFor).map(([memberId, at]) => [ref(memberId), at])) } : {}),
        curses: (state.npcs[n.id]?.statuses ?? []).filter((st) => st.origin === 'curse').map((st) => st.label),
      };
    }),
    tagVocabulary: [...input.vocabulary],
    // GEN-111: the drift outcome describes what comes after (e.g. "วันที่ 7 และ 10"); an active event hands the AI only what it
    // happens now, so the narration cannot run ahead of the day.
    events: { active: events.active.map(({ defaultOutcome: _ahead, ...now }) => now), past: events.past },
    memory: memoryContext(db, world.gameId, at),
    mustAnswer: `actions must have ${input.actions.length} entries, in the order ${input.actions.map((a) => a.actionId).join(', ')}, every one even without a mechanical effect`,
  };
}

/** The longest start of `text` within `max` tokens (`estimateTokens`). */
export function withinTokens(text: string, max: number): string {
  if (estimateTokens(text) <= max) return text;
  let out = '';
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
    if (other + Math.ceil(ascii / 4) > max) break;
    out += ch;
  }
  return out;
}

/** A player's journal for their narrations on `day`, cut to the ADR budget (Q-153). */
export function narrationJournal(db: DbOrTx, memberId: string, day: number): NonNullable<NarrationContext['journal']> {
  const j = journalFor(db, memberId, day);
  return {
    saga: j.saga === null ? null : withinTokens(j.saga, JOURNAL_BUDGET.saga),
    yesterday: j.yesterday === null ? null : withinTokens(j.yesterday, JOURNAL_BUDGET.yesterday),
  };
}

/** Saga + yesterday's recap + today's turn log (newest kept within `TODAY_LOG_TOKENS`). */
export function memoryContext(db: DbOrTx, gameId: string, at: { day: number; phase: Phase; turn: Turn }): TurnContext['memory'] {
  const memory = memoryFor(db, gameId, at.day);
  const today: string[] = [];
  let used = 0;
  for (const line of [...dayLog(db, gameId, at.day, at)].reverse()) {
    const cost = estimateTokens(line);
    if (used + cost > TODAY_LOG_TOKENS) break;
    used += cost;
    today.unshift(line);
  }
  return { saga: memory.saga, yesterday: memory.yesterday, today };
}

// --- narrate_place / narrate_player ---

/** ISK-009 `arrival`: a player came to this place this turn (`arrival:<ref>`). */
export type BeatKind = 'own_action' | 'affected' | 'public_action' | 'event' | 'evidence' | 'arrival';

/** ISK-009: what a player who has just come to a place sees around them (the crossing's end, an arrival beat). */
export interface Arrival {
  /** `description`: the Location sheet's Characteristics, cut short. */
  place: { id: string; name: string; description: string };
  phase: Phase;
  weather: string | null;
  /** By alias, never a real name (Q-045). */
  npcs: { id: string; alias: string }[];
  /** Refs of the other players there. */
  players: string[];
}

export interface Beat {
  /** The action the beat is about (`event:<id>` for a timeline event, `evidence:<id>` for found evidence). */
  actionId: string;
  kind: BeatKind;
  /** Player ref of who did it; null = unknown to this audience or nobody. */
  actor: string | null;
  /** Tokens only. */
  text: string;
  /** `crit` | `success` | `fail` | `fumble` | `no_target` | `skipped` | `scene`. */
  result: string;
  target: string | null;
  /** GEN-110: the scenario NPC the action is aimed at (talking to them directly = a key moment); null = none. */
  targetNpc: string | null;
  moved: { from: string; to: string } | null;
  items: string[];
}

export interface NarrationContext {
  kind: 'gm_narration';
  audience: { place: string } | { player: string };
  turn: { day: number; phase: Phase; turn: Turn };
  place: { id: string; name: string };
  /**
   * The only players the text may name, as {{p:ref}}. `self`: the reader of a private narration. `looks` = how the
   * player looks, only for someone the reader looked at (GEN-117; '' = do not describe them, a place feed has none);
   * `title` = the alias (Title Mask) NPCs and strangers know them by; `karmaBand` -2..+2 (GEN-110: how NPCs treat them, never the number).
   */
  cast: { ref: string; looks: string; title: string; self: boolean; karmaBand: number }[];
  /**
   * The NPCs of the place (tokens may name any of them). `here`: at the place now by NPC_Schedule + period + weather (GEN-110), or with no schedule row now at its scenario place (GEN-137):
   * only these may speak (`npcLines`). `persona`: the sheet's personality (only when `here`), names as tokens;
   * `bonds`: each cast player's affinity (-/+) and whether they have met. `lingering` (GEN-144): here past its schedule
   * because someone was talking to it. `memories` (GEN-146, only when `here` and it has some): what the NPC remembers
   * of that player, newest first, tokens only. GEN-193 (only when `here`): `form` = the form the cast sees it in (null =
   * normal; left out when they see different ones), `voice` = its speech profile in that form (the main one when mixed).
   */
  npcs: {
    id: string;
    alias: string;
    grade: string;
    here: boolean;
    lingering: boolean;
    persona: string | null;
    form?: VoiceForm | null | undefined;
    voice?: Omit<NpcSpeech, 'neverWords'>;
    bonds: { player: string; affinity: number; met: boolean; memories?: string[] }[];
  }[];
  /**
   * GEN-143: the NPCs here who answer beats (asked, talked to, requested): `via` target = the beat aims at it (targetNpc),
   * partner = no target, and it is who the place was talking to last turn (GEN-144). Its own lines are the answer.
   */
  answers: { npcId: string; actionIds: string[]; via: 'target' | 'partner' }[];
  /** GEN-110: private NPC lines (`npcLines` of a player narration) are kept only when this is true: the reader's own action is Secret. */
  privateLines: boolean;
  /** In the server's order; write one or more segments for each, in the same order. */
  beats: Beat[];
  /** The reader's own journal (Q-153), for a private narration only; null for a place feed. */
  journal: { saga: string | null; yesterday: string | null } | null;
  /** ISK-009: a private narration whose reader arrived somewhere this turn (its beat is the last one). */
  arrival?: Arrival;
}

/** GEN-116: what the dialogue stage is given for one audience: its narration context (no journal) and the narration it follows. */
export interface DialogueContext extends Omit<NarrationContext, 'kind' | 'journal'> {
  kind: 'gm_dialogue';
  /** The narration the players already read, tokens only. */
  narration: string[];
  /** What the server will keep (the game's level): the AI should not write more. */
  limits: { dialoguePerNpc: number; reactionNpcs: number; privatePerPlayer: number };
}

/** `summarize_journal` (ADR §6.3, Q-153): one player's day from the entries that player received. */
export interface JournalContext {
  kind: 'gm_journal';
  day: number;
  /** The player's ref; their own entries say "คุณ" for them. */
  player: string;
  /** Their saga through the day before. */
  saga: string | null;
  /** What reached this player that day (feed + private narration), oldest first, tokens only. */
  seen: string[];
}

export interface DayContext {
  kind: 'gm_day';
  day: number;
  saga: string | null;
  log: string[];
  /** ISK-014: what tomorrow's morning news may draw on (events by name + public description only). */
  news: NewsSources;
}

// --- Prompts (static, cacheable) ---

export { THAI_OUTPUT };
/** GEN-164: the user message of a repair / a style rewrite (the errors or style issues go with it as JSON). */
export const REPAIR_INSTRUCTION = 'Fix every error, then answer again with the whole object in the same format.';
export const STYLE_REWRITE_INSTRUCTION = 'Rewrite the wording as each fix says, then answer again with the whole object in the same format.';

const RULES_TEXT = [
  'You are the Game Master of Isekai Chronicles: a Strict Referee, not the players\' assistant.',
  '1. No plot armour: never lower a DC or add a modifier to help a player. Difficulty comes only from the real situation in the state.',
  '2. Answer every action in the given `order`: never skip one, never change the order, never invent an actionId. `actor` is the ref of who acts. Every id in order must always have exactly 1 entry in actions, even when it has no mechanical effect / is vague / has no clear target / is impossible (answer kind general, staminaCost 3, check none, leave onSuccess / onFail out (their defaults are 0 / null) and explain in reason). The number of actions must equal the number of ids in order.',
  '3. DC is on the ladder 5, 8, 11, 14, 17, 20, 23 / staminaCost is fixed by kind and opposed, never 0: general = 3 (opposed is always false), complex = 5, complex with opposed true = 6, exertion = 7-10',
  // GEN-164: in English the AI mixed `tags` up with verbTags (a schema mismatch every few turns).
  `3b. tags = at most 2 of exactly these words: ${ACTION_TAGS.join(', ')} ([] when none fits). They are not tagVocabulary words`,
  '4. verbTags / targetTags may only use words of tagVocabulary, spelled exactly; never invent a word, answer [] when none fits / activate may only name the actor\'s tagSources whose trigger is active or both and whose dailyLimit is not used up (a source with trigger = passive works by itself: never put it in activate)',
  '5. A player under constraints (Constraint Lock) stays locked until you release it in constraints.release with a reason saying why it ends',
  '6. You do not know the dice: propose an onSuccess and an onFail that both make sense. Never set new HP / Stamina values yourself',
  '7. Never write a character\'s real name: use only the given {{p:ref}} / {{n:id}}',
  // Q-180
  '8. An action\'s skillFlags / grants apply to the actor only when that action succeeds: skillFlags = unlock conditions that really happened this turn, only names from this list: ' +
    [...SKILL_FLAGS].join(', ') +
    ' / grants = give a skill whose conditions are met, or a skill / item among the rewards an NPC (npcId) has opened to this player; an item always needs its npcId. Otherwise leave them empty',
  // GEN-070
  '10. A player at hp 0 is unconscious: they can only be the target of targetPlayer.intent steal / execute / rescue; execute works only on an unconscious player, success = permanent death (Astral Spirit) / a player recovering at a hospital can be attacked or robbed but not executed',
  // GEN-117
  '12. looksAt: only the refs of players the action really means to look at / watch / talk to (besides targetPlayer). Answer [] when it looks at nobody (walking around / looking round a room in general does not count: it must fix on that person). A player only learns the looks of whom they look at',
  // GEN-170 (Q-320 B)
  '14. introducedNpcs: only ids of NPCs at the place who say their own name in that action\'s scene (introduce themselves). Whoever hears it learns that NPC\'s real name. Answer [] when nobody introduces themselves',
  // GEN-188
  '15. targetNpc: only an NPC at the actor\'s place for that actor: npcs[].placeFor[actor] when it has the actor, else npcs[].place',
  '9. endingPath: only while an event of kind finale (Judgement Day, day 12) is active. When the players complete a path this turn, answer good (the miracle veil turns the meteor aside) / evil (absorb the meteor\'s power) / neutral (with the event\'s NPCs, cancel it out to zero) by that event\'s interventionEffects, also weighing the results of days 1, 5, 7, 10 in past. Otherwise answer null',
  // GEN-093 (Q-203)
  '10. An action\'s strategy: only while an event with strategies (the night of day 10) is active. When the action is part of a plan, answer the plan id from the event\'s strategies (never D10-DRIFT) and role = leader (the one whose roll decides the plan) or support (a helper). Success comes from that action\'s dice. Otherwise answer null',
  // GEN-118: the answer is mostly the time of the turn (about 175 tokens / s), so the free texts are short.
  '13. Keep it short: intentSummary at most 40 characters / reason at most 80 characters (one sentence) / remember [] unless something really matters / no text outside the JSON',
  '11. eventOutcomes.side: the side of the event\'s interventionEffects the players took: good / evil / neutral (for a combined interventionEffects such as Good/Neutral pick the one side that matches what the players did); null when none fits / eventOutcomes.outcome says only what happened, never starting with the side\'s name',
  `${THAI_OUTPUT} The free texts (intentSummary, reason, constraints, remember, eventOutcomes.outcome) are Thai too.`,
].join('\n');

const FINALE_TEXT = [
  'You tell the ending for the Game Master. The game is over; the ending in the context is decided: never change it (the path, each player\'s outcome).',
  'overall = the ending of the whole town, read by everyone together: tell the result of path from all the events in events / players = a personal ending for every player in the context, 1 entry each, by their outcome (survived / defeated), karma band, companions and what protected them',
  'path: good = the miracle veil turns the meteor aside and protects the town / evil = the meteor\'s power is absorbed to rule the world (the good-side players are defeated) / neutral = with the finale event\'s NPCs the meteor is cancelled out to zero / none = the meteor hits the town (reason game_over = everyone fell before Judgement Day)',
  'Always use {{p:ref}} / {{n:id}} for names, never a real name, never a karma number',
  THAI_OUTPUT,
].join('\n');
export const FINALE_BLOCK: PromptBlock = { id: 'finale-rules', text: FINALE_TEXT, cache: true };

/** ISK-026: a good action result of `NARRATION_RULES`, in the Thai the AI writes (one only: the rule may add ≤ 200 tokens). */
export const NARRATION_EXAMPLES = ['ทหารยามชี้ไปทางโบสถ์อย่างห้วนๆ แดดเที่ยงแผดลานค่ายจนต้องหรี่ตา'] as const;

/** ISK-026 (Nok 2026-11-23): how each action's result (one segment) reads, in a player's narration and a place feed alike. */
export const NARRATION_RULES = [
  "Each segment = one action's result: 1-2 sentences, at most 120 characters (aim for 60-100), with all 4: the world / people here react; what the actor feels, through the body or what they see (hands shake, eyes squint; never decide or feel for a player beyond their action); personality by the game's tone and the NPCs involved; one real detail of here and now (place, period, people; never invent one)",
  `Good (asking the way, noon at the barracks): ${NARRATION_EXAMPLES[0]}`,
].join('\n');

const NARRATOR_TEXT = [
  'You are the Game Master\'s narrator. Tell only the given beats, in order; every beat needs at least 1 segment whose actionId matches the beat',
  'Never tell anything that is not in the beats, never mention anyone not in the cast. Always use {{p:ref}} / {{n:id}} for names, never a real name; {{n:id}} only for ids in npcs (a place is never a token: write its name)',
  'audience place = everyone there reads it together / audience player = one reader alone (self = the reader)',
  // ISK-008: the server shows each reader their own token as คุณ, so a look written in its place reads wrong to them.
  'Every player is always their {{p:ref}} token, the reader too (they see it as คุณ): never their looks or title in place of the token; looks only describe, beside the token',
  // GEN-117
  'A cast member whose looks is empty = the reader did not look at them: never describe their body, face, hair, skin or clothes; only say someone is there and what they do (by token) / describe looks only for cast with a looks value, and as the beat\'s result allows',
  // GEN-116: NPC lines are a separate second stage (DIALOGUE_TEXT); here only the segments, no NPC lines.
  'Never put NPC lines in segments (a separate stage writes them later): tell only the results of the beats',
  // GEN-144
  'npcs with lingering true = still here because they are talking with a player (past the time they would normally leave): you may tell that they are still there',
  // GEN-146
  'bonds.memories = what the NPC remembers about that player (newest first): let it shape the NPC\'s manner and expression toward the player; never tell a memory as a new beat',
  // GEN-143
  'answers = NPCs who will answer the beats that ask / talk / request (actionIds) with their own lines in the dialogue stage: in that beat\'s segments tell only gestures, expressions and mood; never sum up the answer or say what the NPC answers for them',
  // ISK-026
  NARRATION_RULES,
  // ISK-009. ISK-026: the reader's own arrival is the `arrival` field, so the 120 of a segment never cuts it.
  'A beat of kind arrival: that player has just come here. Audience player: write it in arrival, never as a segment: 2-3 sentences of arrival.place as it looks now (arrival.phase, arrival.weather, its description; never what it hides) and who is here (arrival.npcs as {{n:id}}, arrival.players as {{p:ref}}; these may be named too)',
  THAI_OUTPUT,
].join('\n');

/** ISK-025: the two good replies of `NPC_SPEECH_RULES`, in the Thai the AI writes (the only Thai of those blocks besides "รู้สึก"). */
export const NPC_SPEECH_EXAMPLES = [
  'รับขนมปังอย่างลังเล "น้ำพุเช้านี้เย็นจัด ของอุ่นๆ ไม่ได้กินนานแล้ว"',
  'หัวเราะแห้งๆ หลังชิดกำแพงชื้น "ตรอกมืดขนาดนี้ ขู่ไปก็ไม่มีพยานหรอก"',
] as const;

/** ISK-025 (Nok 2026-11-23): how every NPC reply reads, in the NPC chat and the turn's NPC lines alike. */
export const NPC_SPEECH_RULES = [
  'NPC reply / line: 1-2 sentences, at most 120 characters, with all 4: persona + voice; feeling now by tone or gesture (never "รู้สึก"); reaction to what the player just said / did; one real detail of here and now from the scene (place, period, weather, people; never invent one)',
  `Good (bread, morning fountain): ${NPC_SPEECH_EXAMPLES[0]}`,
  `Good (threat, night alley): ${NPC_SPEECH_EXAMPLES[1]}`,
].join('\n');

/** GEN-116: the second stage. Same rules as GEN-110 had inside the narration; the narration is given so the lines follow it. */
const DIALOGUE_TEXT = [
  'You write the NPC lines for the Game Master. The players have already read the turn\'s results and the narration: write only the NPC lines that follow it, never retell it',
  'npcLines = lines of the NPCs here now (only npcs of the context with here true; npcId must match). [] is always fine, they need not speak every turn; the maximums are in limits',
  '- audience place (everyone reads together): kind dialogue = the NPC talks about what the beat did / to whoever did it, at most limits.dialoguePerNpc lines from one NPC (the NPC the beat aims at with targetNpc) / kind reaction = other NPCs there react, 1 line each, at most limits.reactionNpcs NPCs',
  '- audience player (one reader alone): npcLines only when privateLines is true (the reader\'s action is Secret): what an NPC says to the reader alone, at most limits.privatePerPlayer lines; otherwise always [] (lines in front of everyone are already in audience place: never repeat them)',
  // GEN-143
  '- answers: every NPC in answers must be the main answerer (at least 1 kind dialogue line), answering what the beats of actionIds really ask / request (the narration did not answer for them) / via partner = the earlier conversation partner: answers when that action talks / asks without saying to whom / several players asking the same NPC = one conversation, answered together in one set, at most limits.dialoguePerNpc × the number of actionIds',
  '- Key moments (a beat with targetNpc, a player meeting the NPC for the first time = bonds met false, or a beat of kind event): speak more. An ordinary turn: little, 0-2 lines',
  NPC_SPEECH_RULES,
  '- Manner toward the player by bonds (high affinity = friendly, low = wary), karmaBand (-2 cruel .. +2 kind) and the player\'s looks / title (an NPC knows a player only by these: never call them by a real name)',
  // GEN-193
  '- voice = how that NPC speaks now (its current form): self = what it calls itself ([] = it drops the subject), you = what it calls the player, particles, register, catchphrases, never = what it never says. Keep to it',
  // GEN-146
  '- bonds.memories = what that NPC remembers about that player (newest first): speak and behave in keeping with it, mention it when it fits the scene, not every memory',
  '- Never reveal a secret, a real name or karma as a number, never mention what is not in the beats / never tell others about a Secret action. Use {{p:ref}} / {{n:id}} for names, never HP / karma / grade',
  THAI_OUTPUT,
].join('\n');

// GEN-164: with English instructions the recap / saga ran past the 1,500 output tokens; the caps keep it as long as before.
const SUMMARY_TEXT = `Summarise the day that just ended for the Game Master: recap = what mattered today, at most 400 characters / saga = the whole story up to today, the old saga folded together with today, at most 900 characters (when full, shorten the older days). news = tomorrow morning's town news that every player reads alike, 1-3 short items (each at most 160 characters, all together at most 300): from news.starting (events that begin tomorrow) and news.yesterday (today's events) by their title and description, plus what happened today in plain view of the town; when nothing new, one rumour or a line on the town's mood. Never an outcome or what will happen, a private clue, a secret or a Secret action; people only as tokens (they are shown by their alias). Always use tokens for names. Log lines marked [Secret] and clues a player found privately never appear in recap, saga or news, neither the deed nor the objects / places it names. ${THAI_OUTPUT}`;

export const RULES_BLOCK: PromptBlock = { id: 'rules', text: RULES_TEXT, cache: true };
export const NARRATOR_BLOCK: PromptBlock = { id: 'narrator-rules', text: NARRATOR_TEXT, cache: true };
export const DIALOGUE_BLOCK: PromptBlock = { id: 'dialogue-rules', text: DIALOGUE_TEXT, cache: true };
export const SUMMARY_BLOCK: PromptBlock = { id: 'summary-rules', text: SUMMARY_TEXT, cache: true };

const JOURNAL_TEXT =
  'Summarise one player\'s personal journal from seen (only what this player saw and learned that day): journal = what mattered today from their point of view, at most 300 characters / saga = the old saga folded together with today, at most 900 characters (when full, shorten the older days and keep only what matters). Never add anything that is not in seen. Always use tokens for names, never HP / karma numbers. ' +
  THAI_OUTPUT;
export const JOURNAL_BLOCK: PromptBlock = { id: 'journal-rules', text: JOURNAL_TEXT, cache: true };

/** Tokens of a whole request (system + messages). */
export function requestTokens(system: readonly PromptBlock[], messages: readonly { text: string }[]): number {
  return estimateTokens([...system.map((b) => b.text), ...messages.map((m) => m.text)].join('\n'));
}

const sheetRow = (o: StoredOption, assets: GameAssets | undefined) => (o.kind === 'skill' ? assets?.ability(o.name) : assets?.item(o.name));

/** The tier the AI GM sees: an old GEN-048 option keeps "Common", a sheet row its Rank (GEN-055: B / A / S / SS). */
function optionTier(o: StoredOption, assets: GameAssets | undefined): string {
  if (isLegacyOption(o)) return o.tier;
  return `Rank ${sheetRow(o, assets)?.rank ?? o.rank ?? '?'}`;
}

/**
 * GEN-055: what the server does not compute (the qualitative half), as text the AI judges within the Rank cap:
 * the Ability Description / Item Effect, the item's skill-boost half of Skill Synergy, and the Note.
 * Never the unlock condition.
 */
function qualitativeText(o: StoredOption, assets: GameAssets | undefined): string {
  const row = sheetRow(o, assets);
  if (!row) return o.description;
  const boost = 'synergy' in row ? (/เสริมสกิล:\s*([^/]*)/.exec(row.synergy)?.[1]?.trim() ?? '') : '';
  const text = 'effect' in row ? forAi(row.effect, row.effectEn) : forAi(row.description, row.descriptionEn);
  return [text, boost && `เสริมสกิล: ${boost}`, row.note].filter((s) => s.length > 0).join(' / ');
}

/** GEN-095: the sheet text of the row a curse came from (an Ability Description / Item Effect). */
function curseText(source: string | undefined, assets: GameAssets | undefined): string {
  if (source === undefined || assets === undefined) return '';
  const ability = assets.ability(source);
  if (ability) return forAi(ability.description, ability.descriptionEn);
  const item = assets.items.find((i) => i.nameEn === source);
  return item ? forAi(item.effect, item.effectEn) : '';
}

/** The weather as the AI GM reads it (GEN-068): the period's weather plus the day-5 Disaster state. */
function weatherLabel(w: PeriodWeather): string {
  return w.disaster ? `${w.weather} + Disaster` : w.weather;
}
