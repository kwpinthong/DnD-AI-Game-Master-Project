import type { GameDataAuditEntry, GameDataImportPreviewResponse, GameDataSetSummary } from '@isekai/protocol';
import { useEffect, useRef, useState } from 'react';
import {
  fetchGameDataAssetFile,
  fetchGameDataAudit,
  fetchGameDataExport,
  fetchGameDataList,
  fetchGameDataSet,
  saveGameDataSet,
  undoGameDataSet,
  type AdminResult,
} from './admin-api.ts';
import { FORM_SETS, GameDataForm } from './GameDataForm.tsx';

/**
 * GEN-147: the server owner's game data editor at <web>/admin. Plain on purpose: a list of the data sets, one
 * set's JSON in a text box, and the server checks a save with the asset loader's schemas (it answers the wrong
 * fields; nothing changes then). Every save is backed up and logged on the server; undo takes back the latest.
 */

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** The JSON text as a list of records, or undefined when it is not one (then only the raw JSON box is shown). */
function recordsOf(text: string): Record<string, unknown>[] | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) && value.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r)) ? (value as Record<string, unknown>[]) : undefined;
  } catch {
    return undefined;
  }
}
const when = (iso: string) => new Date(iso).toLocaleString('th-TH', { hour12: false });

type Problem = { message: string; fields?: Record<string, string> };

function Changes({ changes }: { changes: GameDataAuditEntry['changes'] }) {
  return changes.map((c) => (
    <div key={c.index}>
      <p>แถว {c.index + 1}</p>
      <pre>เดิม: {pretty(c.old)}</pre>
      <pre>ใหม่: {pretty(c.new)}</pre>
    </div>
  ));
}

