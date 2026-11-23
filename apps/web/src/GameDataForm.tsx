import { ASSET_ALIGNMENTS as ALIGNMENTS, ASSET_PERIODS as PERIODS, ASSET_RANKS as RANKS, ASSET_WEATHERS as WEATHERS } from '@isekai/protocol';
import { useEffect, useId, useState, type InputHTMLAttributes } from 'react';

/**
 * GEN-172: NPC_Schedule and NPC as a form, one record and one field at a time, instead of raw JSON. The form only
 * edits the rows in the editor; saving, the schema check, backup, audit and undo stay the server's (the same PUT).
 * Columns the form does not show (`extra`, anything new) are kept as they are.
 */

type Row = Record<string, unknown>;
type Field =
  | { key: string; label: string; kind: 'text' | 'long' | 'list' }
  | { key: string; label: string; kind: 'choice' | 'set'; options: readonly string[]; hint?: string };


interface FormSet {
  fields: readonly Field[];
  blank: Row;
  title: (row: Row) => string;
}

export const FORM_SETS: Readonly<Record<string, FormSet>> = {
  NPC_Schedule: {
    fields: [
      { key: 'npc', label: 'NPC', kind: 'text' },
      { key: 'location', label: 'สถานที่', kind: 'text' },
      { key: 'periods', label: 'ช่วงเวลา', kind: 'set', options: PERIODS, hint: 'ไม่เลือก = ทุกช่วง' },
      { key: 'weathers', label: 'อากาศ', kind: 'set', options: WEATHERS, hint: 'ไม่เลือก = ทุกอากาศ' },
      { key: 'condition', label: 'เงื่อนไข', kind: 'text' },
      { key: 'note', label: 'หมายเหตุ', kind: 'text' },
    ],
    blank: { npc: '', location: '', periods: [], weathers: [], condition: '', note: '' },
    title: (r) => `${String(r.npc ?? '')} @ ${String(r.location ?? '')}`,
  },
  NPC: {
    fields: [
      { key: 'name', label: 'ชื่อ / สถานะเริ่มต้น', kind: 'text' },
      { key: 'grade', label: 'Grade', kind: 'choice', options: RANKS },
      { key: 'alignments', label: 'Alignment', kind: 'set', options: ALIGNMENTS },
      { key: 'aliases', label: 'ชื่อเรียกสั้น (คั่นด้วย ,)', kind: 'list' },
      { key: 'publicAlias', label: 'ชื่อที่ผู้เล่นเห็น (Public_Alias)', kind: 'text' },
      { key: 'farewell', label: 'คำลา (Farewell)', kind: 'text' },
      { key: 'trueName', label: 'ชื่อจริง', kind: 'text' },
      { key: 'lore', label: 'Lore', kind: 'long' },
      // GEN-165: what the AI reads instead of Lore (names stay Thai); empty = the AI reads the Thai Lore.
      { key: 'loreEn', label: 'Lore ภาษาอังกฤษ (AI อ่าน ผู้เล่นไม่เห็น ชื่อคงเป็นไทย)', kind: 'long' },
      { key: 'unlockCondition', label: 'เงื่อนไขปลดล็อก', kind: 'long' },
      { key: 'rewards', label: 'รางวัล', kind: 'long' },
      { key: 'matchVerbTags', label: 'Verb tags (คั่นด้วย ,)', kind: 'list' },
      { key: 'matchTargetTags', label: 'Target tags (คั่นด้วย ,)', kind: 'list' },
      { key: 'note', label: 'หมายเหตุ', kind: 'long' },
    ],
    blank: {
      grade: 'F',
      alignments: [],
      name: '',
      aliases: [],
      trueName: '',
      lore: '',
      unlockCondition: '',
      rewards: '',
      matchVerbTags: [],
      matchTargetTags: [],
      publicAlias: '',
      farewell: '',
      note: '',
    },
    title: (r) => String(r.name ?? ''),
  },
};

export const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const parseList = (text: string, sep = ',') => text.split(sep).map((s) => s.trim()).filter(Boolean);

