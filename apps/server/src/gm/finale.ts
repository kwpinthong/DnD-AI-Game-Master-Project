import type { EndingPath, Phase, PlayerEndingOutcome } from '@isekai/protocol';
import { karmaBand, karmaTitle } from '@isekai/rules';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, npcBond } from '../db/schema.ts';
import { getEnding, protectionsOf, strategyRefuges } from '../finale/store.ts';
import type { ResolutionEntry } from '../room/resolver.ts';
import { getGameScenario } from '../scenario/store.ts';
import { isSafeZone } from '../skills/progress.ts';
import { getEventOutcomes } from '../timeline/store.ts';
import type { GmError } from './check.ts';
import { TOKEN_PATTERN, loadWorld, stripStrayTokens, npcToken, playerToken, type GmWorld } from './context.ts';
import type { GmFinale } from './schema.ts';

/**
 * The ending as the AI GM tells it (GEN-059): `finale` purpose, once the game ended. Same token rules as
 * every other GM request (Q-045): players are `{{p:ref}}`, NPCs `{{n:id}}`, no real name, karma as the tier
 * word and band only. Who survives is already decided by the server (`finale/ending.ts`); the AI only
 * narrates it.
 */
export interface FinaleContext {
  kind: 'gm_finale';
  reason: 'finale' | 'game_over';
  path: EndingPath;
  /** Every scenario event in play order with its final outcome (d1 / d5 / d7 / d10 / d12); `side` (Q-243): which side the players' outcome was, null = none. */
  events: { id: string; day: number; phase: Phase; kind: string; title: string; outcome: string; intervened: boolean; side: 'good' | 'evil' | 'neutral' | null }[];
  players: {
    ref: string;
    appearance: string;
    place: string;
    karmaTier: string;
    karmaBand: number;
    /** Companion NPCs as tokens, main first. */
    companions: string[];
    outcome: PlayerEndingOutcome;
    /** S / SS protection the player holds (names from the game data). */
    protectedBy: string[];
    inSafeZone: boolean;
  }[];
}

/** Companion NPC ids of a player, main (highest affinity, tie = saved first) first. */
export function companionIdsOf(db: DbOrTx, memberId: string): string[] {
  return db
    .select({ npcId: npcBond.npcId })
    .from(npcBond)
    .where(and(eq(npcBond.memberId, memberId), isNotNull(npcBond.companionSeq)))
    .orderBy(desc(npcBond.affinity), asc(npcBond.companionSeq))
    .all()
    .map((r) => r.npcId);
}

/** The finale context of an ended game; null when the game has no stored ending yet. */
export function buildFinaleContext(db: DbOrTx, assets: GameAssets, gameId: string): FinaleContext | null {
  const ending = getEnding(db, gameId);
  if (!ending) return null;
  const world = loadWorld(db, gameId, assets);
  const scenario = getGameScenario(db, gameId);
  const titles = new Map((scenario?.timeline ?? []).map((e) => [e.id, e.title]));
  const placeName = new Map(world.places.map((p) => [p.id, p.name]));
  const refuges = strategyRefuges(db, assets, gameId);
  const players = Object.entries(ending.outcomes).flatMap(([memberId, outcome]) => {
    const p = world.players.get(memberId);
    if (!p) return [];
    const karma = db.select({ karma: character.karma }).from(character).where(eq(character.memberId, memberId)).get()?.karma ?? 0;
    return [
      {
        ref: p.ref,
        appearance: world.tokenise(p.appearance),
        place: placeName.get(p.locationId) ?? p.locationId,
        karmaTier: karmaTitle(karma, assets.karmaTiers),
        karmaBand: karmaBand(karma),
        companions: companionIdsOf(db, memberId).map(npcToken),
        outcome,
        protectedBy: [...protectionsOf(db, assets, gameId, memberId), ...(refuges.buffs.get(memberId) ?? [])],
        inSafeZone: isSafeZone(db, assets, gameId, p.locationId) || refuges.places.has(p.locationId),
      },
    ];
  });
  return {
    kind: 'gm_finale',
    reason: ending.reason,
    path: ending.path,
    events: getEventOutcomes(db, gameId).map((e) => ({
      id: e.eventId,
      day: e.day,
      phase: e.phase,
      kind: e.kind,
      title: world.tokenise(titles.get(e.eventId) ?? e.eventId),
      outcome: world.tokenise(e.outcome),
      intervened: e.intervened,
      side: e.side,
    })),
    players,
  };
}

