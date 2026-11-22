import { z } from 'zod';

/**
 * Start scenario (GEN-065, GDD §6.1, sheet Start_Scenarios): where each player arrives in the other world,
 * rolled once by the server at game start, plus the private narration of how they crossed over. A player
 * only ever gets their own; the Human GM gets everyone's. No Karma number (GEN-067).
 */
export const OriginKind = z.enum(['standard', 'special', 'secret']);
export type OriginKind = z.infer<typeof OriginKind>;

export const OriginPlace = z.strictObject({ id: z.string(), name: z.string() });

export const OriginView = z.strictObject({
  kind: OriginKind,
  /** The origin tier's label, e.g. "จุดเกิดมาตรฐาน". */
  tierLabel: z.string(),
  /** The start scenario (Start_Scenarios Name), e.g. "นักดนตรีพเนจรตกอับ". */
  spawnLabel: z.string(),
  /** The place the character woke up at. */
  location: OriginPlace,
  /** Initial_Title, e.g. "นักดนตรีพเนจรถือพิณเก่า". */
  initialTitle: z.string(),
  /** The sheet's Passive text (what the start gives), e.g. "โบนัส +2 เมื่อใช้กิริยา PERSUADE ...". */
  passive: z.string(),
  /** Chronic illness of the sickly noble: successful treatments still needed (0 = cured); null = none. */
  illness: z.strictObject({ treatmentsLeft: z.number().int().min(0) }).nullable(),
  /** The private AI narration of the crossing; null while it is still being written. */
  narration: z.string().nullable(),
});
export type OriginView = z.infer<typeof OriginView>;

/** 200 from GET /api/game/origin. `origin` is null before the game starts. */
export const OriginResponse = z.discriminatedUnion('view', [
  z.strictObject({ view: z.literal('player'), origin: OriginView.nullable() }),
  z.strictObject({ view: z.literal('gm'), origins: z.array(OriginView.extend({ memberId: z.string() })) }),
]);
export type OriginResponse = z.infer<typeof OriginResponse>;
