import { NPC_CHAT_DEFAULT_PER_PERIOD, NPC_CHAT_MAX_LENGTH, normalizeActionText, type ApiError, type NpcChatResponse, type NpcChatStatus } from '@isekai/protocol';
import { and, count, desc, eq, ne } from 'drizzle-orm';
import type { AiService } from '../ai/core/service.ts';
import type { GameAssets } from '../assets/load.ts';
import type { SystemRuleRecord } from '../assets/model.ts';
import { changeNpcAffinity, npcIdForRef } from '../companions/store.ts';
import type { Db } from '../db/client.ts';
import { npcChat, npcMemory } from '../db/schema.ts';
import { activeMembers, type MemberRow } from '../game/service.ts';
import { loadWorld, npcToken, playerToken } from '../gm/context.ts';
import { renderTokens } from '../gm/loop.ts';
import { dialoguePrompt } from '../gm/npc-examples.ts';
import { clampLine, cutLine, npcPrompt, npcRealNames, npcsHereNow, withVoice } from '../gm/npc-lines.ts';
import { MEMORY_LIMITS } from '../gm/npc-memory.ts';
import { gateStyle, styleIssues } from '../gm/style-check.ts';
import { gameTone, toneBlock } from '../gm/tone.ts';
import { ensurePhaseState, insertEntry, karmaOf, type RoomEntryRow } from '../room/store.ts';
import { npcBondsOf, presenceOf, presencesInGame } from '../visibility/store.ts';
import { weatherAt } from '../weather/service.ts';
import { NPC_CHAT_BLOCK, NpcChatAnswer, type NpcChatContext } from './prompt.ts';
import { closureOf } from '../admin/games.ts';

/**
 * GEN-149 (Nok 2026-11-23): a player talks to an NPC at their place outside the turn. One small-model call per message
 * (purpose `npc_chat`), a quota per player per period, and only the relationship and the NPC's memory change; the
 * other players at the place get the talk as `player` + `npc` entries (a whisper only the speaker, and the Human GM).
 */

/** Characters of a suggestion that go out (the reply: `clampLine`, ISK-025). */
const SUGGESTION_CHARS = 300;
/** Lines of the earlier talk of the pair in the prompt. */
const RECENT = 6;

/** Q-309: the System_Rules row of category "NPC Chat": its first whole number is the quota; none = the default. */
export function npcChatPerPeriod(rules: readonly Pick<SystemRuleRecord, 'category' | 'parameters'>[]): number {
  const row = rules.find((r) => r.category.trim().toLowerCase() === 'npc chat');
  const n = row ? /\d+/.exec(row.parameters)?.[0] : undefined;
  return n === undefined ? NPC_CHAT_DEFAULT_PER_PERIOD : Number(n);
}

export type ChatOutcome = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: ApiError };
const refuse = (status: number, error: ApiError): ChatOutcome => ({ ok: false, status, error });
const GM_REFUSED = refuse(403, { code: 'forbidden', message: 'GM ไม่มีตัวละคร จึงคุยกับ NPC ไม่ได้' });

type Period = { day: number; phase: (typeof npcChat.$inferSelect)['phase'] };

function usedThisPeriod(db: Db, memberId: string, at: Period): number {
  return db.select({ n: count() }).from(npcChat).where(and(eq(npcChat.memberId, memberId), eq(npcChat.day, at.day), eq(npcChat.phase, at.phase))).get()?.n ?? 0;
}

function statusOf(db: Db, assets: GameAssets, me: MemberRow, at: Period): NpcChatStatus {
  const perPeriod = npcChatPerPeriod(assets.systemRules);
  return { perPeriod, left: Math.max(0, perPeriod - usedThisPeriod(db, me.id, at)) };
}

/** GET /api/game/npc-chat. */
export function npcChatStatus(db: Db, assets: GameAssets, me: MemberRow, now: number): ChatOutcome {
  if (me.role === 'gm') return GM_REFUSED;
  return { ok: true, status: 200, body: statusOf(db, assets, me, ensurePhaseState(db, me.gameId, now)) };
}

export interface NpcChatDeps {
  db: Db;
  ai: AiService;
  assets: GameAssets;
  now: () => number;
  log: (line: string) => void;
  /** GEN-169: how long a style rewrite may take before the original goes out. */
  styleRewriteMs: number;
  /** Sends stored entries to the sockets of their recipients (the room). */
  publish: (gameId: string, rows: readonly { row: RoomEntryRow; recipients: ReadonlySet<string> }[]) => void;
}