/** Every problem of an answer (Q-049): each player once, known tokens only, no real name. */
export function checkFinale(ctx: FinaleContext, out: GmFinale, forbiddenNames: readonly string[], npcIds: ReadonlySet<string>): GmError[] {
  const errors: GmError[] = [];
  const refs = new Set(ctx.players.map((p) => p.ref));
  const seen = new Set<string>();
  out.players.forEach((p, i) => {
    if (!refs.has(p.player)) errors.push({ code: 'unknown_ref', path: `players[${i}].player`, message: `${p.player} is not a player of this game` });
    else if (seen.has(p.player)) errors.push({ code: 'duplicate_player', path: `players[${i}].player`, message: `${p.player} is answered twice` });
    seen.add(p.player);
  });
  for (const ref of refs) if (!seen.has(ref)) errors.push({ code: 'missing_player', path: 'players', message: `no ending for ${ref}; answer every player once` });
  const texts = [{ path: 'overall', text: out.overall }, ...out.players.map((p, i) => ({ path: `players[${i}].text`, text: p.text }))];
  for (const { path, text } of texts) {
    for (const [, kind, id] of text.matchAll(TOKEN_PATTERN)) {
      if (kind === 'p' && !refs.has(id!)) errors.push({ code: 'unknown_token', path, message: `{{p:${id}}} is not a player of this game` });
      if (kind === 'n' && !npcIds.has(id!)) errors.push({ code: 'unknown_token', path, message: `{{n:${id}}} is not an NPC id` });
    }
    for (const name of forbiddenNames) if (name.length > 0 && text.includes(name)) errors.push({ code: 'real_name', path, message: 'use {{p:ref}} / {{n:id}} tokens, never a real name' });
  }
  return errors;
}

const PATH_TEXT: Record<EndingPath, string> = {
  good: 'ม่านปาฏิหาริย์เบี่ยงวิถีอุกกาบาตหมูเด้งออกไป เมืองรอดพ้นจากวันพิพากษา',
  evil: 'พลังของอุกกาบาตหมูเด้งถูกดูดซับไว้ ผู้ครอบครองพลังนั้นก้าวขึ้นครองโลก',
  neutral: 'แอสทราและเซเรน่าร่วมกันลบล้างผลของอุกกาบาตจนเหลือศูนย์ โลกกลับสู่ความสมดุล',
  none: 'ไม่มีใครหยุดอุกกาบาตหมูเด้งได้ มันพุ่งชนเมืองในคืนวันพิพากษา',
};

/** Q-151: the server's own ending text, from the decided ending only (when the AI answer stays wrong). */
export function templateFinale(ctx: FinaleContext): GmFinale {
  const overall = ctx.reason === 'game_over' ? 'ทุกคนล้มลงก่อนถึงวันพิพากษา ไม่มีใครเหลือยืนดูตอนจบของเมือง' : PATH_TEXT[ctx.path];
  return {
    overall,
    players: ctx.players.map((p) => ({
      player: p.ref,
      text:
        p.outcome === 'survived'
          ? `${playerToken(p.ref)} รอดชีวิตผ่านวันพิพากษา${p.protectedBy.length > 0 ? ` ด้วยพลังของ ${p.protectedBy.join(', ')}` : p.inSafeZone && ctx.path === 'none' ? ' ในจุดหลบภัย' : ''}`
          : `${playerToken(p.ref)} พ่ายแพ้ในวันพิพากษา (Bad Ending)`,
    })),
  };
}

/** After the end every secret is revealed (GEN-059): tokens become real names for everyone. */
export function revealTokens(world: GmWorld, text: string): string {
  return stripStrayTokens(
    text.replace(TOKEN_PATTERN, (_all, kind: string, id: string) => {
      if (kind === 'n') return world.npcs.find((n) => n.id === id)?.name ?? '';
      return world.byRef.get(id)?.name ?? '';
    }),
  );
}

/** The ending as room entries: the overall text to the whole town, one private text per player. */
export function finaleEntries(db: DbOrTx, assets: GameAssets, gameId: string, out: GmFinale): ResolutionEntry[] {
  const world = loadWorld(db, gameId, assets);
  return [
    { kind: 'feed', locationId: null, actorMemberId: null, text: revealTokens(world, out.overall) },
    ...out.players.flatMap((p) => {
      const member = world.byRef.get(p.player);
      // ISK-031: stored raw (real names); its owner reads their name as "คุณ" (room/entry-view.ts, finale/reveal.ts).
      return member ? [{ kind: 'narration' as const, memberId: member.memberId, text: revealTokens(world, p.text) }] : [];
    }),
  ];
}

/** What `checkFinale` needs of the game: real names (players and NPCs) it must not write, and the NPC ids. */
export function finaleCheckInput(db: DbOrTx, assets: GameAssets, gameId: string): { forbiddenNames: string[]; npcIds: Set<string> } {
  const world = loadWorld(db, gameId, assets);
  return {
    forbiddenNames: [...[...world.players.values()].map((p) => p.name), ...world.npcs.filter((n) => n.name !== n.alias).map((n) => n.name)].filter((n) => n.trim().length > 0),
    npcIds: new Set(world.npcs.map((n) => n.id)),
  };
}

/** The ending told by the server alone (a resolver without an AI GM finale, e.g. tests' own resolvers). */
export function templateFinaleEntries(db: DbOrTx, assets: GameAssets, gameId: string): ResolutionEntry[] {
  const ctx = buildFinaleContext(db, assets, gameId);
  return ctx ? finaleEntries(db, assets, gameId, templateFinale(ctx)) : [];
}
