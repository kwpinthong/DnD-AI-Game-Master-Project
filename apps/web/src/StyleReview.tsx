import { VOTE_REASON_LABEL, VoteReason, type StyleProposal, type StyleReviewResponse, type StyleSignalCounts } from '@isekai/protocol';
import { useEffect, useRef, useState } from 'react';
import { addNpcExample, decideStyleProposal, fetchStyleReview, restoreVoiceVersion, runStyleReview, type AdminResult } from './admin-api.ts';

/**
 * GEN-178: the style review tab. The 👎 + style flags waiting for the next round, the rounds (what the AI found), each
 * proposed Voice rule to approve (as is or edited) or reject, the Voice versions to roll back to, and NPC lines most
 * players liked for the NPC example library. Behind the admin code.
 */

/** While a round waits for the AI, the tab asks again this often. */
const RUNNING_POLL_MS = 3_000;

const KIND_LABEL: Record<StyleProposal['kind'], string> = { forbid: 'คำต้องห้าม', pair: 'คู่ แย่ → ดี', npc_patch: 'แก้โปรไฟล์ NPC' };
const STATUS_LABEL: Record<StyleProposal['status'], string> = { proposed: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ' };
const ROUND_LABEL = { done: 'เสร็จ', skipped: 'ข้าม (สัญญาณไม่พอ)', failed: 'ล้มเหลว' } as const;
const TRIGGER_LABEL = { games: 'ครบเกมที่จบ', manual: 'กดรันเอง' } as const;

const reasonLabel = (r: string) => (VoteReason.safeParse(r).success ? VOTE_REASON_LABEL[r as VoteReason] : r);
const when = (iso: string | null) => (iso === null ? 'ตั้งต้น' : new Date(iso).toLocaleString('th-TH'));

export function StyleReview({ apiBaseUrl, token, onForbidden }: { apiBaseUrl: string; token: string; onForbidden: (message: string) => void }) {
  const [data, setData] = useState<StyleReviewResponse>();
  const [error, setError] = useState<string>();
  const onForbiddenRef = useRef(onForbidden);
  onForbiddenRef.current = onForbidden;

  function take(result: AdminResult<StyleReviewResponse>) {
    if (result.kind === 'ok') {
      setData(result.data);
      setError(undefined);
    } else if (result.kind === 'forbidden') onForbiddenRef.current(result.message);
    else setError(result.message);
  }

  useEffect(() => {
    void fetchStyleReview(apiBaseUrl, token).then(take);
  }, [apiBaseUrl, token]);

  const running = data?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void fetchStyleReview(apiBaseUrl, token).then(take), RUNNING_POLL_MS);
    return () => clearTimeout(timer);
  }, [apiBaseUrl, token, running, data]);

  if (!data) return error ? <p role="alert">{error}</p> : <p>กำลังโหลด…</p>;

  return (
    <section aria-label="ทบทวนสำนวน" className="gdata">
      {error && <p role="alert">{error}</p>}
      <p role="status">
        {running
          ? 'กำลังทบทวน รอ AI ตอบ…'
          : `รอบถัดไปเริ่มเองเมื่อมีเกมจบอีก ${Math.max(0, data.gamesPerRound - data.gamesSinceRound)} เกม (ต้องมีสัญญาณใหม่อย่างน้อย ${data.minSignals})`}
      </p>
      <div className="gdata__actions">
        <button type="button" disabled={running} onClick={() => void runStyleReview(apiBaseUrl, token).then(take)}>
          รันรอบทบทวนตอนนี้
        </button>
      </div>

      <h3>สัญญาณที่รอรอบหน้า</h3>
      <Counts label="สัญญาณที่รอรอบหน้า" counts={data.waiting} />

      <h3>ข้อเสนอ</h3>
      {data.proposals.length === 0 ? (
        <p>ยังไม่มีข้อเสนอ</p>
      ) : (
        <ul>
          {data.proposals.map((p) => (
            <Proposal key={p.id} proposal={p} onDecide={(decision, content) => void decideStyleProposal(apiBaseUrl, token, p.id, decision, content ? { content } : {}).then(take)} onBadJson={setError} />
          ))}
        </ul>
      )}

      <h3>เวอร์ชันคู่มือสำนวน (Voice)</h3>
      <ul>
        {data.voice.versions.map((v) => (
          <li key={v.version}>
            เวอร์ชัน {v.version} ({when(v.at)}){' '}
            {v.current ? (
              <strong>ใช้อยู่</strong>
            ) : (
              <button type="button" onClick={() => void restoreVoiceVersion(apiBaseUrl, token, v.version).then(take)}>
                ย้อนเป็นเวอร์ชัน {v.version}
              </button>
            )}
          </li>
        ))}
      </ul>

      <h3>รอบที่ผ่านมา</h3>
      {data.rounds.length === 0 ? (
        <p>ยังไม่มีรอบ</p>
      ) : (
        <ul>
          {data.rounds.map((r) => (
            <li key={r.id}>
              <p>
                {when(r.createdAt)} · {TRIGGER_LABEL[r.trigger]} · {ROUND_LABEL[r.status]} · {r.signals} สัญญาณ{r.error ? ` (${r.error})` : ''}
              </p>
              {r.patterns.length > 0 && (
                <ul>
                  {r.patterns.map((pattern, i) => (
                    <li key={i}>
                      <span>{pattern.summary}</span>
                      {pattern.evidence.length > 0 && ` (ข้อความ #${pattern.evidence.join(', #')})`}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>บทพูด NPC ที่ผู้เล่นส่วนใหญ่ชอบ (ผู้สมัครคลังตัวอย่าง)</h3>
      {data.goodCandidates.length === 0 ? (
        <p>ไม่มีบทพูดที่รอเข้าคลัง</p>
      ) : (
        <ul>
          {data.goodCandidates.map((c) => (
            <li key={`${c.gameId}/${c.seq}`}>
              <p>
                {c.npc.name} (👍 {c.up}): {c.text}
              </p>
              <button
                type="button"
                onClick={() =>
                  void addNpcExample(apiBaseUrl, token, { from: 'vote', gameId: c.gameId, seq: c.seq, npcId: c.npc.id, scene: 'npc-dialogue' }).then(async (added) => {
                    if (added.kind === 'forbidden') return onForbiddenRef.current(added.message);
                    if (added.kind === 'error') setError(added.message);
                    take(await fetchStyleReview(apiBaseUrl, token));
                  })
                }
              >
                เพิ่มเข้าคลังของ {c.npc.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Counts({ label, counts }: { label: string; counts: StyleSignalCounts }) {
  const rows: [string, string, number][] = [
    ['รวม', '👎', counts.downvotes],
    ['รวม', 'ธงตรวจสำนวน', counts.flags],
    ...Object.entries(counts.reasons).map(([k, n]): [string, string, number] => ['ชิป 👎', reasonLabel(k), n]),
    ...Object.entries(counts.rules).map(([k, n]): [string, string, number] => ['กฎ', k, n]),
    ...Object.entries(counts.npcs).map(([k, n]): [string, string, number] => ['NPC', k === '' ? 'บรรยาย' : k, n]),
  ];
  return (
    <table aria-label={label}>
      <thead>
        <tr>
          <th>แยกตาม</th>
          <th>รายการ</th>
          <th>จำนวน</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([group, key, n]) => (
          <tr key={`${group}:${key}`}>
            <th scope="row">{group}</th>
            <td>{key}</td>
            <td>{n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Proposal({
  proposal: p,
  onDecide,
  onBadJson,
}: {
  proposal: StyleProposal;
  onDecide: (decision: 'approve' | 'reject', content?: Record<string, unknown>) => void;
  onBadJson: (message: string) => void;
}) {
  const original = JSON.stringify(p.content, null, 2);
  const [text, setText] = useState(original);

  function approve() {
    if (text === original) return onDecide('approve');
    try {
      const content = JSON.parse(text) as unknown;
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('not an object');
      onDecide('approve', content as Record<string, unknown>);
    } catch {
      onBadJson('เนื้อหากฎต้องเป็น JSON object');
    }
  }

  return (
    <li>
      <p>
        <strong>{KIND_LABEL[p.kind]}</strong>
        {p.npcId && ` · ${p.npcId}`} · {STATUS_LABEL[p.status]}
        {p.voiceVersion !== null && ` (เวอร์ชัน ${p.voiceVersion})`}
      </p>
      <p>{p.reason}</p>
      {p.evidence.length > 0 && <p>หลักฐาน: ข้อความ #{p.evidence.join(', #')}</p>}
      {p.status === 'proposed' ? (
        <>
          <label className="gdata__editor">
            เนื้อหากฎ (JSON)
            <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="gdata__actions">
            <button type="button" onClick={approve}>
              อนุมัติ
            </button>
            <button type="button" onClick={() => onDecide('reject')}>
              ไม่อนุมัติ
            </button>
          </div>
        </>
      ) : (
        <pre>{original}</pre>
      )}
    </li>
  );
}
