import { Scenario, type ScenarioInput } from './scenario.ts';

/*
 * Default scenario "เมืองก่อนอุกกาบาต" from the GDD (Google Drive "Isekai Chronicles - Game Design &
 * System Architecture Specification.md" §4.2, §5, §6) and the GEN-042 Rules Spec (§4.1, §5, §11, §12.2).
 * Games without a Human GM use this template only (Q-028).
 *
 * PLACEHOLDER marks content the GDD does not give (names, phases, places beyond the ones it names).
 * Place names marked "GEN-044" come from the scenario editor wireframe, not the GDD.
 */
const template: ScenarioInput = {
  schemaVersion: 1,
  id: 'default',
  name: 'เมืองก่อนอุกกาบาต', // GEN-044 wireframe
  town: {
    name: 'เมืองก่อนอุกกาบาต', // PLACEHOLDER: the GDD names no town
    mood: 'เมืองแฟนตาซีที่ลัทธิค่อย ๆ แทรกซึม เหลือเวลา 12 วันก่อนอุกกาบาตหมูเด้งพุ่งชนโลก',
    taboos: [],
  },
  locations: [
    {
      id: 'inn', // GEN-044
      name: 'โรงเตี๊ยมหมีหลับ',
      restQuality: 'inn',
      safety: 'safe',
      connects: ['market'],
      description: 'โรงเตี๊ยมกลางเมือง ที่พักที่ดีที่สุด',
    },
    {
      id: 'market', // GEN-044
      name: 'ลานตลาด',
      restQuality: 'rough',
      safety: 'normal',
      connects: ['inn', 'temple', 'alley', 'clinic', 'manor', 'mage-tower', 'gate', 'jail'],
      description: 'ลานกลางเมือง ชาวเมืองมารวมตัวกัน',
    },
    {
      id: 'alley', // GEN-044 "ตรอกหลังวิหาร"; GDD origin "ถังขยะในตรอก"
      name: 'ตรอกหลังวิหาร',
      restQuality: 'rough',
      safety: 'danger',
      connects: ['market', 'temple'],
      description: 'ตรอกแคบมีถังขยะ คนไม่ค่อยผ่าน',
    },
    {
      id: 'temple', // GEN-044
      name: 'วิหารแสงรุ่ง',
      restQuality: 'basic',
      safety: 'safe',
      connects: ['market', 'alley'],
      description: 'วิหารของเมือง',
    },
    {
      id: 'forest', // GEN-044 + GDD origin "ป่าหลังเมือง"
      name: 'ป่าหลังเมือง',
      restQuality: 'rough',
      safety: 'danger',
      connects: ['gate', 'cult-altar'],
      description: 'ป่าทึบนอกกำแพงเมือง',
    },
    {
      id: 'clinic', // GDD origin "สถานพยาบาล"
      name: 'สถานพยาบาล',
      restQuality: 'basic',
      safety: 'safe',
      connects: ['market'],
      description: 'ที่รักษาคนเจ็บของเมือง',
    },
    {
      id: 'cult-altar', // GDD Pocket Dimension failure "แท่นบูชาของลัทธิเถื่อน"
      name: 'แท่นบูชาของลัทธิเถื่อน',
      restQuality: 'rough',
      safety: 'danger',
      connects: ['forest'],
      description: 'ที่ทำพิธีของลัทธิ ซ่อนอยู่ในป่า', // PLACEHOLDER: where the altar is
    },
    {
      id: 'manor', // PLACEHOLDER: GDD origin "ร่างป่วยของชนชั้นสูง" needs a noble house
      name: 'คฤหาสน์ขุนนาง',
      restQuality: 'basic',
      safety: 'normal',
      connects: ['market'],
    },
    {
      id: 'mage-tower', // PLACEHOLDER: GDD origin "นักเวทย์ฝึกหัดอัญเชิญผิดพลาด" needs a place
      name: 'หอนักเวทย์',
      restQuality: 'basic',
      safety: 'normal',
      connects: ['market'],
    },
    {
      id: 'gate', // PLACEHOLDER: the way out the day 5 disaster cuts
      name: 'ประตูเมือง',
      restQuality: 'rough',
      safety: 'normal',
      connects: ['market', 'forest'],
    },
    {
      id: 'jail', // PLACEHOLDER: home of the GDD grade F "นักโทษ"
      name: 'คุกเมือง',
      restQuality: 'rough',
      safety: 'danger',
      connects: ['market'],
    },
  ],
  // Starting roster by grade from the GDD §5 examples. Every real name is a PLACEHOLDER.
  npcs: [
    { id: 'beggar', name: 'โนอา', alias: 'ขอทานใกล้ตาย', rank: 'F', locationId: 'alley' },
    { id: 'orphan', name: 'มิว', alias: 'เด็กกำพร้า', rank: 'F', locationId: 'market' },
    { id: 'prisoner', name: 'การ์ม', alias: 'นักโทษ', rank: 'F', locationId: 'jail' },
    { id: 'merchant', name: 'ทอร์บิน', alias: 'พ่อค้า', rank: 'B', locationId: 'market' },
    { id: 'guard', name: 'เฮเลน', alias: 'ทหารยาม', rank: 'B', locationId: 'gate' },
    {
      id: 'cult-acolyte',
      name: 'ซิลาส',
      alias: 'นักบวชแจกขนมปัง',
      rank: 'B',
      locationId: 'market',
      gmNote: 'นักบวชชั้นล่างของลัทธิ ตัวแทนเหตุการณ์วันที่ 1',
    },
    { id: 'noble', name: 'ลอร์ดอัลเดน', alias: 'ขุนนางใจดี', rank: 'A', locationId: 'manor' },
    {
      id: 'spy',
      name: 'เวสเปอร์',
      alias: 'นักเดินทางท่าทางมีพิรุธ',
      rank: 'A',
      locationId: 'market',
      gmNote: 'สายสืบปลอมตัว',
    },
    { id: 'high-priest', name: 'เซเลสต์', alias: 'นักบวชชั้นสูง', rank: 'A', locationId: 'temple' },
    { id: 'cult-leader', name: 'โมรัก', alias: 'ชายสวมผ้าคลุมแดง', rank: 'A', locationId: 'cult-altar', gmNote: 'แกนนำลัทธิ' },
    { id: 'light-spirit', name: 'ลูเมีย', alias: 'ภูตผู้นำพาแสงสว่าง', rank: 'S', locationId: 'temple' },
    { id: 'dark-spirit', name: 'นอกซ์', alias: 'ภูตรับใช้แห่งความมืด', rank: 'S', locationId: 'cult-altar' },
  ],
  // GDD §6.2: these always happen; players can change the outcome. Phases are PLACEHOLDERS except day 10 (night).
  timeline: [
    {
      id: 'd1-bread',
      day: 1,
      phase: 'MORNING',
      title: 'นักบวชลัทธิแจกจ่ายขนมปังให้ชาวเมือง',
      description: 'จุดเริ่มต้นการแทรกซึมของลัทธิ',
      locationId: 'market',
      npcIds: ['cult-acolyte'],
    },
    {
      id: 'd2-first-companion',
      day: 2,
      phase: 'AFTERNOON',
      title: 'พบ NPC คู่หูคนแรก (เกรด F)',
      npcIds: ['beggar', 'orphan', 'prisoner'],
    },
    { id: 'd3-cult-clue', day: 3, phase: 'NIGHT', title: 'ล่วงรู้เบาะแสแผนการร้ายเบื้องหลังของลัทธิ' },
    {
      id: 'd5-disaster',
      day: 5,
      phase: 'MORNING',
      title: 'ภัยพิบัติทางธรรมชาติ/เวทมนตร์ ตัดขาดเส้นทางออกจากเมือง',
      description: 'ออกจากเมืองและขอความช่วยเหลือจากภายนอกไม่ได้อีก',
      locationId: 'gate',
    },
    {
      id: 'd7-kidnapping',
      day: 7,
      phase: 'NIGHT',
      title: 'ลัทธิก่อความวุ่นวายครั้งใหญ่ ลักพาตัวชาวบ้านไปเตรียมเป็นเครื่องสังเวย',
      crisis: true,
    },
    {
      id: 'd10-summoning',
      day: 10,
      phase: 'NIGHT',
      kind: 'climax',
      title: 'คืนจันทร์ดับ ลัทธิทำพิธีอัญเชิญเทพมารจันทราโลหิต (ระดับ SS)',
      description: 'พิธีเพื่อทำลายล้างโลก (Climax 1)',
      crisis: true,
      locationId: 'cult-altar',
      npcIds: ['cult-leader'],
    },
    {
      id: 'd12-meteor',
      day: 12,
      phase: 'NIGHT',
      kind: 'finale',
      title: 'อุกกาบาตหมูเด้งพุ่งชนโลก',
      description: 'ฉากจบ ผลขึ้นอยู่กับการกระทำตลอด 12 วันและระดับพลังของปาร์ตี้/คู่หู',
    },
  ],
  // GDD §6.1 / Rules Spec §11: d100 1-70 standard, 71-99 special, 100 Pocket Dimension.
  origins: [
    {
      id: 'standard',
      kind: 'standard',
      label: 'จุดเกิดมาตรฐาน',
      weight: 70,
      spawnPoints: [
        { id: 'forest-edge', label: 'ป่าหลังเมือง', locationId: 'forest' },
        { id: 'alley-bin', label: 'ถังขยะในตรอก', locationId: 'alley' },
        { id: 'clinic-bed', label: 'สถานพยาบาล', locationId: 'clinic' },
      ],
    },
    {
      id: 'special',
      kind: 'special',
      label: 'จุดเกิดพิเศษ',
      weight: 29,
      spawnPoints: [
        { id: 'apprentice-summon', label: 'ถูกนักเวทย์ฝึกหัดอัญเชิญผิดพลาด', locationId: 'mage-tower' },
        { id: 'cult-summon-failed', label: 'พิธีอัญเชิญเทพมารของลัทธิล้มเหลว', locationId: 'cult-altar' },
        { id: 'slime-spit', label: 'ถูกสไลม์กลืนแล้วคายออกมา', locationId: 'forest' }, // PLACEHOLDER: place
        { id: 'noble-body', label: 'เข้าสิงร่างป่วยใกล้ตายของชนชั้นสูง', locationId: 'manor' },
      ],
    },
    {
      id: 'pocket',
      kind: 'pocket',
      label: 'มิติพิศวง (Pocket Dimension)',
      weight: 1,
      description: 'ติดอยู่ในมิติปิดตาย 3 วัน',
      durationDays: 3,
      escapeDc: 20,
      onSuccess: { legendaryRewards: 1, warpToLocationId: 'market' }, // PLACEHOLDER: where "เข้าสู่เมือง" lands
      onFailure: { reputation: -100, warpToLocationId: 'cult-altar' },
    },
  ],
  // GEN-042 Rules Spec §5 (bands fixed, text editable).
  socialTitles: [
    { min: -100, max: -61, title: 'ภัยของเมือง' },
    { min: -60, max: -31, title: 'เงามืดผู้ต้องสงสัย' },
    { min: -30, max: -11, title: 'คนน่าสงสัย' },
    { min: -10, max: 10, title: 'คนแปลกหน้า' },
    { min: 11, max: 30, title: 'คนคุ้นหน้า' },
    { min: 31, max: 60, title: 'ผู้ใจบุญ' },
    { min: 61, max: 100, title: 'วีรชนแห่งเมือง' },
  ],
  // GDD §4.2 example condition; the name is a PLACEHOLDER.
  legendaries: [
    {
      id: 'dawn-blessing',
      name: 'พรแห่งแสงรุ่ง',
      type: 'skill',
      condition: 'ทำความดีและอธิษฐานต่อพระเจ้าต่อเนื่อง 10 วัน',
      counter: 'streak_days',
      target: 10,
    },
  ],
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Parsed once at import, so a broken template fails loudly instead of reaching a game. */
const DEFAULT_SCENARIO: Scenario = deepFreeze(Scenario.parse(template));

/** A fresh, editable copy of the default template. */
export function defaultScenario(): Scenario {
  // Plain JSON data, so a JSON round trip is a full deep copy (and works in the browser build too).
  return JSON.parse(JSON.stringify(DEFAULT_SCENARIO)) as Scenario;
}
