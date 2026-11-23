import type { NpcDialogueLevel } from '@isekai/protocol';
import type { Period, Weather } from '@isekai/rules';
import type { GameAssets } from '../assets/load.ts';
import { sheetNpcFor } from '../companions/sheet.ts';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { npcLinger } from '../db/schema.ts';
import { npcsAt } from '../travel/rules.ts';
import { npcBondsOf } from '../visibility/store.ts';
import { containsName } from './check.ts';
import { npcToken, TOKEN_PATTERN, withinTokens, type Beat, type GmWorld, type NarrationContext } from './context.ts';
import type { GmNpcLine } from './schema.ts';

/**
 * NPC lines with a narration (GEN-110, Nok 2026-11-22): where the NPCs are, and what the server keeps of what
 * the AI GM wrote for them. The AI answers `npcLines` with a narration (`schema.ts`); the lines are checked
 * here and never cost a repair: whatever is wrong (a made-up id, an NPC that is not there, a real name, too
 * many, too long) is dropped or cut, the narration and the turn go on.
 */

/** Normal level: the GEN-110 limits. */
export const NPC_LINE_LIMITS = {
  /** Dialogue lines of one NPC (the NPC the action is about) per narration. */
  dialoguePerNpc: 3,
  /** Different NPCs that react per narration, one line each. */
  reactionNpcs: 3,
  /** Lines for one player in their private narration. */
  privatePerPlayer: 2,
  /** Characters of one line, with the "…" of a cut. */
  chars: 120,
  /** Lines of the whole turn, all narrations together. */
  total: 12,
} as const;

export type NpcLineLimits = { [K in keyof typeof NPC_LINE_LIMITS]: number };

/** GEN-116 (Nok): low = half the counts of normal (rounded up), high = double; a line is as long at every level. */
export function npcLineLimits(level: NpcDialogueLevel = 'normal'): NpcLineLimits {
  const n = NPC_LINE_LIMITS;
  if (level === 'high') return { ...n, dialoguePerNpc: n.dialoguePerNpc * 2, reactionNpcs: n.reactionNpcs * 2, privatePerPlayer: n.privatePerPlayer * 2, total: n.total * 2 };
  if (level === 'low') return { ...n, dialoguePerNpc: Math.ceil(n.dialoguePerNpc / 2), reactionNpcs: Math.ceil(n.reactionNpcs / 2), privatePerPlayer: Math.ceil(n.privatePerPlayer / 2), total: n.total / 2 };
  return n;
}

export type RawLine = GmNpcLine;
export type CleanLine = GmNpcLine;

// --- Who is where ---

export interface PresenceNow {
  phase: Period;
  weather: Weather | null;
  /** Karma of the players the narration is for: a schedule row with a karma condition holds for any of them. */
  karmas: readonly number[];
  /** GEN-144: the NPCs lingering this turn (`lingerNow`): each is at its linger place only, whatever the schedule says. */
  lingering?: readonly Linger[];
}

/**
 * The NPCs at `placeId` now (GEN-137, Q-300): where a NPC_Schedule row puts it at this period, weather and karma
 * (Q-092); with no such row anywhere now, at its scenario place. A row that puts it elsewhere now keeps it away.
 */
export function npcsPresentAt(world: GmWorld, assets: GameAssets, placeId: string, now: PresenceNow): GmWorld['npcs'] {
  const schedule = assets.npcSchedule ?? [];
  const placeName = world.places.find((p) => p.id === placeId)?.name;
  const karmas = now.karmas.length > 0 ? now.karmas : [0];
  const locations = [...new Set(schedule.map((r) => r.location))];
  const at = (karma: number, location: string) => npcsAt(schedule, location, { phase: now.phase, weather: now.weather, karma });
  return world.npcs.filter((n) => {
    const lingering = now.lingering?.find((l) => l.npcId === n.id);
    if (lingering) return lingering.placeId === placeId;
    return karmas.some((karma) => {
      const placed = locations.filter((loc) => n.names.some((name) => at(karma, loc).includes(name)));
      return placed.length > 0 ? placeName !== undefined && placed.includes(placeName) : n.locationId === placeId;
    });
  });
}

// --- GEN-144: the conversation partner stays a little ---

/** Turns an NPC may stay past its schedule at the place it was talked to. */
export const LINGER_TURNS = 2;

/** One NPC a turn left behind (row of `npc_linger`). */
export interface Linger {
  npcId: string;
  placeId: string;
  /** Turns already spent past its schedule (0: it was where the schedule put it). */
  used: number;
  /** Someone acted on it (targetNpc) in that turn. */
  talked: boolean;
}

