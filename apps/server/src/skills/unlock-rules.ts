import type { SkillCondition, SkillUnlockPath, SkillUnlockRule } from '@isekai/rules';

/**
 * The Condition column of the sheet's Ability tab and the "เงื่อนไขปลดล็อก" half of the Item tab's Skill Synergy
 * (GEN-055), written as rules the server checks (`@isekai/rules` `unlockPath`). The sheet text is free Thai, so
 * the shape lives here; `test/skills-sheet.test.ts` checks that every Ability row has a rule and that the skill
 * / item names and the numbers of each rule are in that row's text, so a sheet edit fails the tests instead of
 * drifting.
 *
 * - "หรือ NPC ... มอบให้" is not a path here: NPC gifts follow the NPC tab's Rewards (GEN-054 `grantNpcReward`).
 * - Activities are counted by the server from each resolved action (`progress.ts`): `verb:<TAG>` (the action's
 *   verb tag), `act`, `good` / `evil` (karma up / down), `good_public` / `evil_secret`, `karma_steady`.
 * - Flags are the events only the AI GM can judge; their names are the API the AI GM loop calls
 *   (`recordSkillFlag`). An item's flag counts only toward the path that also needs the item held.
 * - "ต่ำกว่า -60" is `max: -61`, "+60 ขึ้นไป" is `min: 60` (karma is a whole number).
 */

const own = (...all: SkillCondition[]): SkillUnlockPath => ({ source: 'condition', all });
const withItem = (item: string, ...all: SkillCondition[]): SkillUnlockPath => ({ source: `item:${item}`, all: [{ type: 'holding', item }, ...all] });
const skill = (name: string): SkillCondition => ({ type: 'skill', name });
const flag = (name: string, count?: number): SkillCondition => ({ type: 'flag', flag: name, ...(count === undefined ? {} : { count }) });
/** "อย่างน้อย 1 เทิร์น ใน 3 ช่วงเวลาที่ไม่ซ้ำกันต่อวัน ต่อเนื่อง N วันเต็ม (ห้ามขาด)". */
const streak = (activity: string, days: number, extra: Partial<Extract<SkillCondition, { type: 'streak' }>> = {}): SkillCondition => ({
  type: 'streak',
  activity,
  days,
  periodsPerDay: 3,
  ...extra,
});

