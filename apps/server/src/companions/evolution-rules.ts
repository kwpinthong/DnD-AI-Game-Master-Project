import type { EvolutionRule } from '@isekai/rules';

/**
 * The Evolution / Unlock Condition column of the sheet's NPC tab (GEN-054), written as rules the server
 * can check. The sheet text is free Thai, so the shape lives here; `test/companions-sheet.test.ts` checks
 * that every grade F / A / S NPC of apps/server/assets/npc.json has a rule and that every number here is
 * in that NPC's condition text, so a sheet edit that changes a number fails the tests instead of drifting.
 *
 * Keyed by the NPC's first alias (the short name in the sheet's name cell). Grade B needs no rule: its
 * condition is the name reveal at "+9", read from the text itself (`revealAffinityOf`).
 *
 * Flags are the event half that only the AI GM can judge; the server checks the numbers (day, count,
 * karma, affinity, periods). The flag names are the API the AI GM loop (GEN-057) uses.
 */
export const EVOLUTION_RULES: Readonly<Record<string, EvolutionRule>> = {
  // "ความสัมพันธ์ถึง +70 และมีค่ากรรม +70 ขึ้นไป (สาย Good) หรือต่ำกว่า -70 (สาย Evil)"
  // -70 itself counts for Evil (task row GEN-054 / case C4).
  โนอา: {
    to: 'SS',
    paths: [
      { alignment: 'Good', all: [{ type: 'affinity', min: 70 }, { type: 'karma', min: 70 }] },
      { alignment: 'Evil', all: [{ type: 'affinity', min: 70 }, { type: 'karma', max: -70 }] },
    ],
  },
  // "+70 และทำกิจกรรมร่วมกับลูเซียอย่างน้อย 1 เทิร์น ใน 3 ช่วงเวลาไม่ซ้ำกันต่อวัน ต่อเนื่อง 3 วันเต็มตั้งแต่วันที่ 4 (กรรม -1 ถึง +1)"
  ลูเซีย: {
    to: 'SS',
    paths: [
      {
        alignment: 'Neutral',
        all: [
          { type: 'affinity', min: 70 },
          { type: 'activityStreak', fromDay: 4, days: 3, periodsPerDay: 3, karmaMin: -1, karmaMax: 1 },
        ],
      },
    ],
  },
  // "ช่วยปกป้องชาวบ้านในวันที่ 7 และเปิดโปงนักบวชชั้นสูงได้สำเร็จ"
  'ลอร์ดจูเลียน แวนเดอร์บิลต์': {
    to: 'S',
    paths: [{ alignment: null, all: [{ type: 'flag', flag: 'protected_villagers', day: 7 }, { type: 'flag', flag: 'exposed_high_priest' }] }],
  },
  // "ร่วมมือในแผนลักพาตัววันที่ 7 และถวายเครื่องสังเวยสำเร็จ"
  'อาร์คบิชอป มัลคอล์ม': {
    to: 'S',
    paths: [{ alignment: null, all: [{ type: 'flag', flag: 'joined_kidnapping', day: 7 }, { type: 'flag', flag: 'offered_sacrifice' }] }],
  },
  // "นำข้อมูลภัยพิบัติวันที่ 5 และหลักฐานจากทั้ง 2 ฝ่ายมาให้วิเคราะห์โดยไม่เข้าข้างใคร"
  'เลดี้เซเรน่า แห่งหอจดหมายเหตุ': {
    to: 'S',
    paths: [
      {
        alignment: null,
        all: [
          { type: 'flag', flag: 'brought_disaster_data', minDay: 5 },
          { type: 'flag', flag: 'brought_church_evidence' },
          { type: 'flag', flag: 'brought_cult_evidence' },
          { type: 'flag', flag: 'stayed_impartial' },
        ],
      },
    ],
  },
  // "มีค่ากรรม +50 ขึ้นไป และนำ Silver Rosary of Hearth หรือ Censer of Purging Flame ไปสวดภาวนาที่แท่นบูชาลับ"
  ออเรเลีย: {
    to: 'S',
    paths: [{ alignment: null, all: [{ type: 'karma', min: 50 }, { type: 'flag', flag: 'prayed_at_secret_altar' }] }],
  },
  // "มีค่ากรรมต่ำกว่า -50 และทำพิธีสังเวยหรือใช้ Secret Action ทำลายความหวังของชาวเมืองครบ 3 ครั้ง"
  น็อกทิส: {
    to: 'S',
    paths: [{ alignment: null, all: [{ type: 'karma', max: -51 }, { type: 'flag', flag: 'crushed_hope', count: 3 }] }],
  },
  // "ผ่าน 1% มิติพิศวงออกมาได้ หรือรักษาค่ากรรมให้อยู่ในช่วง -3 ถึง +3 จนถึงวันที่ 5"
  แอสทรา: {
    to: 'S',
    paths: [
      { alignment: null, all: [{ type: 'flag', flag: 'escaped_pocket_dimension' }] },
      { alignment: null, all: [{ type: 'karmaBandThrough', min: -3, max: 3, untilDay: 5 }] },
    ],
  },
};
