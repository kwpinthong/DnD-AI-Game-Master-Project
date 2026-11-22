import { describe, expect, it } from 'vitest';
import { checkNarration, containsName } from '../src/gm/check.ts';
import type { NarrationContext } from '../src/gm/context.ts';

/**
 * Q-152: the real-name check of a narration matches a name as a whole word after NFC + trim, so a
 * short name inside a longer Thai word (ลิน in คลินิก) is not a leak, while the name before or after
 * other Thai words with no space (Thai has none) still is.
 */
describe('Q-152 real-name check by whole word', () => {
  it('a short name inside a longer word is not a match', () => {
    expect(containsName('เธอเดินไปคลินิกหัวมุม', 'ลิน')).toBe(false);
    expect(containsName('ร้านคลินิก', 'ลิน')).toBe(false);
    expect(containsName('คืนนี้ดารานับร้อยดวง', 'ดา')).toBe(false);
  });

  it('the name as its own word matches, with or without spaces around it', () => {
    expect(containsName('คุยกับลินแล้ว', 'ลิน')).toBe(true);
    expect(containsName('ลินเดินไปตลาด', 'ลิน')).toBe(true);
    expect(containsName('ทักทาย ลิน ที่ประตู', 'ลิน')).toBe(true);
    expect(containsName('คุยกับดาริน', 'ดาริน')).toBe(true);
    expect(containsName('ดารินยิ้ม', 'ดาริน')).toBe(true);
    expect(containsName('เมฆาวิ่งหนี', 'เมฆา')).toBe(true);
    expect(containsName('พบกับ Lin ที่ท่าเรือ', 'Lin')).toBe(true);
    expect(containsName('Linda waves', 'Lin')).toBe(false);
  });

  it('text and name are compared after NFC and trim', () => {
    // A decomposed name (e + combining acute) is the same name as the composed one after NFC.
    expect(containsName('met Zoé at the gate', 'Zoé')).toBe(true);
    expect(containsName('met Zoé at the gate', 'Zoé')).toBe(true);
    expect(containsName('คุยกับลิน', '  ลิน  ')).toBe(true);
    expect(containsName('คุยกับลิน', '   ')).toBe(false);
  });

  it('checkNarration flags a whole-word name and lets คลินิก through', () => {
    const ctx: NarrationContext = {
      kind: 'gm_narration',
      audience: { player: 'r1' },
      turn: { day: 1, phase: 'EOSORIA', turn: 1 },
      place: { id: 'inn', name: 'โรงเตี๊ยม' },
      cast: [{ ref: 'r1', looks: 'หญิงผ้าคลุมเทา', title: '', self: true, karmaBand: 0 }],
      npcs: [],
      privateLines: false,
      beats: [{ actionId: 'act-1', kind: 'own_action', actor: 'r1', text: 'เดิน', result: 'success', target: null, targetNpc: null, moved: null, items: [] }],
      journal: null,
    };
    const codes = (text: string) => checkNarration(ctx, { segments: [{ actionId: 'act-1', text }], npcLines: [] }, ['ลิน']).map((e) => e.code);
    expect(codes('{{p:r1}} เดินไปคลินิกหัวมุม')).toEqual([]);
    expect(codes('{{p:r1}} เดินไปหาลินที่คลินิก')).toEqual(['name_leak']);
  });
});
