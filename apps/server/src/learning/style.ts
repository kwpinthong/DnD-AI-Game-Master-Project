import type { JoinStyleFields, PlayerStyleView } from '@isekai/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { createHmac, randomBytes } from 'node:crypto';
import type { DbOrTx } from '../db/client.ts';
import { appMeta, characterPresence, game, learningEntry, memberStyle, playerStylePref } from '../db/schema.ts';
import { activeMembers } from '../game/service.ts';
import { playerToken } from '../gm/context.ts';
import { gameEnded, rulingsOf } from '../rating/store.ts';
import { actionTags } from './tags.ts';

/**
 * GEN-082 (ADR "Learning Across Games" §4, Q-167): a player's style across games. The player code the player sets
 * when joining is kept only as `player_key` = HMAC-SHA256(secret, normalised code), so the same code links games
 * (an index lookup) while the code itself is never stored, logged or sent back. The secret is LEARNING_KEY_SECRET,
 * else a random one made once and kept in app_meta. One `style` entry per member of an ended game (no score gate),
 * from the actions the end page reveals; the profile sums them.
 */

const SECRET_KEY = 'learning_key_secret';
const TOP_VERBS = 3;

function secretOf(db: DbOrTx): string {
  const fromEnv = process.env.LEARNING_KEY_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const row = db.select().from(appMeta).where(eq(appMeta.key, SECRET_KEY)).get();
  if (row) return row.value;
  db.insert(appMeta).values({ key: SECRET_KEY, value: randomBytes(32).toString('hex') }).onConflictDoNothing().run();
  return db.select().from(appMeta).where(eq(appMeta.key, SECRET_KEY)).get()!.value;
}

/** "ab12-cd34" and "AB12CD34" are one code (upper case, no spaces or dashes). Empty → null. */
export function playerKeyOf(db: DbOrTx, code: string): string | null {
  const normal = code.normalize('NFC').toUpperCase().replace(/[\s-]/g, '');
  return normal === '' ? null : createHmac('sha256', secretOf(db)).update(normal).digest('hex');
}

/** The join form's fields for this member (a rejoin with a code or the tick updates them). */
export function saveJoinStyle(db: DbOrTx, who: { id: string; gameId: string }, fields: JoinStyleFields, now: number): void {
  const playerCode = fields.playerCode?.trim() ?? '';
  const optOut = fields.noStyle ?? false;
  if (playerCode === '' && !optOut) return;
  const existing = db.select().from(memberStyle).where(eq(memberStyle.memberId, who.id)).get();
  const playerKey = playerCode === '' ? (existing?.playerKey ?? null) : playerKeyOf(db, playerCode);
  db.insert(memberStyle)
    .values({ memberId: who.id, gameId: who.gameId, playerKey, optOut, updatedAt: now })
    .onConflictDoUpdate({ target: memberStyle.memberId, set: { playerKey, optOut, updatedAt: now } })
    .run();
}

/** The code was used to join at least once, or has a setting. */
export const knownKey = (db: DbOrTx, key: string) =>
  db.select({ k: memberStyle.playerKey }).from(memberStyle).where(eq(memberStyle.playerKey, key)).get() !== undefined ||
  db.select().from(playerStylePref).where(eq(playerStylePref.playerKey, key)).get() !== undefined;

export const optedOut = (db: DbOrTx, key: string) => db.select().from(playerStylePref).where(eq(playerStylePref.playerKey, key)).get()?.optOut ?? false;

export function setOptOut(db: DbOrTx, key: string, optOut: boolean, now: number): void {
  db.insert(playerStylePref).values({ playerKey: key, optOut, updatedAt: now }).onConflictDoUpdate({ target: playerStylePref.playerKey, set: { optOut, updatedAt: now } }).run();
}

interface StyleDetail {
  playerKey: string;
  verbCounts: Record<string, number>;
  actions: number;
  secret: number;
}

const byKey = (key: string) => and(eq(learningEntry.type, 'style'), sql`json_extract(${learningEntry.detail}, '$.playerKey') = ${key}`);

