import { AdminSessionResponse, StyleFlagsResponse, StyleSettingsResponse } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { voiceFormOf, type VoiceForm } from '../src/assets/voice.ts';
import { loadWorld } from '../src/gm/context.ts';
import { npcPrompt } from '../src/gm/npc-lines.ts';
import { gateStyle, getStyleSettings, recordStyleFlags, setStyleSettings, styleIssues } from '../src/gm/style-check.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, type Call } from './visibility-fixture.ts';

// GEN-169: the server's style checker (no AI cost): forbidden phrases of the Voice set + an NPC's pronouns.

/** A throwaway admin code for this test only. */
const ADMIN_CODE = 'ทดสอบ-ตรวจสำนวน-169';

/** GEN-166 section 0, tone A sample, and the guide's good examples. */
const GOOD_NARRATION = [
  'แสงสุดท้ายของ HESPERION ทาบลงบนขอบน้ำพุ คุณยื่นขนมปังให้เด็กขอทาน มือผอมสั่นรับไว้ ก่อนแบ่งครึ่งคืนให้คุณอย่างลังเล',
  'ชาวบ้านเริ่มมองคุณด้วยสายตาอ่อนลง หลังเห็นคุณช่วยเด็ก',
];

describe('style checker (GEN-169)', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer;
  let call: Call;

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(dir, 'isekai.sqlite'), createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null },
    );
    call = caller(server);
  });

  afterEach(async () => {
    await server.close();
    cleanup();
  });

  const voice = () => server.assets.voice;
  const reasons = (text: string, scope: 'narration' | 'dialogue', npcId: string | null = null) => styleIssues(voice(), text, scope, npcId).map((i) => i.reason);

  it('C1: forbidden words over the threshold are flagged; at the threshold they are not', () => {
    expect(reasons('เขาได้ทำการเปิดประตูออก', 'narration')).toContain('dai_tham_kan');
    // pronoun_repeat: at most 1 เขา / เธอ in 2 sentences in a row.
    expect(reasons('เธอหันมา เธอยิ้ม แล้วเธอก็เดินจากไป', 'narration')).toContain('pronoun_repeat');
    expect(reasons('เธอหันมายิ้ม แล้วเดินจากไป', 'narration')).not.toContain('pronoun_repeat');
    expect(reasons('ชายคนนั้นมีความโกรธเป็นอย่างมาก', 'narration')).toEqual(expect.arrayContaining(['mee_khwam', 'intensifier']));
    // A narration-only rule does not apply to dialogue.
    expect(reasons('โอเค ไปกัน', 'narration')).toContain('loanword');
    expect(reasons('โอเค ไปกัน', 'dialogue', 'cloaked-man')).not.toContain('loanword');
    expect(styleIssues(voice(), '**ประตู**เปิด', 'narration').find((i) => i.reason === 'emoji_markdown')?.severity).toBe('block');
  });

  it('C2: the archbishop (พ่อ / ลูก) saying ผม is a pronoun mismatch; his own pronoun is not', () => {
    expect(reasons('ผมจะช่วยเจ้าเอง', 'dialogue', 'archbishop')).toContain('pronoun_mismatch');
    expect(reasons('จงรับความเมตตานี้ไว้เถิดลูก พ่อจะสวดให้', 'dialogue', 'archbishop')).not.toContain('pronoun_mismatch');
    // The guard (ข้า) says ข้าน้อย: another NPC's pronoun.
    expect(reasons('ข้าน้อยไม่รู้', 'dialogue', 'guard')).toContain('pronoun_mismatch');
    expect(reasons('ข้าไม่รู้ หยุดตรงนั้น', 'dialogue', 'guard')).toEqual([]);
    // A word the profile never says (the guard never says ครับ).
    expect(reasons('หยุดตรงนั้นครับ', 'dialogue', 'guard')).toContain('never_word');
    const issue = styleIssues(voice(), 'ผมจะช่วย', 'dialogue', 'archbishop').find((i) => i.reason === 'pronoun_mismatch');
    expect(issue).toMatchObject({ npcId: 'archbishop', severity: 'flag' });
  });

  it('C4: the guide good examples, the tone A sample and every NPC catchphrase get no flag', () => {
    for (const { good } of voice().pairs) expect(reasons(good, 'narration'), good).toEqual([]);
    for (const text of GOOD_NARRATION) expect(reasons(text, 'narration'), text).toEqual([]);
    for (const [id, profile] of Object.entries(voice().npcs)) {
      for (const line of profile.catchphrases) expect(reasons(line, 'dialogue', id), `${id}: ${line}`).toEqual([]);
    }
    // The bad examples all are flagged.
    for (const { bad } of voice().pairs) expect(reasons(bad, 'narration').length, bad).toBeGreaterThan(0);
  });

  it('C3: with the rewrite setting on, a block hit asks the AI once; still failing → the original goes out', async () => {
    const db = server.orm;
    const original = { text: 'เขาได้ทำการเปิดประตู' };
    const issuesOf = (v: { text: string }) => styleIssues(voice(), v.text, 'narration');
    let asked = 0;

    // Off (the default): flag only, no rewrite.
    expect(getStyleSettings(db).rewrite).toBe(false);
    const off = await gateStyle({ db, value: original, issuesOf, timeoutMs: 1_000, rewrite: async () => (asked++, { text: 'เขาผลักประตูเปิด' }) });
    expect(off).toMatchObject({ value: original, rewritten: false });
    expect(asked).toBe(0);

    setStyleSettings(db, { rewrite: true });
    const fixed = await gateStyle({ db, value: original, issuesOf, timeoutMs: 1_000, rewrite: async () => (asked++, { text: 'เขาผลักประตูเปิด' }) });
    expect(fixed).toMatchObject({ value: { text: 'เขาผลักประตูเปิด' }, rewritten: true });
    expect(asked).toBe(1);

    const still = await gateStyle({ db, value: original, issuesOf, timeoutMs: 1_000, rewrite: async () => (asked++, { text: 'เขาทำการผลักประตู' }) });
    expect(still).toMatchObject({ value: original, rewritten: false });
    expect(asked).toBe(2);

    // A rewrite that hangs is cut at the time budget and the original goes out.
    const started = performance.now();
    const hung = await gateStyle({ db, value: original, issuesOf, timeoutMs: 200, rewrite: () => new Promise<{ text: string } | undefined>((resolve) => setTimeout(() => resolve({ text: 'ช้าไป' }), 10_000)) });
    expect(hung.value).toEqual(original);
    expect(performance.now() - started).toBeLessThan(2_000);

    // A flag-only hit never asks for a rewrite.
    const flagOnly = await gateStyle({ db, value: { text: 'ชายคนนั้นมีความโกรธ' }, issuesOf, timeoutMs: 1_000, rewrite: async () => (asked++, undefined) });
    expect(flagOnly.rewritten).toBe(false);
    expect(asked).toBe(2);
  });

  it('C5: the admin sees flag counts per NPC per reason, and can switch the rewrite setting', async () => {
    recordStyleFlags(server.orm, [
      ...styleIssues(voice(), 'ผมจะช่วย', 'dialogue', 'archbishop'),
      ...styleIssues(voice(), 'ผมจะช่วยอีก', 'dialogue', 'archbishop'),
      ...styleIssues(voice(), 'เขาได้ทำการเปิดประตู', 'narration'),
    ]);
    const token = AdminSessionResponse.parse((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body).token;
    expect((await call('GET', '/api/admin/style-flags')).status).toBe(403);
    const res = await call('GET', '/api/admin/style-flags', { token });
    expect(res.status).toBe(200);
    const { stats } = StyleFlagsResponse.parse(res.body);
    expect(stats).toEqual(
      expect.arrayContaining([
        { npc: { id: 'archbishop', alias: 'นักบวชผู้ใจบุญประจำเมือง' }, reason: 'pronoun_mismatch', count: 2 },
        { npc: null, reason: 'dai_tham_kan', count: 1 },
      ]),
    );
    // No real NPC name in what the admin page shows.
    expect(JSON.stringify(res.body)).not.toContain('มัลคอล์ม');

    expect(StyleSettingsResponse.parse((await call('GET', '/api/admin/style-settings', { token })).body).settings.rewrite).toBe(false);
    const put = await call('PUT', '/api/admin/style-settings', { token, body: { rewrite: true } });
    expect(put.status).toBe(200);
    expect(StyleSettingsResponse.parse(put.body).settings.rewrite).toBe(true);
    expect(getStyleSettings(server.orm).rewrite).toBe(true);
    expect((await call('PUT', '/api/admin/style-settings', { token, body: { rewrite: 'yes' } })).status).toBe(400);
    expect((await call('PUT', '/api/admin/style-settings', { body: { rewrite: true } })).status).toBe(403);
  });

  // GEN-193: the form an NPC speaks in comes from the player's evolution (npc_bond), not "any of its forms".
  const ssGood = voiceFormOf({ evolvedGrade: 'SS', evolvedAlignment: 'Good' });
  const reasonsIn = (text: string, npcId: string, form: VoiceForm | null) => styleIssues(voice(), text, 'dialogue', npcId, form).map((i) => i.reason);

  it('GEN-193 C1: an NPC in its SS form using its normal-form pronoun is a pronoun mismatch', () => {
    expect(ssGood).toBe('ss_good');
    expect(reasonsIn('ผมจะช่วยท่านเอง', 'beggar', ssGood)).toContain('pronoun_mismatch');
    expect(reasonsIn('เราจะช่วยท่านเอง', 'beggar', ssGood)).not.toContain('pronoun_mismatch');
    // The rewrite hint names the form's pronoun.
    expect(styleIssues(voice(), 'ผมจะช่วย', 'dialogue', 'beggar', ssGood).find((i) => i.reason === 'pronoun_mismatch')?.fix).toContain('เรา');
    // An SS form the NPC has no profile for (the amnesiac evolved on a Good path) is its plain SS form.
    const amnesiacSs = voiceFormOf({ evolvedGrade: 'SS', evolvedAlignment: 'Good' });
    expect(reasonsIn('ข้ายังจำได้', 'amnesiac', amnesiacSs)).not.toContain('pronoun_mismatch');
    expect(reasonsIn('ข้ายังจำได้', 'amnesiac', null)).toContain('pronoun_mismatch');
    expect(voiceFormOf({ evolvedGrade: 'SS', evolvedAlignment: null })).toBe('ss');
  });

  it('GEN-193 C2: an NPC in its normal form is checked against its main profile only', () => {
    for (const bond of [undefined, { evolvedGrade: null, evolvedAlignment: null }, { evolvedGrade: 'S' as const, evolvedAlignment: null }]) expect(voiceFormOf(bond)).toBeNull();
    expect(reasonsIn('เราจะช่วยท่านเอง', 'beggar', null)).toContain('pronoun_mismatch');
    expect(reasonsIn('ผมจะช่วยพี่เองครับ', 'beggar', null)).not.toContain('pronoun_mismatch');
  });

  it('GEN-193: the dialogue prompt carries the speech profile of the form each player sees', async () => {
    const t = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    const world = loadWorld(server.orm, gameId, server.assets);
    const beggar = world.npcs.filter((n) => n.id === 'beggar');
    const evolve = server.db.prepare("insert into npc_bond (member_id, npc_id, updated_at, evolved_grade, evolved_alignment) values (?, 'beggar', 0, 'SS', 'Good')");
    evolve.run(t.a.memberId);
    const view = (members: string[]) => npcPrompt(server.orm, server.assets, world, beggar, new Set(['beggar']), members)[0]!;
    expect(view([t.a.memberId])).toMatchObject({ form: 'ss_good', voice: { self: ['เรา'], you: { default: 'ท่าน' }, note: voice().npcs.beggar!.note } });
    expect(view([t.b.memberId])).toMatchObject({ form: null, voice: { self: ['ผม'] } });
    // Players who see different forms in one scene: no form is assumed (the checker accepts any of them).
    expect(view([t.a.memberId, t.b.memberId]).form).toBeUndefined();
    // The checker's word list and the other forms stay out of the prompt.
    expect(JSON.stringify(view([t.a.memberId]))).not.toMatch(/neverWords|forms/);
  });
});
