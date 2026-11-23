import type { GameTone, StyleFlagStat, StyleSettings, StyleSettingsRequest } from '@isekai/protocol';
import { useEffect, useRef, useState } from 'react';
import { fetchStyleFlags, fetchStyleSettings, saveStyleSettings, type AdminResult } from './admin-api.ts';
import { toneText } from './ui/strings.ts';

/**
 * GEN-169: what the server's style checker flagged, per NPC (its public alias) per reason, and its settings.
 * Counts only, never the text. Behind the admin code.
 */
export function StylePanel({ apiBaseUrl, token, onForbidden }: { apiBaseUrl: string; token: string; onForbidden: (message: string) => void }) {
  const [stats, setStats] = useState<StyleFlagStat[]>();
  const [settings, setSettings] = useState<StyleSettings>();
  const [error, setError] = useState<string>();
  const onForbiddenRef = useRef(onForbidden);
  onForbiddenRef.current = onForbidden;

  function take<T>(result: AdminResult<T>): T | undefined {
    if (result.kind === 'ok') return result.data;
    if (result.kind === 'forbidden') onForbiddenRef.current(result.message);
    else setError(result.message);
    return undefined;
  }

  useEffect(() => {
    void (async () => {
      const [flags, current] = await Promise.all([fetchStyleFlags(apiBaseUrl, token), fetchStyleSettings(apiBaseUrl, token)]);
      setStats(take(flags)?.stats);
      setSettings(take(current)?.settings);
    })();
  }, [apiBaseUrl, token]);

  async function change(patch: StyleSettingsRequest) {
    setError(undefined);
    const saved = take(await saveStyleSettings(apiBaseUrl, token, patch));
    if (saved) setSettings(saved.settings);
  }

  return (
    <section aria-label="ตรวจสำนวน" className="gdata">
      <h3>ตรวจสำนวน (คำต้องห้าม + สรรพนาม NPC)</h3>
      {error && <p role="alert">{error}</p>}
      {settings && (
        <>
          <label className="gdata__check">
            <input type="checkbox" checked={settings.rewrite} onChange={(e) => void change({ rewrite: e.target.checked })} />
            ให้ AI เขียนใหม่ 1 ครั้งเมื่อเจอกฎ block (ทำการ, emoji / markdown)
          </label>
          {/* GEN-177: a game created without a tone gets this one; games already made keep theirs. */}
          <label className="gdata__field">
            {toneText.adminDefault}
            <select value={settings.defaultTone} onChange={(e) => void change({ defaultTone: e.target.value as GameTone })}>
              {toneText.tones.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.value}: {t.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {stats === undefined ? (
        <p>กำลังโหลด…</p>
      ) : stats.length === 0 ? (
        <p>ยังไม่มีข้อความที่ถูกติดธง</p>
      ) : (
        <table aria-label="จำนวนธงต่อ NPC ต่อเหตุผล">
          <thead>
            <tr>
              <th>NPC</th>
              <th>เหตุผล</th>
              <th>จำนวน</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={`${s.npc?.id ?? ''}:${s.reason}`}>
                <th scope="row">{s.npc ? s.npc.alias : 'บรรยาย'}</th>
                <td>{s.reason}</td>
                <td>{s.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
