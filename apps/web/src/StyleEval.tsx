import type { StyleEvalMark, StyleEvalResponse, StyleEvalRun, StyleEvalSceneResult } from '@isekai/protocol';
import { useEffect, useRef, useState } from 'react';
import { fetchStyleEval, saveStyleEvalMark, type AdminResult } from './admin-api.ts';
import './style-eval.css';

/**
 * GEN-167: the Thai style eval set, the previous round and the latest side by side scene by scene; Nok marks each
 * scene better / same / worse (pressing the pressed one again clears it). Rounds come from `pnpm eval:style`.
 */
const MARKS: { value: StyleEvalMark; label: string }[] = [
  { value: 'better', label: 'ดีขึ้น' },
  { value: 'same', label: 'เท่าเดิม' },
  { value: 'worse', label: 'แย่ลง' },
];
const FLAG_LABEL: Record<string, string> = { real_name: 'ชื่อจริงหลุด' };

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;
const runLine = (r: StyleEvalRun) => `รอบ #${r.id} · ${new Date(r.createdAt).toLocaleString('th-TH')} · Voice v${r.voiceVersion} · ${r.models.join(', ') || r.provider} · ${usd(r.costUsdMicros)}`;

function SceneText({ scene }: { scene: StyleEvalSceneResult | undefined }) {
  if (!scene) return <p className="style-eval__none">ไม่มีฉากนี้ในรอบนั้น</p>;
  return (
    <>
      {scene.ok ? <p className="style-eval__text">{scene.text}</p> : <p className="style-eval__failed">ไม่สำเร็จ: {scene.failure}</p>}
      {scene.flags.length > 0 && <p className="style-eval__flags">ธง: {scene.flags.map((f) => FLAG_LABEL[f] ?? f).join(' · ')}</p>}
    </>
  );
}

export function StyleEval({ apiBaseUrl, token, onForbidden }: { apiBaseUrl: string; token: string; onForbidden: (message: string) => void }) {
  const [view, setView] = useState<StyleEvalResponse>();
  const [error, setError] = useState<string>();
  const onForbiddenRef = useRef(onForbidden);
  onForbiddenRef.current = onForbidden;

  function take(result: AdminResult<StyleEvalResponse>) {
    if (result.kind === 'ok') {
      setError(undefined);
      setView(result.data);
    } else if (result.kind === 'forbidden') onForbiddenRef.current(result.message);
    else setError(result.message);
  }

  useEffect(() => {
    void fetchStyleEval(apiBaseUrl, token).then(take);
  }, [apiBaseUrl, token]);

  async function mark(runId: number, sceneId: string, value: StyleEvalMark) {
    const next = view?.marks[sceneId] === value ? null : value;
    take(await saveStyleEvalMark(apiBaseUrl, token, runId, sceneId, next));
  }

  const { current, previous, marks, summary } = view ?? {};
  return (
    <section aria-label="ชุดทดสอบสำนวน" className="gdata style-eval">
      <h3>ชุดทดสอบสำนวน (เทียบรอบก่อนกับรอบนี้)</h3>
      {error && <p role="alert">{error}</p>}
      {view === undefined ? (
        <p>กำลังโหลด…</p>
      ) : !current ? (
        <p>ยังไม่มีผลรอบไหน รัน pnpm eval:style ที่ server ก่อน</p>
      ) : (
        <>
          <p>รอบนี้: {runLine(current)}</p>
          <p>{previous ? `รอบก่อน: ${runLine(previous)}` : 'รอบแรก ยังไม่มีรอบก่อนให้เทียบ'}</p>
          {previous && summary && (
            <p role="status" aria-label="สรุปคะแนน">
              ดีขึ้น {summary.better} · เท่าเดิม {summary.same} · แย่ลง {summary.worse} · ยังไม่ให้ {summary.unmarked}
            </p>
          )}
          <ul className="style-eval__list">
            {current.scenes.map((scene) => (
              <li key={scene.sceneId}>
                <div role="group" aria-label={scene.title} className="style-eval__scene">
                  <h4>
                    {scene.title} <span className="style-eval__purpose">({scene.purpose})</span>
                  </h4>
                  <div className="style-eval__pair">
                    <div>
                      <h5>รอบก่อน</h5>
                      <SceneText scene={previous?.scenes.find((s) => s.sceneId === scene.sceneId)} />
                    </div>
                    <div>
                      <h5>รอบนี้</h5>
                      <SceneText scene={scene} />
                    </div>
                  </div>
                  {previous && (
                    <div className="style-eval__marks">
                      {MARKS.map((m) => (
                        <button key={m.value} type="button" aria-pressed={marks?.[scene.sceneId] === m.value} onClick={() => void mark(current.id, scene.sceneId, m.value)}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