export function GameDataEditor({ apiBaseUrl, token, onForbidden }: { apiBaseUrl: string; token: string; onForbidden: (message: string) => void }) {
  const [sets, setSets] = useState<GameDataSetSummary[]>();
  const [audit, setAudit] = useState<GameDataAuditEntry[]>([]);
  const [selected, setSelected] = useState<GameDataSetSummary>();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<Problem>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** GEN-173: the asset file waiting for the admin's confirm. */
  const [incoming, setIncoming] = useState<GameDataImportPreviewResponse>();
  const onForbiddenRef = useRef(onForbidden);
  onForbiddenRef.current = onForbidden;

  /** The data of an ok answer; a 403 signs out, another error shows. */
  function take<T>(result: AdminResult<T>): T | undefined {
    if (result.kind === 'ok') return result.data;
    if (result.kind === 'forbidden') onForbiddenRef.current(result.message);
    else setProblem({ message: result.message, ...(result.fields ? { fields: result.fields } : {}) });
    return undefined;
  }

  async function refreshLists() {
    const [list, log] = await Promise.all([fetchGameDataList(apiBaseUrl, token), fetchGameDataAudit(apiBaseUrl, token)]);
    const l = take(list);
    if (l) setSets(l.sets);
    const a = take(log);
    if (a) setAudit(a.entries);
  }

  useEffect(() => {
    void refreshLists(); // once per token
  }, [apiBaseUrl, token]);

  async function run(work: () => Promise<{ set: GameDataSetSummary; value: unknown } | undefined>, done?: string) {
    setBusy(true);
    setProblem(undefined);
    setStatus(undefined);
    setIncoming(undefined);
    const shown = await work();
    setBusy(false);
    if (!shown) return;
    setSelected(shown.set);
    setText(pretty(shown.value));
    if (done) setStatus(done);
    await refreshLists();
  }

  const open = (name: string) => run(async () => take(await fetchGameDataSet(apiBaseUrl, token, name)));

  function save() {
    if (!selected) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      setStatus(undefined);
      setProblem({ message: `JSON ไม่ถูกต้อง ยังไม่ได้ส่ง: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    void run(async () => take(await saveGameDataSet(apiBaseUrl, token, selected.name, value)), 'บันทึกแล้ว');
  }

  async function previewImport() {
    if (!selected) return;
    setBusy(true);
    setProblem(undefined);
    setStatus(undefined);
    setIncoming(take(await fetchGameDataAssetFile(apiBaseUrl, token, selected.name)));
    setBusy(false);
  }

  const confirmImport = () =>
    incoming && void run(async () => take(await saveGameDataSet(apiBaseUrl, token, incoming.set.name, incoming.value)), 'นำเข้าจากไฟล์แล้ว');

  const undo = () => selected && void run(async () => take(await undoGameDataSet(apiBaseUrl, token, selected.name)), 'ย้อนแล้ว');

  async function exportAll() {
    setProblem(undefined);
    const data = take(await fetchGameDataExport(apiBaseUrl, token));
    if (!data) return;
    const url = URL.createObjectURL(new Blob([pretty(data)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `isekai-game-data-${data.exportedAt.replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // GEN-172: NPC_Schedule and NPC get a record / field form over the same JSON text (the raw JSON stays one click away).
  const formSet = selected && FORM_SETS[selected.name];
  const formRows = formSet ? recordsOf(text) : undefined;
  const jsonBox = selected && (
    <label>
      JSON ของ {selected.name}
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={24} />
    </label>
  );

  return (
    <div className="gdata">
      <p className="lib__owner">
        ข้อมูลเกมทั้งหมดอยู่ใน DB: แก้แล้วมีผลกับเกมใหม่ทันทีและเกมที่เล่นอยู่ตั้งแต่เทิร์นถัดไป ทุกการบันทึกมี backup และบันทึกประวัติ
        (ไฟล์ใน apps/server/assets ใช้แค่ตั้งต้นครั้งแรก)
      </p>
      <button type="button" onClick={() => void exportAll()}>
        export JSON (backup)
      </button>
      {sets === undefined ? (
        <p>กำลังโหลด…</p>
      ) : (
        <nav className="gdata__sets" aria-label="ชุดข้อมูลเกม">
          {sets.map((s) => (
            <button key={s.name} type="button" aria-pressed={selected?.name === s.name} onClick={() => void open(s.name)}>
              {s.name} ({s.records} แถว)
            </button>
          ))}
        </nav>
      )}
      {sets
        ?.filter((s) => s.fallback)
        .map((s) => (
          <div key={s.name} role="alert" aria-label={`${s.name}: ใช้ไฟล์ asset แทน`} className="gdata__problem">
            <p>
              {s.name}: ค่าใน DB ไม่ผ่าน schema ใหม่ ตอนนี้ server ใช้ไฟล์ {s.file} แทน (ค่าใน DB ยังอยู่) แก้ช่องด้านล่างแล้วบันทึก หรือนำเข้าจากไฟล์
            </p>
            <ul>
              {Object.entries(s.fallback!.fields).map(([field, message]) => (
                <li key={field}>
                  {field}: {message}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {problem && (
        <div role="alert" className="gdata__problem">
          <p>{problem.message}</p>
          {problem.fields && (
            <ul>
              {Object.entries(problem.fields).map(([field, message]) => (
                <li key={field}>
                  {field}: {message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {status && <p role="status">{status}</p>}
      {selected && (
        <section aria-label={`แก้ ${selected.name}`} className="gdata__editor">
          <h3>
            {selected.name} <small>({selected.file}, แก้ล่าสุด {when(selected.updatedAt)})</small>
          </h3>
          {formSet ? (
            <>
              {formRows ? (
                <GameDataForm set={formSet} rows={formRows} problems={problem?.fields ?? {}} onChange={(rows) => setText(pretty(rows))} />
              ) : (
                <p>JSON ดิบอ่านเป็นรายการ record ไม่ได้ แก้ JSON ให้ถูกก่อนจึงจะใช้แบบฟอร์มได้</p>
              )}
              <details>
                <summary>แก้เป็น JSON ดิบ</summary>
                {jsonBox}
              </details>
            </>
          ) : (
            jsonBox
          )}
          <div className="gdata__actions">
            <button type="button" disabled={busy} onClick={save}>
              บันทึก
            </button>
            <button type="button" disabled={busy || !selected.canUndo} onClick={undo}>
              ย้อนการแก้ล่าสุด (undo)
            </button>
            <button type="button" disabled={busy} onClick={() => void previewImport()}>
              นำเข้าจากไฟล์
            </button>
          </div>
        </section>
      )}
      {incoming && (
        <section aria-label={`นำเข้า ${incoming.set.name} จากไฟล์`} className="gdata__editor gdata__audit">
          <h3>
            นำเข้า {incoming.set.name} จาก {incoming.set.file}: {incoming.changes.length} แถวที่เปลี่ยน
          </h3>
          <p>ยืนยันแล้วค่าใน DB จะเป็นตามไฟล์ (มี backup + ประวัติ และกด undo ย้อนได้)</p>
          <Changes changes={incoming.changes} />
          <div className="gdata__actions">
            <button type="button" disabled={busy || incoming.changes.length === 0} onClick={confirmImport}>
              ยืนยันนำเข้า
            </button>
            <button type="button" disabled={busy} onClick={() => setIncoming(undefined)}>
              ยกเลิก
            </button>
          </div>
        </section>
      )}
      <section aria-label="ประวัติการแก้">
        <h3>ประวัติการแก้</h3>
        {audit.length === 0 ? (
          <p>ยังไม่มีการแก้</p>
        ) : (
          <ul className="gdata__audit">
            {audit.map((e) => (
              <li key={e.id}>
                <details>
                  <summary>
                    {when(e.at)} · {e.name} · {e.action === 'edit' ? 'แก้' : 'ย้อน'} · {e.changes.length} แถวที่เปลี่ยน
                  </summary>
                  <Changes changes={e.changes} />
                  <p>backup: {e.backupFile}</p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
