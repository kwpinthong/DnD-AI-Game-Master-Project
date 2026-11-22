import type { RoomEntry, RoomState } from '@isekai/protocol';
import { useState, type ReactNode } from 'react';
import fountainArt from '../../assets/illustrations/place-fountain.webp';
import { playText } from '../../ui/index.ts';
import { HereList, PlaceTitle } from '../PlaceColumn.tsx';
import { Whispers, type WhisperText } from '../PrivateColumn.tsx';
import { Companions, Entry, Part, SelfStatus } from '../SelfColumn.tsx';
import type { PlayData } from '../play-api.ts';
import { changeBadges } from './chat-model.ts';
import { RovingTabs, panelId, tabId, type TabDef } from './RovingTabs.tsx';

const t = playText.chat.panel;
const PREFIX = 'info';

export const INFO_TABS = ['place', 'self', 'bag', 'people'] as const;
export type InfoTab = (typeof INFO_TABS)[number];
const TAB_DEFS: readonly TabDef<InfoTab>[] = INFO_TABS.map((id) => ({ id, label: t[id] }));

/** A painted place when we have one (more come with the scenario art); the name is also text over it. */
const PLACE_ART: Readonly<Record<string, string>> = { fountain: fountainArt };

/** Everything the four panels read; the same object feeds the desktop side panel and the phone's tabs (GEN-123). */
export interface InfoData {
  room: RoomState;
  data: PlayData;
  entries: readonly RoomEntry[];
  secret: string;
  onTravel: (() => void) | null;
  onSave: ((ref: string) => void) | null;
  onRelease: ((ref: string) => void) | null;
  /** Put a skill into the action box. */
  onUse: ((name: string) => void) | null;
  companionProblem: string | undefined;
  whisper: WhisperText;
  whisperProblem: string | undefined;
  onWhisper: (to: string) => void;
}

function Fold({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="info-fold" open={open}>
      <summary>{title}</summary>
      <div className="info-fold__body">{children}</div>
    </details>
  );
}

/** สถานที่: the place (art, name, zone, [เดินทาง]) and who is here. */
export function PlacePanel({ room, data, onTravel, onSave }: Pick<InfoData, 'room' | 'data' | 'onTravel' | 'onSave'>) {
  const art = room.you.place ? PLACE_ART[room.you.place.id] : undefined;
  return (
    <div className="info-body">
      {art && <div className="info-art" style={{ backgroundImage: `url("${art}")` }} aria-hidden="true" />}
      <PlaceTitle room={room} onTravel={onTravel} />
      <HereList room={room} data={data} onSave={onSave} />
    </div>
  );
}

/** ตัวฉัน: status, then folds: traits, skills, the log of changed values. */
export function SelfPanel({ data, entries, secret, room, onUse }: Pick<InfoData, 'data' | 'entries' | 'secret' | 'room' | 'onUse'>) {
  const log = entries.filter((e) => e.kind === 'changes' && (e.changes?.length ?? 0) > 0);
  return (
    <div className="info-body">
      <Part label={playText.self.status} value={data.character}>
        {(character) => (
          <>
            <SelfStatus character={character} secret={secret} drowsy={room.you.drowsy} />
            <Fold title={t.traits} open>
              <p>{character.personality || playText.loadFailed}</p>
            </Fold>
          </>
        )}
      </Part>
      <Part label={playText.inventory.label} value={data.inventory}>
        {(inventory) => (
          <Fold title={t.skills(inventory.skills.length)}>
            {inventory.skills.length === 0 ? (
              <p className="muted">{playText.inventory.empty}</p>
            ) : (
              <ul className="play-list">
                {inventory.skills.map((s) => (
                  <Entry key={s.id} entry={s} onUse={onUse} />
                ))}
              </ul>
            )}
          </Fold>
        )}
      </Part>
      <Fold title={t.log}>
        {log.length === 0 ? (
          <p className="muted">{t.logNone}</p>
        ) : (
          <ul className="play-list">
            {log.map((e) => (
              <li key={e.seq}>{`${playText.dayTurnName(e.day, e.phase, e.turn)}: ${changeBadges(e.changes ?? []).map((b) => b.text).join(', ')}`}</li>
            ))}
          </ul>
        )}
      </Fold>
    </div>
  );
}

/** กระเป๋า: coins and the items (and the clues found). */
export function BagPanel({ data, onUse }: Pick<InfoData, 'data' | 'onUse'>) {
  return (
    <div className="info-body">
      <Part label={playText.inventory.label} value={data.inventory}>
        {(inventory) => (
          <>
            <p className="info-coins">
              {playText.self.coins}: {data.character?.coins ?? '…'}
            </p>
            {inventory.items.length === 0 ? (
              <p className="muted">{t.bagEmpty}</p>
            ) : (
              <ul className="play-list">
                {inventory.items.map((i) => (
                  <Entry key={i.id} entry={i} onUse={onUse} />
                ))}
              </ul>
            )}
            {inventory.discoveries.length > 0 && (
              <Fold title={playText.inventory.discoveries(inventory.discoveries.length)}>
                <ul className="play-list play-list--small">
                  {inventory.discoveries.map((d) => (
                    <li key={`${d.kind}:${d.name}`}>
                      {d.name}: {d.text}
                    </li>
                  ))}
                </ul>
              </Fold>
            )}
          </>
        )}
      </Part>
    </div>
  );
}

/** คนรอบตัว: who is here, your companions, and Whisper to an ally. */
export function PeoplePanel({ room, data, entries, onSave, onRelease, companionProblem, whisper, whisperProblem, onWhisper }: Pick<InfoData, 'room' | 'data' | 'entries' | 'onSave' | 'onRelease' | 'companionProblem' | 'whisper' | 'whisperProblem' | 'onWhisper'>) {
  const whispers = entries.filter((e) => e.kind === 'whisper');
  return (
    <div className="info-body">
      <h3>{t.around}</h3>
      <HereList room={room} data={data} onSave={onSave} />
      <Part label={playText.companions.label} value={data.companions}>
        {(companions) => <Companions companions={companions} onRelease={onRelease} problem={companionProblem} />}
      </Part>
      <Fold title={playText.private.whisper} open>
        <section aria-label={playText.private.whisper}>
          <Whispers whispers={whispers} allies={room.you.allies} canSend={room.you.role === 'player' && !room.you.astral} problem={whisperProblem} onSend={onWhisper} {...whisper} />
        </section>
      </Fold>
    </div>
  );
}

/** The right panel of the desktop page (340): four tabs and the one that is open. */
export function InfoPanel(props: InfoData & { initial?: InfoTab }) {
  const [tab, setTab] = useState<InfoTab>(props.initial ?? 'place');
  return (
    <aside className="info-panel" aria-label={t.label}>
      <RovingTabs label={t.label} prefix={PREFIX} tabs={TAB_DEFS} active={tab} onPick={setTab} />
      <div role="tabpanel" id={panelId(PREFIX, tab)} aria-labelledby={tabId(PREFIX, tab)} className="info-scroll" tabIndex={0}>
        {tab === 'place' && <PlacePanel {...props} />}
        {tab === 'self' && <SelfPanel {...props} />}
        {tab === 'bag' && <BagPanel {...props} />}
        {tab === 'people' && <PeoplePanel {...props} />}
      </div>
    </aside>
  );
}
