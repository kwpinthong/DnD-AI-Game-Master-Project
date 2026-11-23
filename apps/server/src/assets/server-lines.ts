/**
 * Server message templates (GEN-150, Nok 2026-11-23): lines the server writes itself, with no AI call, for the time
 * announcement, an NPC arriving / leaving and a farewell. They live in apps/server/assets/server-lines.json, a file
 * written by hand (later from admin, GEN-147), not a sheet tab: the sheet import never touches it. Each row is one
 * template; the server picks one of a situation's rows at random and fills its {slots}. A bad row stops start-up.
 */
import type { Rng } from '@isekai/rules';
import { z } from 'zod';
import { CryptoRng } from '../rng.ts';

export const SERVER_LINES_FILE = 'server-lines.json';

/** The slots each situation's text may use; every one listed is filled when the line is written. */
export const SITUATION_SLOTS = {
  time_announce: ['phase'],
  npc_arrive: ['npc', 'place'],
  npc_leave: ['npc', 'place'],
  farewell: ['npc', 'farewell'],
  /** Fills {farewell} for an NPC without its own line in the NPC tab's Farewell column. */
  generic_farewell: [],
} as const satisfies Record<string, readonly string[]>;
export type Situation = keyof typeof SITUATION_SLOTS;
export type SlotValues<S extends Situation> = Readonly<Record<(typeof SITUATION_SLOTS)[S][number], string>>;

const SLOT = /\{([^{}]*)\}/g;

export const ServerLineRecord = z
  .object({
    situation: z.enum(Object.keys(SITUATION_SLOTS) as [Situation, ...Situation[]]),
    text: z.string().trim().min(1, 'text ต้องไม่ว่าง'),
  })
  .strict()
  .superRefine((row, ctx) => {
    const allowed: readonly string[] = SITUATION_SLOTS[row.situation];
    for (const [slot, name] of row.text.matchAll(SLOT)) {
      if (!allowed.includes(name!)) {
        ctx.addIssue({ code: 'custom', path: ['text'], message: `${slot} ใช้ใน ${row.situation} ไม่ได้ (ใช้ได้: ${allowed.map((s) => `{${s}}`).join(' ') || 'ไม่มี'})` });
      }
    }
  });
export type ServerLineRecord = z.infer<typeof ServerLineRecord>;

export const ServerLines = z.array(ServerLineRecord).superRefine((rows, ctx) => {
  for (const situation of Object.keys(SITUATION_SLOTS)) {
    if (!rows.some((r) => r.situation === situation)) ctx.addIssue({ code: 'custom', message: `ไม่มีข้อความสำหรับ ${situation} เลย` });
  }
});

/** One of `situation`'s templates at random, with its slots filled from `values`. */
export function serverLine<S extends Situation>(lines: readonly ServerLineRecord[], situation: S, values: SlotValues<S>, rng: Rng = new CryptoRng()): string {
  const rows = lines.filter((l) => l.situation === situation);
  const row = rows[rng.nextInt(0, rows.length - 1)]!;
  return row.text.replace(SLOT, (_all, name: string) => (values as Record<string, string>)[name] ?? '');
}

/** A farewell from `npcName` (already the name this viewer may see), with its own line or else a generic one. */
export function farewellLine(lines: readonly ServerLineRecord[], npcName: string, ownFarewell: string, rng: Rng = new CryptoRng()): string {
  const farewell = ownFarewell.trim() || serverLine(lines, 'generic_farewell', {}, rng);
  return serverLine(lines, 'farewell', { npc: npcName, farewell }, rng);
}