function toneLine(verbs: readonly string[], secretShare: number, actions: number, games: number): string {
  const tone = secretShare >= 0.5 ? 'มักลงมือแบบลับ' : secretShare > 0 ? 'ส่วนใหญ่ลงมือเปิดเผย มีลับบ้าง' : 'ลงมือเปิดเผยเสมอ';
  return `${tone} ถนัด ${verbs.length > 0 ? verbs.join(' / ') : 'หลายแบบ'} (จาก ${actions} การกระทำใน ${games} เกม)`;
}

/** Stores the style of every player of the ended game who joined with a code and did not opt out (once per member). */
export function buildStyles(db: DbOrTx, gameId: string, now: number): void {
  if (!gameEnded(db, gameId)) return;
  const tags = actionTags(db, gameId);
  const name = db.select({ name: game.name }).from(game).where(eq(game.id, gameId)).get()?.name ?? '';
  // The actions the end page reveals: a removed player's are not among them (C3).
  const rulings = rulingsOf(db, gameId);
  for (const m of activeMembers(db, gameId).filter((x) => x.role === 'player')) {
    const style = db.select().from(memberStyle).where(eq(memberStyle.memberId, m.id)).get();
    if (!style?.playerKey || style.optOut || optedOut(db, style.playerKey)) continue;
    const mine = rulings.filter((r) => r.memberId === m.id);
    if (mine.length === 0) continue;
    const verbCounts: Record<string, number> = {};
    for (const r of mine) for (const v of new Set(tags.get(r.sourceRef)?.verbs ?? [])) verbCounts[v] = (verbCounts[v] ?? 0) + 1;
    const secret = mine.filter((r) => r.visibility === 'secret').length;
    const top = topVerbs(verbCounts).map((v) => v.verb);
    const detail: StyleDetail = { playerKey: style.playerKey, verbCounts, actions: mine.length, secret };
    db.insert(learningEntry)
      .values({ type: 'style', sourceGameId: gameId, sourceGameName: name, sourceScore: null, sourceRef: `member-${m.id}`, content: toneLine(top, secret / mine.length, mine.length, 1), tags: JSON.stringify(top), detail: JSON.stringify(detail), status: 'active', createdAt: now })
      .onConflictDoNothing()
      .run();
  }
}

function topVerbs(counts: Record<string, number>): PlayerStyleView['verbs'] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_VERBS)
    .map(([verb, count]) => ({ verb, count }));
}

/** The profile over every ended game of the code; null = nothing stored. */
export function profileOf(db: DbOrTx, key: string): PlayerStyleView | null {
  const rows = db.select().from(learningEntry).where(and(byKey(key), eq(learningEntry.status, 'active'))).all();
  if (rows.length === 0) return null;
  const counts: Record<string, number> = {};
  let actions = 0;
  let secret = 0;
  for (const r of rows) {
    const d = JSON.parse(r.detail) as StyleDetail;
    for (const [v, n] of Object.entries(d.verbCounts)) counts[v] = (counts[v] ?? 0) + n;
    actions += d.actions;
    secret += d.secret;
  }
  const verbs = topVerbs(counts);
  return { verbs, summary: toneLine(verbs.map((v) => v.verb), actions === 0 ? 0 : secret / actions, actions, rows.length) };
}

/** The player deletes their own profile (hard delete: no undo). */
export function deleteStyle(db: DbOrTx, key: string): void {
  db.delete(learningEntry).where(byKey(key)).run();
}

/**
 * For GEN-083's learning block: one line per player of this game who joined with a code, did not opt out and has a
 * profile (`{{p:ref}}` + verbs + tone); null = no such player, so the AI gets no style section.
 */
export function styleContextFor(db: DbOrTx, gameId: string): string | null {
  const lines = activeMembers(db, gameId)
    .filter((m) => m.role === 'player')
    .flatMap((m) => {
      const style = db.select().from(memberStyle).where(eq(memberStyle.memberId, m.id)).get();
      if (!style?.playerKey || style.optOut || optedOut(db, style.playerKey)) return [];
      const profile = profileOf(db, style.playerKey);
      const ref = db.select({ ref: characterPresence.ref }).from(characterPresence).where(eq(characterPresence.memberId, m.id)).get()?.ref;
      return profile && ref ? [`${playerToken(ref)}: ${profile.summary}`] : [];
    });
  return lines.length === 0 ? null : lines.join('\n');
}
