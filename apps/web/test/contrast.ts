// WCAG 2 contrast, ported from the vault's GEN-085 contrast-check.mjs (wiki/brainstorm/Isekai Chronicles - UI Tone v2/).
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

type Pair = readonly [fg: string, bg: string, where: string];

// Text on background, the pairs the screens use (palettes.mjs `textPairs`, GEN-085) + the base components of GEN-087.
export const textPairs: readonly Pair[] = [
  ['--text', '--bg', 'ตัวหนังสือหลัก บนพื้นหน้า'],
  ['--text', '--panel', 'feed สถานที่, status, ปุ่มรอง, toast'],
  ['--text', '--private-bg', 'narration ส่วนตัว'],
  ['--text', '--hit-bg', 'การ์ด "เกิดกับคุณ"'],
  ['--muted', '--bg', 'label รอง บนพื้นหน้า, จอ Astral Spirit, ปุ่ม disabled'],
  ['--muted', '--panel', 'เวลา, label รอง ใน feed, ปุ่ม disabled ในแผง'],
  ['--muted', '--private-bg', 'label "เห็นคนเดียว"'],
  ['--muted', '--hit-bg', '"ไม่รู้ว่าใครทำ" ในการ์ดผลที่โดน'],
  ['--accent', '--bg', 'ลิงก์, ชื่อหน้า, badge เปิดเผย'],
  ['--accent', '--panel', 'ปุ่มรอง (ตัวหนังสือ accent), ชื่อสถานที่, badge เปิดเผย'],
  ['--accent', '--private-bg', 'ลิงก์ในคอลัมน์ส่วนตัว'],
  ['--accent', '--hit-bg', 'ปุ่ม [รับทราบ] ในการ์ดผลที่โดน'],
  ['--on-accent', '--accent', 'ปุ่มหลัก (ส่ง action)'],
  ['--highlight', '--bg', 'ฉายา, ช่วงเวลาปัจจุบัน'],
  ['--highlight', '--panel', 'Rank S/SS, ช่วงเวลาปัจจุบัน'],
  ['--highlight', '--private-bg', 'ของ Rank สูงใน narration'],
  ['--danger', '--bg', 'error ในฟอร์ม, ปุ่มอันตราย'],
  ['--danger', '--panel', 'HP ต่ำ, damage ใน feed, error state, ปุ่มอันตรายในแผง'],
  ['--danger', '--private-bg', 'damage ใน narration'],
  ['--danger', '--hit-bg', 'หัวการ์ดผลที่โดน'],
  ['--success', '--bg', 'toast สำเร็จบนพื้นหน้า'],
  ['--success', '--panel', 'heal, สำเร็จ, toast สำเร็จ'],
  ['--success', '--private-bg', 'สำเร็จใน narration'],
  ['--secret', '--bg', 'ปุ่ม/label "ลับ"'],
  ['--secret', '--panel', 'action ลับในช่อง action, badge ลับ'],
  ['--secret', '--private-bg', 'action ลับของตัวเองในคอลัมน์ส่วนตัว, badge ลับ'],
  ['--card-text', '--card-bg', 'การ์ดเนื้อหายาวใน scenario editor'],
  // GEN-122 หน้า Play แบบแชต (พื้น feed = --bg + จุดดาวจาง ๆ จึงเทียบกับ --bg)
  ['--text', '--bubble-own', 'กล่อง action ของเรา'],
  ['--text', '--bubble-npc', 'กล่องบทพูด NPC'],
  ['--highlight', '--bubble-npc', 'ชื่อ NPC บนกล่อง'],
  ['--muted', '--bubble-own', 'ป้าย "คุณ" / "ลับ" เหนือกล่อง'],
  ['--secret', '--bubble-own', 'ป้าย "ลับ" ในกล่อง action ของเรา'],
  ['--text-soft', '--bg', 'ตัวเอียงบรรยาย / reaction บนพื้น feed'],
  ['--text-soft', '--panel', 'ป้ายผลทอย / ค่าที่เปลี่ยน บนแผง'],
  ['--text-soft', '--bubble-own', 'ข้อความรองในกล่องของเรา'],
  ['--highlight', '--bg', 'ป้ายเหรียญที่ได้ (บนพื้น feed)'],
];

// Non-text UI parts (WCAG 1.4.11, >= 3:1).
export const uiPairs: readonly Pair[] = [
  ['--accent', '--bg', 'focus ring บนพื้นหน้า'],
  ['--accent', '--panel', 'focus ring ในแผง'],
  ['--accent', '--private-bg', 'focus ring ในคอลัมน์ส่วนตัว'],
  ['--accent', '--hit-bg', 'focus ring ในการ์ดผลที่โดน'],
  ['--muted', '--bg', 'ขอบ input / ปุ่ม disabled บนพื้นหน้า'],
  ['--muted', '--panel', 'ขอบ input / ปุ่ม disabled ในแผง'],
  ['--danger', '--panel', 'ขอบ 3px การ์ดผลที่โดน เทียบแผงรอบ ๆ'],
  ['--danger', '--hit-bg', 'ขอบ 3px การ์ดผลที่โดน เทียบพื้นการ์ด'],
  ['--secret', '--panel', 'ขอบ action ลับ / badge ลับ'],
  ['--secret', '--private-bg', 'ขอบ badge ลับในคอลัมน์ส่วนตัว'],
  // --ornament is decoration (exempt from 1.4.11); checked anyway so the thin gold stays visible.
  ['--ornament', '--bg', 'เส้นทอง 1px มุมแผง เทียบพื้นหน้า (ตกแต่ง)'],
  ['--ornament', '--panel', 'เส้นทอง 1px มุมแผง เทียบแผง (ตกแต่ง)'],
  ['--ornament', '--private-bg', 'เส้นทอง 1px มุมคอลัมน์ส่วนตัว (ตกแต่ง)'],
];
