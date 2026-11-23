import { CONTRACT, CONTRACT_SCREENS, type ScreenId } from '@isekai/protocol/contract';
import { MOCK_TOKEN, mockBaseUrl, mockRoom } from '../mock/install.ts';
import type { MockOp } from '../mock/scenarios.ts';
import { SCENARIOS } from '../mock/scenarios.ts';
import { SCREEN_VIEWS } from './screens.tsx';
import './gallery.css';

/**
 * /dev/gallery (GEN-100, dev + VITE_MOCK=1 only): every screen of the GEN-099 contract × every mock scenario
 * that applies to it, each frame on its own mock server. `?screen=<id>&scenario=<id>` narrows it to one
 * screen / one frame (screenshot tests). Never in the production bundle (scripts/check-bundle.ts).
 */

export const GALLERY_PATH = '/dev/gallery';

const SIMULATE: { op: MockOp; label: string }[] = [
  { op: 'nextTurn', label: 'เปลี่ยนเทิร์น' },
  { op: 'othersSubmit', label: 'คนอื่นส่ง action' },
  { op: 'hit', label: 'โดนผลจากคนอื่น' },
  { op: 'drop', label: 'หลุดแล้วต่อใหม่' },
  { op: 'closeGame', label: 'ผู้ดูแลปิดเกม' },
];

/** The simulate buttons of one mock room. */
export function MockBar({ baseUrl }: { baseUrl: string }) {
  return (
    <div className="mock-bar" role="group" aria-label="จำลองเหตุการณ์">
      {SIMULATE.map((s) => (
        <button key={s.op} type="button" onClick={() => mockRoom(baseUrl).run(s.op)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

function contractLine(screen: ScreenId): string[] {
  return CONTRACT.filter((c) => (c.screens as readonly string[]).includes(screen)).map((c) => {
    const what = c.kind === 'http' ? `${c.method} ${c.path}` : `socket ${c.direction === 'client' ? 'ส่ง' : 'รับ'} ${c.type}`;
    return c.status === 'ready' ? what : `${what} (รอ ${c.owner})`;
  });
}

function Frame({ screen, scenarioId }: { screen: ScreenId; scenarioId: string }) {
  const view = SCREEN_VIEWS[screen];
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const baseUrl = mockBaseUrl(scenario.id, screen);
  return (
    <figure className="gallery-frame" aria-label={`${screen} · ${scenario.id}`}>
      <div className="gallery-frame__plate">
        <div className="gallery-frame__screen">{view.render?.({ baseUrl, token: MOCK_TOKEN })}</div>
      </div>
      <figcaption className="gallery-frame__caption">
        <span className="gallery-frame__title">{scenario.title}</span>
        <span className="gallery-frame__note">{scenario.note}</span>
        <a className="gallery-frame__open" href={`${GALLERY_PATH}?screen=${screen}&scenario=${scenario.id}`}>
          เปิดเดี่ยว
        </a>
      </figcaption>
      {view.socket && <MockBar baseUrl={baseUrl} />}
    </figure>
  );
}

export function Gallery({ search }: { search: string }) {
  const params = new URLSearchParams(search);
  const onlyScreen = params.get('screen');
  const onlyScenario = params.get('scenario');
  const screens = CONTRACT_SCREENS.filter((s) => !onlyScreen || s.id === onlyScreen);
  const single = Boolean(onlyScreen && onlyScenario);

  return (
    <div className={single ? 'gallery gallery--single' : 'gallery'}>
      <header className="gallery__head">
        <h1>แกลเลอรีหน้าจอ</h1>
        <p>ทุกหน้าในสัญญา GEN-099 กับทุกสถานะที่ mock จำลองได้ ข้อมูลทั้งหมดมาจาก fixture ไม่ต่อ server</p>
        {(onlyScreen || onlyScenario) && <a href={GALLERY_PATH}>ดูทุกหน้า</a>}
      </header>
      {!onlyScreen && (
        <nav className="gallery__index" aria-label="หน้าในสัญญา">
          <ol>
            {CONTRACT_SCREENS.map((s) => (
              <li key={s.id} className={SCREEN_VIEWS[s.id].render ? undefined : 'gallery__index-missing'}>
                <a href={`#screen-${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="gallery__screens">
        {screens.map((s) => {
          const view = SCREEN_VIEWS[s.id];
          const scenarios = SCENARIOS.filter((sc) => sc.screens.includes(s.id) && (!onlyScenario || sc.id === onlyScenario));
          return (
            <section key={s.id} id={`screen-${s.id}`} className="gallery-screen" data-screen={s.id} aria-labelledby={`title-${s.id}`}>
              <h2 id={`title-${s.id}`}>{s.title}</h2>
              {view.render ? (
                <p className="gallery-screen__page">
                  หน้า <code>{view.page}</code> {scenarios.length} สถานะ
                </p>
              ) : (
                <div className="gallery-screen__missing">
                  <p>ยังไม่มีหน้า ข้อมูลที่หน้านี้จะใช้:</p>
                  <ul>
                    {contractLine(s.id).map((line) => (
                      <li key={line}>
                        <code>{line}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {view.render && (
                <div className="gallery-screen__frames">
                  {scenarios.map((sc) => (
                    <Frame key={sc.id} screen={s.id} scenarioId={sc.id} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
