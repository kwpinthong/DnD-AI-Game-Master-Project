import {
  APPEARANCE_CATEGORIES,
  APPEARANCE_EXTRA_MAX_LENGTH,
  appearanceLabels,
  AVATAR_IDS,
  composeAppearance,
  defaultScenario,
  normalizeAppearanceExtra,
  type AppearanceCategory,
  type AppearanceTraits,
  type CharacterRequest,
} from '@isekai/protocol';
import type { GameAssets } from '../assets/load.ts';
import { sheetNpcFor } from '../companions/sheet.ts';
import type { DbOrTx } from '../db/client.ts';
import { containsName } from '../gm/check.ts';
import { getGameScenario } from '../scenario/store.ts';

/** The real names of the game's NPCs (scenario names + the sheet's aliases, not the Public_Alias anyone may see). */
function npcRealNames(db: DbOrTx, gameId: string, assets: GameAssets): string[] {
  const npcs = getGameScenario(db, gameId)?.npcs ?? defaultScenario().npcs;
  return npcs
    .flatMap((n) => {
      const sheet = sheetNpcFor(assets, n)?.record;
      return [n.name, ...(n.otherNames ?? []), ...(sheet?.aliases.filter((a) => a !== sheet.publicAlias) ?? [])];
    })
    .filter((name) => name.trim().length > 1);
}

export type Looks = { avatarId: string; appearanceTraits: AppearanceTraits; appearance: string };
export type LooksProblem =
  | { code: 'invalid_avatar'; message: string }
  | { code: 'invalid_trait'; message: string; field: string }
  | { code: 'extra_too_long'; message: string }
  | { code: 'extra_forbidden'; message: string };

/** The avatar + chips of a create / edit checked against the current chip list, and the sentence they make. */
export function checkLooks(db: DbOrTx, gameId: string, assets: GameAssets, input: CharacterRequest): { ok: true; looks: Looks } | { ok: false; problem: LooksProblem } {
  if (input.avatarId === undefined || !AVATAR_IDS.includes(input.avatarId)) return { ok: false, problem: { code: 'invalid_avatar', message: 'กรุณาเลือกรูปตัวละคร' } };
  const offered = appearanceLabels(assets.appearanceOptions);
  const picked = input.appearanceTraits ?? {};
  const chips = {} as Record<AppearanceCategory, string>;
  for (const category of APPEARANCE_CATEGORIES) {
    const id = picked[category];
    if (id === undefined || !offered[category].some((o) => o.id === id)) {
      return { ok: false, problem: { code: 'invalid_trait', message: 'กรุณาเลือกลักษณะภายนอกให้ครบทุกหมวด', field: category } };
    }
    chips[category] = id;
  }
  const extra = normalizeAppearanceExtra(picked.extra ?? '');
  if ([...extra].length > APPEARANCE_EXTRA_MAX_LENGTH) return { ok: false, problem: { code: 'extra_too_long', message: `รายละเอียดเพิ่มเติมยาวได้ไม่เกิน ${APPEARANCE_EXTRA_MAX_LENGTH} ตัวอักษร` } };
  if (/\{\{|\}\}/.test(extra) || npcRealNames(db, gameId, assets).some((name) => containsName(extra, name))) {
    return { ok: false, problem: { code: 'extra_forbidden', message: 'รายละเอียดเพิ่มเติมใส่ชื่อ NPC หรือ {{ }} ไม่ได้' } };
  }
  const appearanceTraits: AppearanceTraits = { ...chips, ...(extra ? { extra } : {}) };
  return { ok: true, looks: { avatarId: input.avatarId, appearanceTraits, appearance: composeAppearance(appearanceTraits, appearanceLabels(assets.appearanceOptions, true)) } };
}