/**
 * Who lingers this turn (`used` counts this turn) and who says goodbye, from what the last turn left. An NPC talked
 * to stays while it has turns left; one nobody talked to, or with none left, says goodbye and follows the schedule.
 * `scheduledAt`: whether the schedule puts the NPC at the place now anyway (then it neither lingers nor leaves).
 */
export function lingerNow(prev: readonly Linger[], scheduledAt: (npcId: string, placeId: string) => boolean): { lingering: Linger[]; farewells: Linger[] } {
  const lingering: Linger[] = [];
  const farewells: Linger[] = [];
  for (const l of prev) {
    if (scheduledAt(l.npcId, l.placeId)) continue;
    if (l.talked && l.used < LINGER_TURNS) lingering.push({ ...l, used: l.used + 1, talked: false });
    else farewells.push(l);
  }
  return { lingering, farewells };
}

/** What this turn leaves: every NPC acted on where it was (its count goes on when it was lingering there), and every lingering one nobody talked to. */
export function lingerAfter(lingering: readonly Linger[], talkedTo: readonly { npcId: string; placeId: string }[]): Linger[] {
  const talked = new Map(talkedTo.map((t) => [t.npcId, t.placeId]));
  const kept = lingering.filter((l) => !talked.has(l.npcId));
  return [
    ...[...talked].map(([npcId, placeId]) => ({ npcId, placeId, used: lingering.find((l) => l.npcId === npcId && l.placeId === placeId)?.used ?? 0, talked: true })),
    ...kept,
  ];
}

export function lingersOf(db: DbOrTx, gameId: string): Linger[] {
  return db
    .select({ npcId: npcLinger.npcId, placeId: npcLinger.locationId, used: npcLinger.used, talked: npcLinger.talked })
    .from(npcLinger)
    .where(eq(npcLinger.gameId, gameId))
    .all();
}

export function saveLingers(db: DbOrTx, gameId: string, lingers: readonly Linger[]): void {
  db.delete(npcLinger).where(eq(npcLinger.gameId, gameId)).run();
  if (lingers.length > 0) db.insert(npcLinger).values(lingers.map((l) => ({ gameId, npcId: l.npcId, locationId: l.placeId, used: l.used, talked: l.talked }))).run();
}

// --- GEN-143: who answers ---

/** Beats someone does (not events, evidence or what was done to the reader). */
const ASKING = new Set<Beat['kind']>(['own_action', 'public_action']);

/**
 * The NPCs here who answer the beats: the one a beat aims at (targetNpc), else the place's conversation partner
 * (`partner`, GEN-144). An NPC that is not here answers nothing. Several beats to one NPC = one group answer.
 */
export function npcAnswers(beats: readonly Beat[], here: ReadonlySet<string>, partner: string | null): NarrationContext['answers'] {
  const out: NarrationContext['answers'] = [];
  for (const b of beats) {
    if (!ASKING.has(b.kind)) continue;
    const npcId = b.targetNpc ?? partner;
    if (npcId === null || !here.has(npcId)) continue;
    const via = b.targetNpc === null ? 'partner' : 'target';
    const known = out.find((a) => a.npcId === npcId);
    if (known) known.actionIds.push(b.actionId);
    else out.push({ npcId, actionIds: [b.actionId], via });
  }
  return out;
}

// --- What the AI is given ---

/** The persona text of one NPC in the prompt: at most this many tokens of the sheet's Lore. */
const PERSONA_TOKENS = 150;

/**
 * The NPCs of a narration as the AI reads them (`here`: the ones `npcsPresentAt` has at the place now, the only ones that
 * may speak; the others at the scenario place may still be named): alias (never the real name), grade, personality (the sheet's Lore with
 * every real name of the NPC swapped for its token) and the bond with each player of the cast: affinity and whether
 * they have met (a row exists). `members`: the players the narration is about. `lingering`: here past the schedule (GEN-144).
 */
export function npcPrompt(db: DbOrTx, assets: GameAssets, world: GmWorld, npcs: GmWorld['npcs'], here: ReadonlySet<string>, members: readonly string[], lingering: ReadonlySet<string> = new Set()): NarrationContext['npcs'] {
  const bonds = new Map(members.map((m) => [m, new Map(npcBondsOf(db, m).map((b) => [b.npcId, b.affinity]))] as const));
  return npcs.map((n) => {
    const sheet = sheetNpcFor(assets, n);
    const names = [...n.names, sheet?.realName, sheet?.evolvedName('Good'), sheet?.evolvedName('Evil'), sheet?.evolvedName('Neutral')].filter((s): s is string => !!s && s.trim().length > 0);
    const lore = here.has(n.id) ? (sheet?.record.lore ?? '') : '';
    const persona = lore.length === 0 ? null : withinTokens([...new Set(names)].sort((a, b) => b.length - a.length).reduce((t, name) => t.split(name).join(npcToken(n.id)), world.tokenise(lore)), PERSONA_TOKENS);
    return {
      id: n.id,
      alias: n.alias,
      grade: sheet?.grade ?? n.rank,
      here: here.has(n.id),
      lingering: here.has(n.id) && lingering.has(n.id),
      persona,
      bonds: members.flatMap((m) => {
        const player = world.players.get(m);
        return player ? [{ player: player.ref, affinity: bonds.get(m)!.get(n.id) ?? 0, met: bonds.get(m)!.has(n.id) }] : [];
      }),
    };
  });
}

