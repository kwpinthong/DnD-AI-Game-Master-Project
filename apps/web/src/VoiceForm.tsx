import { useId, type ReactNode } from 'react';
import { asList, LinesInput, ListInput, problemAt } from './GameDataForm.tsx';

/**
 * GEN-192: the Voice set (one object, GEN-176) as a form: the forbidden rules and each NPC's speech profile. Like
 * GameDataForm it only edits the value in the editor; the server checks the save (a broken regex comes back as a
 * field problem), backs it up, logs it and can undo it. Keys the form does not show (guide, tones, pairs, SS
 * `forms`, register, note, anything new) are kept as they are.
 */

type Obj = Record<string, unknown>;
export type VoiceValue = Obj & { forbidden: Obj[]; npcs: Record<string, Obj> };

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The value as a Voice object, or undefined when it is not one (then only the raw JSON box is shown). */
export function voiceOf(value: unknown): VoiceValue | undefined {
  return isObj(value) && Array.isArray(value.forbidden) && value.forbidden.every(isObj) && isObj(value.npcs) && Object.values(value.npcs).every(isObj)
    ? (value as VoiceValue)
    : undefined;
}

const TYPES = [
  ['literal', 'คำตรงตัว (literal)'],
  ['regex', 'regex'],
  ['density', 'ความถี่คำ (density)'],
] as const;
const SCOPES = ['all', 'narration', 'dialogue'] as const;
const SEVERITIES = ['flag', 'block'] as const;
const BLANK_RULE: Obj = { id: '', match: { type: 'regex', value: '' }, scope: 'all', severity: 'flag', fix: '' };

type Problems = Readonly<Record<string, string>>;

/** One labelled input with the server's problem for `at` under it. */
function Field({ id, label, problems, at, children }: { id: string; label: string; problems: Problems; at: string; children: (aria: object) => ReactNode }) {
  const problem = problemAt(problems, at);
  const errorId = `${id}-problem`;
  return (
    <div className="gdata__field">
      <label htmlFor={id}>{label}</label>
      {children(problem ? { id, 'aria-invalid': true, 'aria-describedby': errorId } : { id })}
      {problem && (
        <p id={errorId} className="gdata__problem">
          {problem}
        </p>
      )}
    </div>
  );
}

function Choice({ value, options, onChange, aria }: { value: unknown; options: readonly (readonly [string, string])[]; onChange: (v: string) => void; aria: object }) {
  const text = typeof value === 'string' ? value : '';
  const all = options.some(([o]) => o === text) ? options : [[text, text] as const, ...options];
  return (
    <select {...aria} value={text} onChange={(e) => onChange(e.target.value)}>
      {all.map(([o, label]) => (
        <option key={o} value={o}>
          {label}
        </option>
      ))}
    </select>
  );
}

const pairs = (options: readonly string[]) => options.map((o) => [o, o] as const);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : '');

function RuleFields({ rule, at, id, problems, onChange }: { rule: Obj; at: string; id: string; problems: Problems; onChange: (rule: Obj) => void }) {
  const match = isObj(rule.match) ? rule.match : {};
  const set = (key: string, value: unknown) => onChange({ ...rule, [key]: value });
  const setMatch = (key: string, value: unknown) => set('match', { ...match, [key]: value });
  const setType = (type: string) =>
    set('match', type === 'density' ? { type, words: [], max: 1, perSentences: 1 } : { type, value: str(match.value) });
  const f = (key: string) => ({ id: `${id}-${key}`, problems, at: `${at}.${key}` });
  return (
    <>
      <Field label="รหัสกฎ (id)" {...f('id')}>
        {(aria) => <input {...aria} value={str(rule.id)} onChange={(e) => set('id', e.target.value)} />}
      </Field>
      <Field label="ชนิดกฎ" {...f('match.type')}>
        {(aria) => <Choice aria={aria} value={match.type} options={TYPES} onChange={setType} />}
      </Field>
      {match.type === 'density' ? (
        <>
          <Field label="คำที่นับ (คั่นด้วย ,)" {...f('match.words')}>
            {(aria) => <ListInput {...aria} value={asList(match.words)} onChange={(v) => setMatch('words', v)} />}
          </Field>
          <Field label="นับได้สูงสุด" {...f('match.max')}>
            {(aria) => <input {...aria} type="number" min={1} value={num(match.max)} onChange={(e) => setMatch('max', Number(e.target.value))} />}
          </Field>
          <Field label="ต่อกี่ประโยค" {...f('match.perSentences')}>
            {(aria) => <input {...aria} type="number" min={1} value={num(match.perSentences)} onChange={(e) => setMatch('perSentences', Number(e.target.value))} />}
          </Field>
        </>
      ) : (
        <Field label="ค่าที่จับ" {...f('match.value')}>
          {(aria) => <input {...aria} value={str(match.value)} onChange={(e) => setMatch('value', e.target.value)} spellCheck={false} />}
        </Field>
      )}
      <Field label="ใช้กับ" {...f('scope')}>
        {(aria) => <Choice aria={aria} value={rule.scope} options={pairs(SCOPES)} onChange={(v) => set('scope', v)} />}
      </Field>
      <Field label="ระดับ" {...f('severity')}>
        {(aria) => <Choice aria={aria} value={rule.severity} options={pairs(SEVERITIES)} onChange={(v) => set('severity', v)} />}
      </Field>
      <Field label="วิธีแก้ (hint)" {...f('fix')}>
        {(aria) => <input {...aria} value={str(rule.fix)} onChange={(e) => set('fix', e.target.value)} />}
      </Field>
    </>
  );
}

