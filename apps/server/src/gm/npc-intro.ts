import type { GameAssets } from '../assets/load.ts';
import { meetNpc } from '../companions/store.ts';
import type { DbOrTx } from '../db/client.ts';
import { getGameScenario } from '../scenario/store.ts';
import { containsName } from './check.ts';
import type { GmWorld, TurnAction } from './context.ts';
import type { GmAction } from './schema.ts';

/**
 * GEN-170 (Q-320 B): who hears a grade F / A NPC's real name this turn knows it (`meetNpc`): the actor says it
 * (`name` / `otherNames`, NFC), or the AI GM reports the NPC introduced itself (`introducedNpcs`). Only NPCs `here`
 * at the actor's place count (the dialogue's set, `npcsPresentAt`). Hearers: everyone at the place when Public,
 * the actor only when Secret. Idempotent, so a replay after a restart is safe.
 */
export function introduceNpcs(
  db: DbOrTx,
  assets: GameAssets,
  world: GmWorld,
  order: readonly TurnAction[],
  actions: readonly Pick<GmAction, 'actionId' | 'introducedNpcs'>[],
  start: ReadonlyMap<string, string>,
  here: (placeId: string, members: string[]) => readonly { id: string }[],
  at: number,
): void {
  const npcs = getGameScenario(db, world.gameId)?.npcs ?? [];
  for (const a of order) {
    const place = start.get(a.memberId);
    if (place === undefined || !world.players.has(a.memberId)) continue;
    const introduced = new Set(actions.find((x) => x.actionId === a.actionId)?.introducedNpcs ?? []);
    const hereIds = new Set(here(place, [a.memberId]).map((n) => n.id));
    const heard = npcs.filter(
      (n) => hereIds.has(n.id) && (introduced.has(n.id) || [n.name, ...(n.otherNames ?? [])].some((name) => name.trim().length > 0 && containsName(a.text, name))),
    );
    if (heard.length === 0) continue;
    const hearers = a.visibility === 'public' ? [...start].filter(([id, loc]) => loc === place && world.players.has(id)).map(([id]) => id) : [a.memberId];
    for (const id of hearers) for (const n of heard) meetNpc(db, assets, id, n.id, at);
  }
}