/** POST /api/game/npc-chat: C1-C8. */
export async function sendNpcChat(deps: NpcChatDeps, me: MemberRow, input: { npc: string; text: string; whisper: boolean }): Promise<ChatOutcome> {
  const { db, ai, assets } = deps;
  if (me.role === 'gm') return GM_REFUSED;
  const text = normalizeActionText(input.text);
  if (text.length === 0) return refuse(400, { code: 'invalid_input', message: 'พิมพ์ข้อความก่อนส่ง', fields: { text: 'พิมพ์ข้อความก่อนส่ง' } });
  if ([...text].length > NPC_CHAT_MAX_LENGTH) {
    const message = `ข้อความยาวได้ไม่เกิน ${NPC_CHAT_MAX_LENGTH} ตัวอักษร`;
    return refuse(400, { code: 'invalid_input', message, fields: { text: message } });
  }

  const state = ensurePhaseState(db, me.gameId, deps.now());
  if (state.status === 'finale' || state.status === 'game_over') return refuse(409, { code: 'not_allowed', message: 'เกมจบแล้ว คุยกับ NPC ไม่ได้' });
  const condition = state.players[me.id]?.condition;
  if (condition === 'unconscious' || condition === 'recovering' || condition === 'astral_spirit') {
    return refuse(409, { code: 'not_allowed', message: 'ตอนนี้ตัวละครคุยกับใครไม่ได้' });
  }
  // C5: only an NPC at your place now (the same rule as the chips).
  const here = presenceOf(db, me.id);
  const npcId = here ? npcIdForRef(db, me.gameId, input.npc) : undefined;
  const karma = karmaOf(db, [me.id]).get(me.id) ?? 0;
  if (!here || !npcId || !npcsHereNow(db, assets, me.gameId, here.locationId, karma).some((n) => n.id === npcId)) {
    return refuse(404, { code: 'npc_not_found', message: 'NPC คนนี้ไม่ได้อยู่ที่นี่ตอนนี้' });
  }
  const at = { day: state.day, phase: state.phase, turn: state.turn };
  const status = statusOf(db, assets, me, at);
  if (status.left === 0) {
    return refuse(409, { code: 'not_allowed', message: `คุยกับ NPC ครบ ${status.perPeriod} ข้อความของช่วงนี้แล้ว คุยได้อีกในช่วงถัดไป` });
  }

  const world = loadWorld(db, me.gameId, assets);
  const player = world.players.get(me.id)!;
  const npc = world.npcs.find((n) => n.id === npcId)!;
  // Every real name of every person → its token, so the reply is rendered per reader (C6, GEN-154).
  const tokenise = (raw: string) =>
    world.npcs
      .flatMap((n) => npcRealNames(assets, n).map((name) => [name, npcToken(n.id)] as const))
      .sort((a, b) => b[0].length - a[0].length)
      .reduce((out, [name, token]) => out.split(name).join(token), world.tokenise(raw.normalize('NFC')));
  // The persona / bond / memories as the turn's dialogue reads them; with examples, the persona sits in the library block.
  const { system: library, npcs: [npcView] } = dialoguePrompt(db, assets, world, withVoice(assets, npcPrompt(db, assets, world, [npc], new Set([npcId]), [me.id])));
  const system = [NPC_CHAT_BLOCK, toneBlock(assets.voice, gameTone(db, me.gameId)), ...library.slice(1)];
  const recent = db
    .select({ text: npcChat.text, reply: npcChat.reply })
    .from(npcChat)
    .where(and(eq(npcChat.memberId, me.id), eq(npcChat.npcId, npcId)))
    .orderBy(desc(npcChat.id))
    .limit(RECENT / 2)
    .all()
    .reverse()
    .flatMap((r) => [{ from: 'player' as const, text: r.text }, { from: 'npc' as const, text: r.reply }]);
  const others = presencesInGame(db, me.gameId).filter((p) => p.locationId === here.locationId && p.memberId !== me.id);
  const context: NpcChatContext = {
    npc: { token: npcToken(npc.id), ...npcView! },
    player: { token: playerToken(player.ref), look: player.appearance, socialTitle: player.socialTitle },
    scene: {
      place: world.places.find((p) => p.id === here.locationId)?.name ?? here.locationId,
      day: at.day,
      period: at.phase,
      weather: weatherAt(db, me.gameId, at)?.weather ?? null,
      playersHere: others.flatMap((p) => (world.players.get(p.memberId) ? [playerToken(world.players.get(p.memberId)!.ref)] : [])),
      npcsHere: npcsHereNow(db, assets, me.gameId, here.locationId, karma).filter((n) => n.id !== npcId).map((n) => `${npcToken(n.id)} (${n.alias})`),
    },
    recent,
    message: tokenise(text),
    whisper: input.whisper,
  };

  const ask = (messages: { role: 'user' | 'assistant'; text: string }[], signal?: AbortSignal) =>
    ai.call({ gameId: me.gameId, purpose: 'npc_chat', ...at, system, messages, output: { name: 'npc_chat', schema: NpcChatAnswer }, maxOutputTokens: 400, maxRetries: 1, ...(signal ? { signal } : {}) });
  const first = [{ role: 'user' as const, text: JSON.stringify(context) }];
  const result = await ask(first);
  // C8: no answer = nothing stored, the quota is not used.
  const unavailable = refuse(503, { code: 'ai_unavailable', message: 'NPC ยังไม่ตอบ กด "ลองใหม่" ได้ ไม่เสียโควตา' });
  if (!result.ok) {
    deps.log(`[npc-chat] game=${me.gameId} npc=${npcId} failed: ${result.error.code}`);
    return unavailable;
  }
  const clean = (a: NpcChatAnswer) => ({ ...a, reply: clampLine(tokenise(a.reply)), suggestion: a.suggestion ? cutLine(tokenise(a.suggestion), SUGGESTION_CHARS) || null : null });
  // GEN-169: the reply against the NPC's speech profile before any player reads it.
  const { value: answer } = await gateStyle({
    db,
    value: clean(result.value),
    timeoutMs: deps.styleRewriteMs,
    label: `game=${me.gameId} purpose=npc_chat npc=${npcId}`,
    log: deps.log,
    issuesOf: (v) => styleIssues(assets.voice, v.reply, 'dialogue', npcId, npcView!.form),
    rewrite: async (issues, signal) => {
      const again = await ask(
        [
          ...first,
          { role: 'assistant', text: JSON.stringify(result.value) },
          { role: 'user', text: JSON.stringify({ styleIssues: issues.map((i) => ({ rule: i.reason, fix: i.fix })), instruction: 'Fix the wording as `fix` says and answer the whole object again.' }) },
        ],
        signal,
      );
      return again.ok ? clean(again.value) : undefined;
    },
  });
  if (answer.reply.length === 0) return unavailable;

  const t = deps.now();
  const members = activeMembers(db, me.gameId);
  const gms = members.filter((m) => m.role === 'gm').map((m) => m.id);
  const listeners = input.whisper ? [] : others.map((p) => p.memberId).filter((id) => members.some((m) => m.id === id));
  const rows = db.transaction((tx) => {
    // ISK-001: the server owner closed the game while the NPC was answering: nothing is stored.
    if (closureOf(tx, me.gameId)) return null;
    // Affinity moves at most once per NPC per period, so chatting cannot farm it.
    const moved = tx
      .select({ n: count() })
      .from(npcChat)
      .where(and(eq(npcChat.memberId, me.id), eq(npcChat.npcId, npcId), eq(npcChat.day, at.day), eq(npcChat.phase, at.phase), ne(npcChat.affinity, 0)))
      .get()!.n;
    const delta = moved > 0 ? 0 : answer.mood === 'warmer' ? 1 : answer.mood === 'colder' ? -1 : 0;
    tx.insert(npcChat).values({ gameId: me.gameId, memberId: me.id, npcId, day: at.day, phase: at.phase, whisper: input.whisper, text: context.message, reply: answer.reply, affinity: delta, createdAt: t }).run();
    if (delta !== 0) changeNpcAffinity(tx, assets, me.id, npcId, delta, { day: at.day, now: t });
    // What the NPC now knows of the player (GEN-146): who said it (by look until acquainted) and what.
    const known = npcBondsOf(tx, me.id).some((b) => b.npcId === npcId && (b.nameRevealed || b.companionSeq !== null));
    const who = known ? playerToken(player.ref) : player.socialTitle;
    tx.insert(npcMemory)
      .values({ gameId: me.gameId, memberId: me.id, npcId, day: at.day, phase: at.phase, weight: 'normal', witnesses: JSON.stringify(listeners), text: cutLine(`${who} คุยด้วยว่า "${context.message}"`, MEMORY_LIMITS.lineChars), createdAt: t })
      .run();

    // What the player said: to the others here (a whisper: the Human GM only); never back to the speaker (their box has it).
    const readers = new Set([...listeners, ...gms]);
    const said = readers.size === 0 ? [] : [{ row: insertEntry(tx, me.gameId, { kind: 'player', at, locationId: here.locationId, text, meta: { actor: me.id } }, [...readers], t), recipients: readers }];
    const hearers = new Set([me.id, ...listeners, ...gms]);
    const line = renderTokens(tx, world, answer.reply, input.whisper ? me.id : null, !input.whisper);
    const npcEntry = { kind: 'npc' as const, at, locationId: input.whisper ? null : here.locationId, text: line, meta: { npc: { id: npcId, kind: 'dialogue' as const, ...(input.whisper ? { private: true as const } : {}) } } };
    return [...said, { row: insertEntry(tx, me.gameId, npcEntry, [...hearers], t), recipients: hearers }];
  });
  if (rows === null) return refuse(409, { code: 'game_closed', message: 'เกมนี้ถูกผู้ดูแลปิดแล้ว' });
  deps.publish(me.gameId, rows);

  const body: NpcChatResponse = {
    reply: renderTokens(db, world, answer.reply, me.id),
    suggestion: answer.suggestion ? renderTokens(db, world, answer.suggestion, me.id) : null,
    status: { perPeriod: status.perPeriod, left: status.left - 1 },
  };
  return { ok: true, status: 200, body };
}
