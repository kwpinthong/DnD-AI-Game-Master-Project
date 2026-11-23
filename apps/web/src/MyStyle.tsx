import type { PlayerStyleResponse } from '@isekai/protocol';
import { useState, type FormEvent } from 'react';
import { playerStyleCall } from './game-api.ts';
import { ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { Button, EmptyState, Field, Panel } from './ui/index.ts';
import './pregame.css';

/**
 * "สไตล์ของฉัน" (GEN-200, Screens and Flows v2 §9) on the GEN-082 routes: the player code opens the top 3 verbs +
 * the tone line, the delete (asked first) and "ไม่ให้เก็บสไตล์ฉัน". The code stays in this component's state only:
 * it goes in request bodies, never a URL, a log or web storage.
 */
export function MyStyle({ apiBaseUrl, onClose }: { apiBaseUrl: string; onClose?: () => void }) {
  const [code, setCode] = useState('');
  /** The answer and the code it belongs to, so editing the field does not act on another code. */
  const [found, setFound] = useState<{ code: string; data: PlayerStyleResponse }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function run(action: Parameters<typeof playerStyleCall>[1], playerCode: string) {
    setBusy(true);
    setError(undefined);
    const result = await playerStyleCall(apiBaseUrl, action, playerCode);
    setBusy(false);
    if (result.kind === 'error') {
      if (action === 'view') setFound(undefined);
      setError(result.message);
      return false;
    }
    setFound({ code: playerCode, data: result.data });
    return true;
  }

  function lookUp(event: FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return setError('ใส่รหัสผู้เล่น');
    if (!busy) void run('view', trimmed);
  }

  async function remove() {
    if (found && (await run('delete', found.code))) setConfirming(false);
  }

  const style = found?.data.style;
  return (
    <div className="pregame">
      <Panel title="สไตล์ของฉัน" className="pregame__panel">
        <h2 className="pregame__title">สไตล์ของฉัน</h2>
        <p className="pregame__lead">ใส่รหัสผู้เล่นที่ใช้ตอนเข้าเกม เพื่อดู ลบ หรือหยุดเก็บสไตล์การเล่นของคุณ</p>
        <form onSubmit={lookUp} noValidate>
          <Field id="my-style-code" label="รหัสผู้เล่น">
            {(control) => (
              <input {...control} name="playerCode" value={code} onChange={(e) => setCode(e.target.value)} className="code-input" autoComplete="off" spellCheck={false} maxLength={64} />
            )}
          </Field>
          {error && !confirming && (
            <p className="field-error pregame__form-error" role="alert">
              {error}
            </p>
          )}
          <div className="pregame__actions">
            <Button type="submit" variant="primary" loading={busy && !found} loadingText="กำลังดู…">
              ดูสไตล์
            </Button>
            {onClose && <Button onClick={onClose}>ปิด</Button>}
          </div>
        </form>

        {found && (
          <div className="pregame__group">
            {style ? (
              <>
                <h3>คำที่ใช้บ่อย</h3>
                <ul aria-label="คำที่ใช้บ่อย" className="my-style__verbs">
                  {style.verbs.slice(0, 3).map((v) => (
                    <li key={v.verb} className="chip">
                      {v.verb}
                    </li>
                  ))}
                </ul>
                <h3>โทนการเล่น</h3>
                <p>{style.summary}</p>
                <Button variant="danger" onClick={() => setConfirming(true)}>
                  ลบ profile ของฉัน
                </Button>
              </>
            ) : (
              <EmptyState title="ยังไม่มีสไตล์ที่เก็บ">เกิดจากเกมที่ได้คะแนนเกิน 8</EmptyState>
            )}
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="ไม่ให้เก็บสไตล์ฉัน"
                aria-describedby="my-style-optout"
                checked={found.data.optOut}
                disabled={busy}
                onChange={(e) => void run({ optOut: e.target.checked }, found.code)}
              />
              <span className="switch__track" aria-hidden="true" />
              <span className="switch__title">ไม่ให้เก็บสไตล์ฉัน</span>
            </label>
            <p className="pregame__note" id="my-style-optout">
              {found.data.optOut ? 'เกมที่จบหลังจากนี้จะไม่เก็บสไตล์ของคุณ และ AI จะไม่ได้รับสไตล์นี้' : 'เปิดเพื่อหยุดเก็บสไตล์จากเกมที่จบหลังจากนี้'}
            </p>
          </div>
        )}
      </Panel>
      {confirming && (
        <ConfirmDialog
          title="ลบ profile สไตล์ของคุณ?"
          confirmLabel="ลบเลย"
          cancelLabel="ยกเลิก"
          busy={busy}
          error={error ?? null}
          onConfirm={() => void remove()}
          onCancel={() => {
            setConfirming(false);
            setError(undefined);
          }}
        >
          สไตล์ทุกเกมของรหัสนี้จะถูกลบจริง ย้อนกลับไม่ได้
        </ConfirmDialog>
      )}
    </div>
  );
}