function ProfileFields({ profile, at, id, problems, onChange }: { profile: Obj; at: string; id: string; problems: Problems; onChange: (profile: Obj) => void }) {
  const you = isObj(profile.you) ? profile.you : {};
  const set = (key: string, value: unknown) => onChange({ ...profile, [key]: value });
  /** An optional call-name left empty is dropped, not saved as ''. */
  const setYou = (key: string, value: string) => {
    const { [key]: _old, ...rest } = you;
    set('you', value === '' && key !== 'default' ? rest : { ...you, [key]: value });
  };
  const f = (key: string) => ({ id: `${id}-${key}`, problems, at: `${at}.${key}` });
  const list = (key: string, label: string) => (
    <Field label={label} {...f(key)}>
      {(aria) => <ListInput {...aria} value={asList(profile[key])} onChange={(v) => set(key, v)} />}
    </Field>
  );
  const call = (key: string, label: string) => (
    <Field label={label} {...f(`you.${key}`)}>
      {(aria) => <input {...aria} value={str(you[key])} onChange={(e) => setYou(key, e.target.value)} />}
    </Field>
  );
  return (
    <>
      {list('self', 'สรรพนามแทนตัว (คั่นด้วย ,)')}
      {call('default', 'เรียกผู้เล่น')}
      {call('friendly', 'เรียกผู้เล่นเมื่อสนิท')}
      {call('wary', 'เรียกผู้เล่นเมื่อระวังตัว')}
      {list('particles', 'คำลงท้าย (คั่นด้วย ,)')}
      <Field label="คำติดปาก (บรรทัดละ 1)" {...f('catchphrases')}>
        {(aria) => <LinesInput {...(aria as { id: string })} value={asList(profile.catchphrases)} onChange={(v) => set('catchphrases', v)} />}
      </Field>
      {list('neverWords', 'neverWords (คั่นด้วย ,)')}
    </>
  );
}

export function VoiceForm({ value, problems, onChange }: { value: VoiceValue; problems: Problems; onChange: (value: VoiceValue) => void }) {
  const id = useId();
  const rules = value.forbidden;
  const setRules = (forbidden: Obj[]) => onChange({ ...value, forbidden });
  const npcs = Object.entries(value.npcs);
  return (
    <div className="gdata__form">
      <h4>คำต้องห้าม ({rules.length} กฎ)</h4>
      {rules.map((rule, i) => (
        <fieldset key={i} className="gdata__record">
          <legend>
            กฎ {i + 1}: {str(rule.id)}
          </legend>
          <RuleFields rule={rule} at={`forbidden[${i}]`} id={`${id}-r${i}`} problems={problems} onChange={(r) => setRules(rules.map((old, j) => (j === i ? r : old)))} />
          <button type="button" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
            ลบกฎ {i + 1}
          </button>
        </fieldset>
      ))}
      <button type="button" onClick={() => setRules([...rules, structuredClone(BLANK_RULE)])}>
        เพิ่มกฎ
      </button>
      <h4>โปรไฟล์พูด NPC ({npcs.length} ตัว)</h4>
      {npcs.map(([npc, profile]) => (
        <fieldset key={npc} className="gdata__record">
          <legend>NPC {npc}</legend>
          <ProfileFields profile={profile} at={`npcs.${npc}`} id={`${id}-n-${npc}`} problems={problems} onChange={(p) => onChange({ ...value, npcs: { ...value.npcs, [npc]: p } })} />
        </fieldset>
      ))}
    </div>
  );
}
