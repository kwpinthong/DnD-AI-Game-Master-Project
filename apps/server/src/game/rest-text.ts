/**
 * GEN-113: an action text that is only the player's own rest ("นอน", "พักผ่อน", "งีบสักพัก", "rest") is a REST,
 * decided here so the mock and the real AI GM follow the same REST rules (inn 5 coins, Rest_Quality, Q-235..237).
 * shortcut: the whole text must be a rest verb + an optional short tail ("สักพัก", "ที่โรงเตี๊ยม", "a bit"), so an
 * action on someone else ("หลอกให้ยามนอนหลับ", "put the guard to sleep") never matches; longer or mixed texts
 * ("พักแล้วค่อยออกไปล่า") stay normal actions until a real intent parser replaces this.
 */
const VERB = '(?:พักผ่อน|พัก|เข้านอน|นอนหลับ|นอน|งีบ|rest|sleep|nap)';
// GEN-159: "ที่<place>" is any one word, cut at a word that starts another action ("พักที่โรงเตี๊ยมแล้วออกไปล่า").
const AT_PLACE = 'ที่(?:(?!แล้ว|ค่อย|และ|จากนั้น|ไป|ไม่)\\S)*';
const TAIL = `(?:สัก(?:พัก|ครู่|หน่อย|งีบ)|หน่อย|ก่อน|${AT_PLACE}|ใน(?:ห้อง|ป่า|โรงเตี๊ยม)|here|a (?:bit|while)|for a (?:bit|while)|at the inn)`;
// GEN-159: the rest button fills "พัก"; the player may type more rest after it ("พัก นอนที่โรงเตี๊ยม").
const REST = `${VERB}(?:\\s*${TAIL})*`;
const OWN_REST = new RegExp(`^(?:(?:ขอ|จะ|ไป|ฉัน|ผม|หนู|i(?:'ll| will)?|let me|i want to|i'd like to)\\s*)?${REST}(?:\\s+${REST})*$`, 'i');

export function isOwnRestText(text: string): boolean {
  return OWN_REST.test(text.trim().replace(/[\s!.。~ๆ]+$/u, ''));
}
