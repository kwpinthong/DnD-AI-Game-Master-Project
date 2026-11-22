// Thai text of the base components (GEN-087). Public / Secret show as เปิดเผย / ลับ, English only as the tooltip.
export const uiText = {
  loading: 'กำลังดำเนินการ…',
  skeleton: 'กำลังโหลด…',
  visibility: {
    public: { label: 'เปิดเผย', tooltip: 'Public' },
    secret: { label: 'ลับ', tooltip: 'Secret' },
  },
  hit: { title: 'เกิดกับคุณ', unknownActor: 'ไม่รู้ว่าใครทำ', acknowledge: 'รับทราบ' },
  toast: { info: '', success: 'สำเร็จ:', danger: 'ผิดพลาด:', close: 'ปิด' },
  error: { title: 'เกิดข้อผิดพลาด', retry: 'ลองอีกครั้ง' },
} as const;

// Play screen v2 view-model text (GEN-099 contract; screens in GEN-088 / 089).
export const playText = {
  day: (day: number) => `วันที่ ${day}/12`,
  submitted: (count: number, of: number) => `ส่งแล้ว ${count}/${of}`,
  weatherPending: 'อากาศ: รอ GM',
  roll: (d20: number, difficulty: string, outcome: string) => `ทอย d20 = ${d20} · ${difficulty} · ${outcome}`,
  outcome: { success: 'สำเร็จ', failure: 'ล้มเหลว', critical_success: 'สำเร็จงดงาม', critical_failure: 'พลาดอย่างแรง' },
  lock: {
    not_a_player: 'GM ไม่มีตัวละคร',
    exhausted: 'หมดแรง',
    unconscious: 'สลบ',
    resolving: 'กำลังสรุปผล',
    game_ended: 'เกมจบแล้ว',
    traveling: 'กำลังเดินทาง',
    recovering: 'พักฟื้น',
    astral_spirit: 'Astral Spirit',
  },
} as const;