// --- What is kept ---

const WORD = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
const GRAPHEME = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('th', { granularity: 'grapheme' }) : null;
/** A Thai vowel written before its consonant (it needs the consonant after it), spaces and punctuation: never the last thing of a cut. */
const HANGING = /[เแโใไ\s,.;:!?-]+$/u;

/** End offsets (UTF-16) of every segment of `text`, the safe places to cut. */
function boundaries(segmenter: Intl.Segmenter | null, text: string): number[] {
  if (!segmenter) return [...text].map((_, i) => i + 1);
  return [...segmenter.segment(text)].map((s) => s.index + s.segment.length);
}

/**
 * One line of at most `max` characters: whitespace tidied, and when it is longer, cut at the last word end that
 * fits (Thai has no spaces: the ICU Thai word list decides) with "…". Never cuts inside a syllable or a
 * grapheme, and never ends on a vowel written before its consonant.
 */
export function cutLine(text: string, max: number = NPC_LINE_LIMITS.chars): string {
  const t = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const room = max - 1;
  const fit = (ends: number[]) => ends.filter((e) => e <= room).at(-1) ?? 0;
  // A word cut that loses more than half the line is worse than a grapheme cut.
  let end = fit(boundaries(WORD, t));
  if (end < room / 2) end = Math.max(end, fit(boundaries(GRAPHEME, t)));
  const body = t.slice(0, end).replace(HANGING, '');
  return body.length === 0 ? '' : `${body}…`;
}

export interface CleanOptions {
  /** NPC ids at the place (what the AI was given). */
  present: ReadonlySet<string>;
  /** `public`: the place feed (dialogue + reactions). `private`: one player's narration. */
  audience: 'public' | 'private';
  /** Real names a reader of these lines does not know. */
  forbidden: readonly string[];
  /** Player refs the lines may name as {{p:ref}}. */
  cast: ReadonlySet<string>;
  /** GEN-116: the game's level; default normal. */
  level?: NpcDialogueLevel;
  /** GEN-143: how many actions each answering NPC answers at once (a group talk): its dialogue cap times that. */
  askers?: ReadonlyMap<string, number>;
}

/** The lines of one narration the server keeps: ids, names and tokens checked, text cut, limits applied (C3, C5, C7). */
export function cleanNpcLines(raw: readonly RawLine[], opt: CleanOptions): CleanLine[] {
  const limits = npcLineLimits(opt.level);
  const ok = raw.flatMap((l): CleanLine[] => {
    if (!opt.present.has(l.npcId)) return [];
    const text = cutLine(l.text);
    if (text.length === 0) return [];
    for (const [, kind, id] of text.matchAll(TOKEN_PATTERN)) {
      if (kind === 'p' ? !opt.cast.has(id!) : !opt.present.has(id!)) return [];
    }
    if (opt.forbidden.some((name) => containsName(text, name))) return [];
    return [{ npcId: l.npcId, kind: l.kind, text }];
  });
  if (opt.audience === 'private') return ok.slice(0, limits.privatePerPlayer);

  const spoke = new Set(ok.filter((l) => l.kind === 'dialogue').map((l) => l.npcId));
  const said = new Map<string, number>();
  const reacted = new Set<string>();
  return ok.filter((l) => {
    if (l.kind === 'dialogue') {
      const n = said.get(l.npcId) ?? 0;
      said.set(l.npcId, n + 1);
      return n < limits.dialoguePerNpc * Math.max(1, opt.askers?.get(l.npcId) ?? 1);
    }
    if (spoke.has(l.npcId) || reacted.has(l.npcId) || reacted.size >= limits.reactionNpcs) return false;
    reacted.add(l.npcId);
    return true;
  });
}

/** The first `total` lines of the turn (of the game's level), in publish order. */
export function capTotal<T>(lines: readonly T[], level?: NpcDialogueLevel): T[] {
  return lines.slice(0, npcLineLimits(level).total);
}
