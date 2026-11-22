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
