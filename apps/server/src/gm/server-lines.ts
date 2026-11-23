/**
 * Server-written lines about one NPC as one player reads them (GEN-150; used by GEN-144 farewells and GEN-145 NPC in /
 * out). The name is the one GEN-121 lets this player see (alias until known), from `npcSpeaker`.
 */
import type { Rng } from '@isekai/rules';
import type { GameAssets } from '../assets/load.ts';
import { farewellLine, serverLine } from '../assets/server-lines.ts';
import { npcSpeaker } from '../companions/store.ts';
import { sheetNpcFor } from '../companions/sheet.ts';
import type { DbOrTx } from '../db/client.ts';

/** The scenario NPC (its id, name and alias). */
export interface LineNpc {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
}

// A viewer outside the NPC's game gets no speaker; the alias is the safe name then.
const nameFor = (db: DbOrTx, assets: GameAssets, viewerId: string, npc: LineNpc) => npcSpeaker(db, assets, viewerId, npc.id)?.name ?? npc.alias;

/** `npc` says goodbye: its own NPC-tab Farewell line, else a generic one. */
export function npcFarewellFor(db: DbOrTx, assets: GameAssets, viewerId: string, npc: LineNpc, rng?: Rng): string {
  return farewellLine(assets.serverLines, nameFor(db, assets, viewerId, npc), sheetNpcFor(assets, npc)?.record.farewell ?? '', rng);
}

/** `npc` arrives at / leaves `place` (the place name as this viewer sees it). */
export function npcMoveFor(db: DbOrTx, assets: GameAssets, viewerId: string, npc: LineNpc, situation: 'npc_arrive' | 'npc_leave', place: string, rng?: Rng): string {
  return serverLine(assets.serverLines, situation, { npc: nameFor(db, assets, viewerId, npc), place }, rng);
}
