import type { InventoryEntry, InventoryView } from '@isekai/protocol';
import { useState } from 'react';
import { inventoryCall } from './game-api.ts';

const entryLabel = (e: InventoryEntry) =>
  [e.name, e.rank ? `Rank ${e.rank}` : 'ไม่มีในข้อมูลเกม', e.alignment, e.triggerType, e.dailyLimit > 0 ? `วันละ ${e.dailyLimit} ครั้ง` : null]
    .filter((s): s is string => s !== null && s !== '')
    .join(' · ');

function EntryList({ entries, empty }: { entries: InventoryEntry[]; empty: string }) {
  if (entries.length === 0) return <p>{empty}</p>;
  return (
    <ul>
      {entries.map((e) => (
        <li key={e.id}>
          <strong>{entryLabel(e)}</strong>
          {e.description && <div>{e.description}</div>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Your own skills and the items you hold now (GEN-055, Q-106: after a steal or a gift the list follows),
 * plus the unlock conditions you found with INVESTIGATE at the library. Loaded on demand.
 */
export function InventoryPanel({ apiBaseUrl, token, onSessionLost }: { apiBaseUrl: string; token: string; onSessionLost: () => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<InventoryView>();
  const [problem, setProblem] = useState<string>();

  async function load() {
    const result = await inventoryCall(apiBaseUrl, token);
    if (result.kind === 'session_lost') return onSessionLost();
    if (result.kind === 'error') return setProblem(result.message);
    setProblem(undefined);
    setView(result.inventory);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        สกิลและไอเท็มของฉัน
      </button>
    );
  }
  return (
    <section aria-label="สกิลและไอเท็มของฉัน">
      <h3>สกิลและไอเท็มของฉัน</h3>
      <button type="button" onClick={() => void load()}>
        โหลดใหม่
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        ปิด
      </button>
      {problem && <p role="alert">{problem}</p>}
      {view && (
        <>
          <h4>สกิล</h4>
          <EntryList entries={view.skills} empty="ยังไม่มีสกิล" />
          <h4>ไอเท็มที่ติดตัว</h4>
          <EntryList entries={view.items} empty="ไม่มีไอเท็มติดตัว" />
          <h4>เงื่อนไขที่ค้นพบ</h4>
          {view.discoveries.length === 0 ? (
            <p>ยังไม่พบเงื่อนไขใด (ค้นได้ด้วย INVESTIGATE ที่หอสมุดหลวง)</p>
          ) : (
            <ul>
              {view.discoveries.map((d) => (
                <li key={`${d.kind}:${d.name}`}>
                  {d.name}: {d.text}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
