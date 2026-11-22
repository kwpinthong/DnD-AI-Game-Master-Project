import { z } from 'zod';

/**
 * The player's own skills and items (GEN-055, Q-106): what they hold now, after a steal or a gift too.
 * Ranks are the sheet's (B / A / S / SS; null = an old GEN-048 option the sheet has no row for). An unlock
 * condition or its progress is never here, except the conditions the player found with INVESTIGATE at the
 * library (`discoveries`, Special Mechanics of หอสมุดหลวง).
 */

export const SHEET_RANKS = ['B', 'A', 'S', 'SS'] as const;

export const InventoryEntry = z.strictObject({
  /** Server id of the owned skill / held item (a steal / give names it). */
  id: z.string(),
  /** Ability name / Item English name. */
  name: z.string(),
  rank: z.enum(SHEET_RANKS).nullable(),
  /** Good / Evil / Neutral; null for an old option. */
  alignment: z.string().nullable(),
  category: z.string(),
  /** "Active", "Passive", "Passive + Active"; null for an old option. */
  triggerType: z.string().nullable(),
  /** Uses per game day; 0 = no limit. */
  dailyLimit: z.number().int().min(0),
  /** Ability Description / Item Effect. */
  description: z.string(),
});
export type InventoryEntry = z.infer<typeof InventoryEntry>;

export const InventoryDiscovery = z.strictObject({
  kind: z.enum(['skill', 'item']),
  name: z.string(),
  /** The unlock condition as the sheet writes it (a skill's Condition, an item's Skill Synergy). */
  text: z.string(),
});
export type InventoryDiscovery = z.infer<typeof InventoryDiscovery>;

export const InventoryView = z.strictObject({
  skills: z.array(InventoryEntry),
  items: z.array(InventoryEntry),
  discoveries: z.array(InventoryDiscovery),
});
export type InventoryView = z.infer<typeof InventoryView>;

/** 200 from GET /api/game/inventory. */
export const InventoryResponse = z.strictObject({ inventory: InventoryView });
export type InventoryResponse = z.infer<typeof InventoryResponse>;
