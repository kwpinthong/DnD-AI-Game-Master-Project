import { Scenario, type ScenarioInput } from './scenario.ts';

/*
 * Default scenario "เมืองก่อนอุกกาบาต" (GEN-071). The sheet "Asset Isekai v1.0" is the source of truth
 * (Nok 2026-11-22): the timeline is its World_Timeline tab, the roster its NPC tab, and every place
 * is a row of its Location tab by name (Q-129). apps/server/test/scenario-sheet.test.ts checks this
 * file against the imported JSON in apps/server/assets, so a sheet change shows up as a failing test.
 * Social titles, origin weights and the Legendary still come from the GDD + GEN-042 Rules Spec.
 * Games without a Human GM use this template only (Q-028).
 *
 * PLACEHOLDER marks what the sheet does not give (ids, the town's name, where pocket escape lands).
 */
const template: ScenarioInput = {
  schemaVersion: 1,
  id: 'default',
  name: 'เมืองก่อนอุกกาบาต', // GEN-044 wireframe
  town: {
    name: 'เมืองก่อนอุกกาบาต', // PLACEHOLDER: the sheet names no town
    mood: 'เมืองแฟนตาซีที่ลัทธิค่อย ๆ แทรกซึม เหลือเวลา 12 วันก่อนอุกกาบาตหมูเด้งพุ่งชนโลก',
    taboos: [],
  },
  // Sheet Location tab, by Location_Name. `connects` = Connects_To (same-zone places plus the special links
  // โบสถ์ ↔ ชั้นใต้ดิน and หอสมุด ↔ มิติพิศวง; cross-zone travel follows System_Rules), `safety` = Safety,
  // `restQuality` = Rest_Quality (Q-161). The first place is where players start.
  locations: [
    {
      id: 'inn',
      name: 'โรงเตี๊ยมและกิลด์นักเดินทาง',
      restQuality: 'good',
      safety: 'safe',
      connects: ['fountain', 'temple'],
      description: 'โซนใจกลางเมือง ที่พักและจุดรับงานของนักเดินทาง',
    },
    {
      id: 'fountain',
      name: 'น้ำพุกลางเมือง',
      restQuality: 'normal',
      safety: 'normal',
      connects: ['inn', 'temple'],
      description: 'โซนใจกลางเมือง ลานกลางแจ้งที่ชาวเมืองมารวมตัวกัน',
    },
    {
      id: 'temple',
      name: 'โบสถ์',
      restQuality: 'normal',
      safety: 'normal',
      connects: ['fountain', 'inn', 'church-crypt'],
      description: 'โซนใจกลางเมือง โบสถ์ของเมือง',
    },
    {
      id: 'church-crypt',
      name: 'โบสถ์ (ชั้นใต้ดิน)',
      restQuality: 'poor',
      safety: 'restricted',
      connects: ['temple'],
      description: 'โซนใจกลางเมือง ชั้นใต้ดินของโบสถ์ เขตหวงห้าม',
    },
    {
      id: 'forest',
      name: 'ป่า',
      restQuality: 'poor',
      safety: 'danger',
      connects: ['farmland', 'theater', 'manor'],
      description: 'โซนป่าทิศตะวันออก',
    },
    {
      id: 'farmland',
      name: 'แปลงเกษตรกรรม',
      restQuality: 'normal',
      safety: 'normal',
      connects: ['forest', 'theater', 'manor'],
      description: 'โซนป่าทิศตะวันออก',
    },
    {
      id: 'theater',
      name: 'โรงละคร',
      restQuality: 'normal',
      safety: 'normal',
      connects: ['forest', 'farmland', 'manor'],
      description: 'โซนป่าทิศตะวันออก',
    },
    {
      id: 'manor',
      name: 'เคหาสน์เจ้าเมือง',
      restQuality: 'normal',
      safety: 'restricted',
      connects: ['forest', 'farmland', 'theater'],
      description: 'โซนป่าทิศตะวันออก เขตหวงห้าม',
    },
    {
      id: 'market',
      name: 'ย่านการค้า-ตลาดมืด',
      restQuality: 'normal',
      safety: 'normal',
      connects: ['barracks', 'sea'],
      description: 'โซนการค้าทิศตะวันตก ตลาดและตรอกหลังร้าน',
    },
    {
      id: 'barracks',
      name: 'ค่ายทหารป้องกันเมือง',
      restQuality: 'normal',
      safety: 'restricted',
      connects: ['market', 'sea'],
      description: 'โซนการค้าทิศตะวันตก เขตหวงห้าม',
    },
    {
      id: 'sea',
      name: 'ทะเล',
      restQuality: 'poor',
      safety: 'danger',
      connects: ['market', 'barracks'],
      description: 'โซนการค้าทิศตะวันตก ชายฝั่งและหน้าผาหิน',
    },
    {
      id: 'dawn-church',
      name: 'โบสถ์แห่งรุ่งอรุณ',
      restQuality: 'normal',
      safety: 'normal',
      connects: ['clinic', 'library'],
      description: 'โซนที่ราบทิศเหนือ',
    },
    {
      id: 'clinic',
      name: 'สถานพยาบาลกลาง',
      restQuality: 'excellent',
      safety: 'safe',
      connects: ['dawn-church', 'library'],
      description: 'โซนที่ราบทิศเหนือ ที่รักษาคนเจ็บของเมือง',
    },
    {
      id: 'library',
      name: 'หอสมุดหลวง',
      restQuality: 'normal',
      safety: 'normal',
      connects: ['dawn-church', 'clinic', 'astral-rift'],
      description: 'โซนที่ราบทิศเหนือ',
    },
    {
      id: 'astral-rift',
      name: 'มิติพิศวง (The Astral Rift)',
      restQuality: 'normal',
      safety: 'safe',
      connects: ['library'],
      description: 'รูทลับ 1% เข้าออกผ่านหอสมุดหลวงเท่านั้น',
    },
  ],
  // Sheet NPC tab: every row, by its starting grade. SS forms are not here: they only evolve (GDD §5).
  // `name` is the real name; grade B keeps it hidden behind `alias` until affinity +9. `alias` = the sheet's
  // Public_Alias (Q-161): what players see before they learn the truth, with no spoilers.
  npcs: [
    { id: 'beggar', name: 'โนอา', alias: 'โนอา — เด็กขอทานตาบอดข้างหนึ่ง', rank: 'F', locationId: 'fountain' },
    { id: 'amnesiac', name: 'ลูเซีย', alias: 'ลูเซีย — หญิงสาวผู้พกนาฬิกาพกตาย', rank: 'F', locationId: 'fountain' },
    { id: 'nun', name: 'ซิสเตอร์เอเลน่า', alias: 'แม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่า', rank: 'B', locationId: 'temple' },
    { id: 'guard', name: 'จ่าสิบเอกการ์เร็ต', otherNames: ['การ์เร็ต'], alias: 'ทหารยามหน้าตาบึ้งตึง', rank: 'B', locationId: 'barracks' },
    { id: 'cloaked-man', name: 'วิคเตอร์', alias: 'ชายชุดคลุมมอมแมมในตรอกมืด', rank: 'B', locationId: 'market' },
    { id: 'merchant', name: 'มาร์คัส', alias: 'พ่อค้าเร่ผู้สวมแว่นหนา', rank: 'B', locationId: 'market' },
    {
      id: 'noble',
      name: 'ลอร์ดจูเลียน แวนเดอร์บิลต์',
      otherNames: ['ลอร์ดจูเลียน', 'จูเลียน'],
      alias: 'ลอร์ดจูเลียน แวนเดอร์บิลต์ (ขุนนางผู้มาเยือน)',
      rank: 'A',
      locationId: 'manor',
    },
    {
      id: 'archbishop',
      name: 'อาร์คบิชอป มัลคอล์ม',
      otherNames: ['มัลคอล์ม'],
      alias: 'อาร์คบิชอป มัลคอล์ม (นักบวชผู้ใจบุญประจำเมือง)',
      rank: 'A',
      locationId: 'temple',
      gmNote: 'ผู้นำนักบวชลัทธิประจำเมือง',
    },
    { id: 'archivist', name: 'เลดี้เซเรน่า', otherNames: ['เซเรน่า'], alias: 'เลดี้เซเรน่า แห่งหอจดหมายเหตุ', rank: 'A', locationId: 'library' },
    { id: 'light-spirit', name: 'ออเรเลีย', alias: 'ภูตแห่งแสงในแท่นบูชา', rank: 'S', locationId: 'dawn-church' },
    { id: 'dark-spirit', name: 'น็อกทิส', alias: 'เงาในรอยแยกใต้แท่นพิธี', rank: 'S', locationId: 'church-crypt' },
    { id: 'horizon-watcher', name: 'แอสทรา', alias: 'ผู้เฝ้ามองเส้นขอบฟ้า', rank: 'S', locationId: 'sea' },
  ],
  // Sheet World_Timeline tab, word for word: Event_Name = title, Player_Intervention_Effects =
  // interventionEffects, World_Drift_If_Ignored = outcome (what happens if nobody steps in),
  // Foreshadowing = foreshadowing at its Foreshadowing_Trigger morning. Town-wide events have no place
  // (Q-080); an event the sheet puts in two places uses the first one that is a Location.
  timeline: [
    {
      id: 'd1-bread',
      day: 1,
      phase: 'EOSORIA',
      title: 'พิธีแจกขนมปังแห่งความเมตตา',
      interventionEffects:
        'Good: ช่วยซิสเตอร์เอเลน่าเปิดโปงหรือแจก Blessed Loaf แข่ง / Evil: ช่วยมัลคอล์มแจกขนมปังต้องสาปหรือผสม Vial of Black Ash',
      outcome: 'ชาวเมืองติดคำสาปจำนวนมาก ฐานมวลชนลัทธิในเมืองเพิ่มขึ้น +30% ส่งผลให้วันที่ 7 และ 10 รับมือยากขึ้น',
      // "Starts at once": the day 1 morning itself, so no earlier trigger.
      foreshadowing: 'เริ่มต้นแคมเปญทันที (ป้ายประกาศเชิญชวนร่วมพิธีแจกทาน)',
      locationId: 'fountain',
      npcIds: ['nun', 'archbishop'],
    },
    {
      id: 'd5-disaster',
      day: 5,
      phase: 'EOSORIA',
      title: 'ภัยพิบัติหมอกพิษปิดเมือง',
      interventionEffects: 'Good/Neutral: อพยพชาวนาและขนสมุนไพรเข้าสถานพยาบาล / Evil: กักตุนเสบียงปั่นราคาตลาดมืดหรือลอบสังหารในหมอก',
      outcome: 'ป่าและชายฝั่งถูกหมอกพิษปิดตาย (ฝืนเข้าเสีย Stamina -10/เทิร์น) ราคาอาหารและยาแพงขึ้น 2 เท่าตลอดวันที่ 5–9',
      foreshadowing: 'เช้าวันที่ 4: ข่าวลือสัตว์ป่าอพยพหนีออกจากป่าทิศตะวันออก',
      foreshadowAt: { day: 4, phase: 'EOSORIA' },
      crisis: true,
      locationId: null, // ทั่วทั้งเมือง / ป่า / ชายฝั่ง
    },
    {
      id: 'd7-kidnapping',
      day: 7,
      phase: 'HESPERION',
      title: 'คืนแห่งการลักพาตัวเงียบ',
      interventionEffects:
        'Good: ร่วมมือกับลอร์ดจูเลียนและการ์เร็ตสกัดจับขบวนลักพาตัว (ปลดล็อกเลื่อนเกรดจูเลียนเป็น S) / Evil: ร่วมมือกับมัลคอล์มและน็อกทิสจับเครื่องสังเวยครบจำนวน',
      outcome: 'ลัทธิได้เครื่องสังเวยครบ พิธีกรรมวันที่ 10 รับบัพเต็มขั้น (ความยากในการขัดขวาง +5) และจูเลียนบาดเจ็บหนัก',
      foreshadowing: 'เช้าวันที่ 6: ประกาศเตือนคนหายปริศนาในตรอกเมือง',
      foreshadowAt: { day: 6, phase: 'EOSORIA' },
      crisis: true,
      locationId: 'temple', // ย่านชุมชน & โบสถ์
      npcIds: ['noble', 'guard', 'archbishop', 'dark-spirit'],
    },
    {
      id: 'd10-summoning',
      day: 10,
      phase: 'NOCTHERION',
      kind: 'climax',
      title: 'คืนจันทราโลหิต (สงครามความเชื่อ)',
      interventionEffects:
        'ตัดสินตามแผนการในแท็บ Day10_Strategies (Holy Crusade, Silent Rescue, Crimson Offering, หรือ Absolute Zero Law ลบล้างเวทมนตร์ทั้งหมด)',
      // Same as the Day10_Strategies D10-DRIFT row: no plan run, or every plan failed.
      outcome: 'ลัทธิอัญเชิญเทพมารจันทราโลหิตสำเร็จ เมืองตกอยู่ใต้ความมืดมิดตลอด 2 วันสุดท้าย (ฝ่าย Good ติดดีบัพหนัก)',
      foreshadowing: 'เช้าวันที่ 9: ดวงจันทร์เริ่มเปลี่ยนเป็นสีแดงฉานและลัทธิระดมพล',
      foreshadowAt: { day: 9, phase: 'EOSORIA' },
      strategyIds: ['D10-S1', 'D10-S2', 'D10-S3', 'D10-S4'],
      crisis: true,
      locationId: 'temple', // โบสถ์ / น้ำพุกลางเมือง
      npcIds: ['archbishop', 'dark-spirit'],
    },
    {
      id: 'd12-meteor',
      day: 12,
      phase: 'HESPERION',
      endPhase: 'NOCTHERION',
      kind: 'finale',
      title: 'วันพิพากษา: อุกกาบาตหมูเด้งจุติ',
      interventionEffects:
        'Good: สร้างม่านปาฏิหาริย์เบี่ยงวิถีอุกกาบาตปกป้องเมือง / Evil: ดูดซับพลังอุกกาบาตครองโลก / Neutral: ร่วมกับแอสทราและเซเรน่าลบล้างผลกระทบเป็นศูนย์',
      outcome:
        'อุกกาบาตหมูเด้งพุ่งชนเมือง! ผู้เล่นที่ไม่มีบัพป้องกันระดับสูงหรือไม่อยู่ในจุดหลบภัยจะพ่ายแพ้ (Bad Ending) เหลือรอดเฉพาะผู้ถือบัพ S/SS',
      foreshadowing: 'เช้าวันที่ 11: ท้องฟ้าเปลี่ยนเป็นสีม่วงอมชมพูและเกิดเสียงคำรามบนชั้นบรรยากาศ',
      foreshadowAt: { day: 11, phase: 'EOSORIA' },
      locationId: null, // ท้องฟ้าเหนือเมือง / โบสถ์แห่งรุ่งอรุณ / ทะเล
      npcIds: ['horizon-watcher', 'archivist'],
    },
  ],
  // GDD §6.1 / Rules Spec §11: d100 1-70 standard, 71-99 special, 100 the secret route (the Astral Rift; the
  // Pocket Dimension is cut, Q-093 / Q-101). Spawn points are the sheet Start_Scenarios rows of each tier, by
  // name (`label` = Start_Scenarios Name): the server takes each row's Rate and starting stats from there.
  origins: [
    {
      id: 'standard',
      kind: 'standard',
      label: 'จุดเกิดมาตรฐาน',
      weight: 70,
      spawnPoints: [
        { id: 'busker', label: 'นักดนตรีพเนจรตกอับ', locationId: 'fountain' },
        { id: 'dishwasher', label: 'ลูกมือล้างจานประจำร้าน', locationId: 'inn' },
        { id: 'candle-orphan', label: 'เด็กกำพร้าผู้เฝ้าเชิงเทียน', locationId: 'temple' },
        { id: 'slime-survivor', label: 'ผู้รอดชีวิตจากท้องสไลม์', locationId: 'forest' },
        { id: 'farmhand', label: 'คนงานรับจ้างต่างถิ่น', locationId: 'farmland' },
        { id: 'extra', label: 'ตัวประกอบละครเวที', locationId: 'theater' },
        { id: 'new-thief', label: 'หัวขโมยหน้าใหม่หลังตรอก', locationId: 'market' },
        { id: 'shipwreck', label: 'ผู้รอดชีวิตจากเรืออับปาง', locationId: 'sea' },
        { id: 'stargazer', label: 'ผู้ดูแลหอดูดาวร้าง', locationId: 'dawn-church' },
        { id: 'amnesiac-patient', label: 'คนไข้ความจำเสื่อม', locationId: 'clinic' },
      ],
    },
    {
      id: 'special',
      kind: 'special',
      label: 'จุดเกิดพิเศษ',
      weight: 29,
      spawnPoints: [
        { id: 'sickly-heir', label: 'คุณชาย/คุณหนูขี้โรค', locationId: 'manor' },
        { id: 'conscript', label: 'ทหารเกณฑ์ประจำป้อม', locationId: 'barracks' },
        { id: 'archive-assistant', label: 'ผู้ช่วยบรรณารักษ์เขตต้องห้าม', locationId: 'library' },
        { id: 'heretic-apprentice', label: 'ศิษย์ฝึกหัดนอกรีต', locationId: 'church-crypt' },
      ],
    },
    {
      id: 'secret',
      kind: 'secret',
      label: 'รูทลับ',
      weight: 1,
      spawnPoints: [{ id: 'astral-drifter', label: 'ผู้หลงทางเหนือกาลเวลา', locationId: 'astral-rift' }],
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