/** The server's problems at `at` and below it ("[1].periods" takes "[1].periods[0]"). */
export function problemAt(fields: Readonly<Record<string, string>>, at: string): string | undefined {
  const found = Object.entries(fields).filter(([path]) => path === at || path.startsWith(`${at}[`) || path.startsWith(`${at}.`));
  return found.length > 0 ? found.map(([path, message]) => `${path}: ${message}`).join('; ') : undefined;
}

/** A comma list typed as text: the draft keeps what is typed ("a, "), the row gets the parsed list. */
export function ListInput({ value, onChange, ...input }: { value: string[]; onChange: (v: string[]) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value.join(', '));
  useEffect(() => {
    if (JSON.stringify(parseList(draft)) !== JSON.stringify(value)) setDraft(value.join(', '));
  }, [value]);
  return (
    <input
      {...input}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}

/** GEN-192: a list one item per line (items that may hold a comma, e.g. catchphrases). */
export function LinesInput({ value, onChange, ...input }: { value: string[]; onChange: (v: string[]) => void; id: string }) {
  const [draft, setDraft] = useState(value.join('\n'));
  useEffect(() => {
    if (JSON.stringify(parseList(draft, '\n')) !== JSON.stringify(value)) setDraft(value.join('\n'));
  }, [value]);
  return (
    <textarea
      {...input}
      rows={2}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parseList(e.target.value, '\n'));
      }}
    />
  );
}

function FieldInput({ field, row, problem, id, onChange }: { field: Field; row: Row; problem: string | undefined; id: string; onChange: (value: unknown) => void }) {
  const value = row[field.key];
  const errorId = `${id}-problem`;
  const aria = problem ? { 'aria-invalid': true, 'aria-describedby': errorId } : {};
  const shown = problem && (
    <p id={errorId} className="gdata__problem">
      {problem}
    </p>
  );
  if (field.kind === 'set') {
    const current = asList(value);
    const toggle = (option: string, on: boolean) =>
      onChange([...current.filter((v) => !field.options.includes(v)), ...field.options.filter((o) => (o === option ? on : current.includes(o)))]);
    return (
      <fieldset className="gdata__field" {...aria}>
        <legend>
          {field.label}
          {field.hint && <small> ({field.hint})</small>}
        </legend>
        <div className="gdata__checks">
          {field.options.map((option) => (
            <label key={option} className="gdata__check">
              <input type="checkbox" checked={current.includes(option)} onChange={(e) => toggle(option, e.target.checked)} />
              {option}
            </label>
          ))}
        </div>
        {shown}
      </fieldset>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <div className="gdata__field">
      <label htmlFor={id}>{field.label}</label>
      {field.kind === 'choice' ? (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)} {...aria}>
          {(field.options.includes(text) ? field.options : [text, ...field.options]).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.kind === 'list' ? (
        <ListInput id={id} value={asList(value)} onChange={onChange} {...aria} />
      ) : field.kind === 'long' ? (
        <textarea id={id} rows={2} value={text} onChange={(e) => onChange(e.target.value)} {...aria} />
      ) : (
        <input id={id} value={text} onChange={(e) => onChange(e.target.value)} {...aria} />
      )}
      {shown}
    </div>
  );
}

export function GameDataForm({ set, rows, problems, onChange }: { set: FormSet; rows: Row[]; problems: Readonly<Record<string, string>>; onChange: (rows: Row[]) => void }) {
  const id = useId();
  const edit = (i: number, key: string, value: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  return (
    <div className="gdata__form">
      {rows.map((row, i) => (
        <fieldset key={i} className="gdata__record">
          <legend>
            แถว {i + 1}: {set.title(row)}
          </legend>
          {set.fields.map((field) => (
            <FieldInput key={field.key} field={field} row={row} id={`${id}-${i}-${field.key}`} problem={problemAt(problems, `[${i}].${field.key}`)} onChange={(v) => edit(i, field.key, v)} />
          ))}
          <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ลบแถว {i + 1}
          </button>
        </fieldset>
      ))}
      <button type="button" onClick={() => onChange([...rows, { ...set.blank }])}>
        เพิ่มแถว
      </button>
    </div>
  );
}
