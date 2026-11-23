import type { ReviewScene } from '@isekai/protocol';
import { desc, inArray } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { PromptBlock } from '../ai/provider.ts';
import type { DbOrTx } from '../db/client.ts';
import { npcExample } from '../db/schema.ts';
import { DIALOGUE_BLOCK, npcToken, withinTokens, type GmWorld, type NarrationContext } from './context.ts';
import { npcRealNames } from './npc-lines.ts';

/**
 * GEN-151: the NPC example library in the dialogue prompt. Each NPC here with examples gets its persona and its
 * newest ≤ 3 examples in one cached block right after the rules (Anthropic caches by prefix), so two calls for the
 * same NPCs start with the same bytes; the per-turn context follows in the message.
 */

/** One player in a stored example, whichever game it came from. */
export const PLAYER_TOKEN = '{{p:player}}';
export const EXAMPLES_PER_NPC = 3;
const EXAMPLE_TOKENS = 100;

const SCENE_WORD: Record<ReviewScene, string> = { feed: 'บรรยายฉาก', narration: 'บทเล่า', 'npc-dialogue': 'บทพูด', 'npc-reaction': 'ปฏิกิริยา' };

const HEAD =
  'คลังตัวอย่างของ NPC ที่อยู่ที่นี่ (บทที่ผู้เล่นชอบ): ใช้เป็นแนวน้ำเสียงและบุคลิกเท่านั้น ห้ามคัดลอกคำต่อคำ ห้ามเล่าเรื่องในตัวอย่างซ้ำ / {{p:player}} = ผู้เล่นคนหนึ่ง ห้ามเขียน token นี้ในคำตอบ (ใช้ {{p:ref}} ของ cast)';

/** `text` with every name swapped for its token (longest first), players' (and any player token) for `{{p:player}}`. */
export function exampleTokens(text: string, npcs: readonly { id: string; names: readonly string[] }[], players: readonly string[]): string {
  const swaps = [...npcs.flatMap((n) => n.names.map((name) => [name, npcToken(n.id)] as const)), ...players.map((name) => [name, PLAYER_TOKEN] as const)]
    .filter(([name]) => name.trim().length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  return swaps.reduce((out, [name, token]) => out.split(name).join(token), text.normalize('NFC')).replace(/\{\{p:[A-Za-z0-9_-]+\}\}/g, PLAYER_TOKEN);
}

/** C1-C5: the dialogue call's system blocks, and its NPCs (the persona of one in the block is not repeated per turn). */
export function dialoguePrompt(db: DbOrTx, assets: GameAssets, world: GmWorld, npcs: NarrationContext['npcs']): { system: PromptBlock[]; npcs: NarrationContext['npcs'] } {
  const here = npcs.filter((n) => n.here).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rows = here.length === 0 ? [] : db.select().from(npcExample).where(inArray(npcExample.npcId, here.map((n) => n.id))).orderBy(desc(npcExample.id)).all();
  const shown = here.filter((n) => rows.some((r) => r.npcId === n.id));
  if (shown.length === 0) return { system: [DIALOGUE_BLOCK], npcs };

  // C4: a stored example has tokens already; names of this world are swapped again in case one slipped in.
  const names = world.npcs.map((n) => ({ id: n.id, names: npcRealNames(assets, n) }));
  const players = [...world.players.values()].map((p) => p.name);
  const sections = shown.map((n) => {
    const examples = rows.filter((r) => r.npcId === n.id).slice(0, EXAMPLES_PER_NPC).reverse();
    return [
      `${npcToken(n.id)} (${n.alias})`,
      ...(n.persona ? [`persona: ${n.persona}`] : []),
      ...examples.map((r) => `- [${SCENE_WORD[r.scene]}] ${withinTokens(exampleTokens(r.text, names, players), EXAMPLE_TOKENS)}`),
    ].join('\n');
  });
  const inBlock = new Set(shown.map((n) => n.id));
  return {
    system: [DIALOGUE_BLOCK, { id: 'npc-examples', text: [HEAD, ...sections].join('\n\n'), cache: true }],
    npcs: npcs.map((n) => (inBlock.has(n.id) ? { ...n, persona: null } : n)),
  };
}