export const UNLOCK_RULES: Readonly<Record<string, SkillUnlockRule>> = {
  // --- Good ---
  'The First Light': {
    paths: [
      own(streak('verb:PRAY', 3)),
      // Chalice: "ใช้จอกนี้ช่วยเหลือผู้อื่นครบ 3 ครั้ง + สวดภาวนา 3 ช่วงเวลา ... จาก 3 วัน เหลือเพียง 2 วัน (6 ช่วงเวลา)"
      withItem('Chalice of the First Dawn', flag('chalice_helped_others', 3), { type: 'periods', activity: 'verb:PRAY', count: 3 }, streak('verb:PRAY', 2)),
    ],
  },
  'Grace of Dawn': { paths: [own({ type: 'skillOf', rank: 'A', alignment: 'Good' }, { type: 'karma', min: 60 })] },
  'Sanctuary Aegis': {
    paths: [
      own(skill('Aegis of Faith'), flag('protected_others', 3)),
      // Mantle: "สวมใส่และรับความเสียหายแทนผู้อื่น 2 ครั้ง จะปลดล็อก Sanctuary Aegis (S) ทันที"
      withItem('Mantle of the Martyr', flag('mantle_took_hits_for_others', 2)),
    ],
  },
  'Smite of Purgation': { paths: [own(skill('Luminous Strike'), flag('defeated_evil'))] },
  'Aegis of Faith': { paths: [own(skill('Ward of Light'), { type: 'karma', min: 35 })] },
  'Voice of Conscience': {
    paths: [
      own(skill('Plea of Mercy'), flag('resolved_conflict_peacefully', 2)),
      // Censer: "ปลดล็อกสกิล Voice of Conscience (A) เมื่อใช้เปิดโปงคนร้ายต่อหน้าสาธารณะ"
      withItem('Censer of Purging Flame', flag('censer_exposed_culprit')),
    ],
  },
  'Blessing of Hearth': {
    paths: [
      own({ type: 'periodRun', activity: 'good_public', periods: 2 }),
      // Loaf: "แบ่งให้ขอทานหรือ NPC เกรด F กินครบ 2 ชิ้น จะปลดล็อก Blessing of Hearth (B)"
      withItem('Blessed Loaf of Dawn', flag('loaf_shared_with_grade_f', 2)),
    ],
  },
  'Glare of Truth': {
    paths: [
      own(flag('exposed_lie')),
      // Prism: "ใช้จับโกหก NPC ได้ 1 ครั้ง จะปลดล็อก Glare of Truth (B)"
      withItem('Prism of Truth', flag('prism_caught_lie')),
    ],
  },
  'Plea of Mercy': { paths: [own(flag('negotiated_grade_b_peacefully'))] },
  'Luminous Strike': { paths: [own(flag('helped_villagers_or_guards_fight'))] },
  // "สวดภาวนาหรือได้รับพรจากนักบวชฝ่ายดี"
  'Ward of Light': { paths: [own({ type: 'periods', activity: 'verb:PRAY', count: 1 }), own(flag('blessed_by_good_priest'))] },

  // --- Evil ---
  'ORDO TENEBRIS': {
    paths: [
      own(streak('evil', 3), { type: 'karma', max: -91 }),
      // Grimoire: "ถือครองคัมภีร์นี้ขณะมีค่ากรรมต่ำกว่า -75 จะข้ามเงื่อนไขความต่อเนื่อง 3 วัน และปลดล็อก ORDO TENEBRIS (SS) ได้ทันที"
      withItem('Grimoire of the Blood Moon', { type: 'karma', max: -76 }),
    ],
  },
  'Puppeteer’s Crown': {
    paths: [
      own(skill('Whisper of Temptation'), { type: 'karma', max: -61 }),
      // Ring: "ใช้ปั่นหัว NPC จนทะเลาะกัน 2 ครั้ง จะปลดล็อก Puppeteer’s Crown (S)"
      withItem('Ring of Whispering Hollow', flag('ring_turned_npcs_on_each_other', 2)),
    ],
  },
  'Abyssal Miasma': { paths: [own(skill('Venom of Despair'), flag('cult_secret_ritual', 2))] },
  'Whisper of Temptation': { paths: [own(skill('Shadow Suggestion'), flag('sowed_discord'))] },
  'Venom of Despair': { paths: [own(skill('Mark of Paranoia'), { type: 'karma', max: -36 })] },
  'Soul Siphon': {
    paths: [
      own(skill('Backstab of Greed'), flag('took_target_down')),
      // Kris: "ใช้กริชนี้ลอบสังหารหรือทำร้ายเป้าหมายจนสลบ จะปลดล็อก Soul Siphon (A) ทันที"
      withItem('Kris of Soul Thirst', flag('kris_knocked_out_target')),
    ],
  },
  'Feast of Malice': { paths: [own({ type: 'periodRun', activity: 'evil_secret', periods: 2 })] },
  'Mark of Paranoia': {
    paths: [
      own(flag('framed_someone')),
      // Vial: "ใช้ใส่ร้าย NPC สำเร็จ 1 ครั้ง จะปลดล็อก Mark of Paranoia (B)"
      withItem('Vial of Black Ash', flag('vial_framed_npc')),
    ],
  },
  'Shadow Suggestion': { paths: [own(flag('approached_unseen'))] },
  'Backstab of Greed': {
    paths: [
      own(flag('backstabbed_or_stole')),
      // Lockpick: "ลอบเข้าพื้นที่หวงห้ามสำเร็จ 1 ครั้ง จะปลดล็อก Backstab of Greed (B)"
      withItem('Shadow-Silk Lockpick', flag('lockpick_entered_restricted')),
    ],
  },
  'Scapegoat Veil': {
    paths: [
      own(flag('escaped_crisis_by_deceit')),
      // Mask: "รอดพ้นจากการถูกจับได้ 1 ครั้งขณะสวมหน้ากาก จะปลดล็อก Scapegoat Veil (B)"
      withItem('Mask of the Faceless', flag('mask_escaped_capture')),
    ],
  },

  // --- Neutral ---
  'I AM UNTOUCHED': { paths: [own(streak('act', 3, { fromDay: 4, karmaMin: -1, karmaMax: 1 }))] },
  'Absolute Zero Law': { paths: [own(skill('Mirror of Equilibrium'), { type: 'karmaDays', min: -5, max: 5, days: 2 })] },
  'Observer’s Transcendence': {
    paths: [
      own(skill('Detached Mind'), flag('stayed_out_of_major_conflict', 2)),
      // Monocle: "สังเกตการณ์เหตุการณ์ปะทะโดยไม่ยื่นมือช่วยฝ่ายใด 2 ครั้ง จะปลดล็อก Observer’s Transcendence (S)"
      withItem('Monocle of the Bystander', flag('monocle_watched_clash', 2)),
    ],
  },
  'Mirror of Equilibrium': { paths: [own(skill('Neutral Guard'), { type: 'karma', min: -10, max: 10 })] },
  // "ผ่านพ้นช่วงค่ำโดยไม่เสียค่ากรรมเพิ่มหรือลด": ค่ำ = HESPERION.
  'Detached Mind': { paths: [own(skill('Clear Horizon'), { type: 'periods', activity: 'karma_steady', count: 1, period: 'HESPERION' })] },
  'Severance Strike': {
    paths: [
      own(skill('Calculated Blow'), flag('won_by_skill_alone')),
      // Blade: "ใช้ดาบนี้เอาชนะศัตรูที่ใช้เวทมนตร์ได้ 1 ครั้ง จะปลดล็อก Severance Strike (A)"
      withItem('Unbound Iron Blade', flag('blade_beat_magic_user')),
    ],
  },
  'Clear Horizon': {
    paths: [
      own({ type: 'periods', activity: 'karma_steady', count: 1 }),
      // Watch: "พกติดตัวและรักษาค่ากรรมให้อยู่ในช่วง -2 ถึง +2 ครบ 1 วัน จะปลดล็อก Clear Horizon (B)"
      withItem('Lead-Core Pocket Watch', { type: 'karmaDays', min: -2, max: 2, days: 1 }),
    ],
  },
  'Stasis Anchor': { paths: [own(flag('stopped_escape_or_clash'))] },
  'Rational Paradox': {
    paths: [
      own(flag('out_argued_authority')),
      // Scales: "ทำการแลกเปลี่ยนกับ NPC เกรด B สำเร็จ 2 ครั้ง จะปลดล็อก Rational Paradox (B)"
      withItem('Scales of Fair Trade', flag('scales_traded_with_grade_b', 2)),
    ],
  },
  'Calculated Blow': { paths: [own(flag('fought_without_magic_items'))] },
  'Neutral Guard': {
    paths: [
      own(flag('survived_city_chaos_unhurt')),
      // Cloak: "เอาตัวรอดจากเหตุการณ์จลาจลในเมืองโดยไม่บาดเจ็บ จะปลดล็อก Neutral Guard (B)"
      withItem('Cloak of Grey Dust', flag('cloak_survived_riot')),
    ],
  },
};

/** Every flag name the rules use (the only flags the AI GM may set). */
export const SKILL_FLAGS: ReadonlySet<string> = new Set(
  Object.values(UNLOCK_RULES).flatMap((r) => r.paths.flatMap((p) => p.all.flatMap((c) => (c.type === 'flag' ? [c.flag] : [])))),
);
