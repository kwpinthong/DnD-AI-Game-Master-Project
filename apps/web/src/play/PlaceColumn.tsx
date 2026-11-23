import { OMEN_MAX_LENGTH, type DestinationTag, type RoomEntry, type RoomState, type TravelResponse } from '@isekai/protocol';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import publicIcon from '../assets/icons/visibility-public.svg';
import { omenBlocked, turnGroups } from '../screen-models.ts';
import { Button, MaskIcon, Skeleton, playText } from '../ui/index.ts';
import { fetchTravel, type PlayData } from './play-api.ts';

const t = playText;

// ---------- the place: name, zone, who is here, travel ----------

const MAX_CHIPS = 5;
const MAX_COMPANIONS = 3;

/** `npc` = the ref of an NPC chip (it can carry [บันทึก]). */
interface HereChip {
  text: string;
  npc?: string;
}

function hereChips(data: PlayData, allies: RoomState['you']['allies']): HereChip[] {
  const allyRefs = new Set(allies.map((a) => a.ref));
  const people = data.people.map((p) => ({
    text: [p.name ?? p.appearance, p.injury === 'ปกติ' ? null : p.injury === 'หมดสติ' ? t.self.injury.down : p.injury, p.socialTitle, allyRefs.has(p.ref) ? t.place.ally : null]
      // GEN-143: a title the same as the look shows once.
      .filter((s, i, all): s is string => Boolean(s) && all.indexOf(s) === i)
      .join(' · '),
  }));
  return [...people, ...data.npcs.map((n) => ({ text: n.name, npc: n.nameRevealed ? n.ref : undefined }))];
}

/** The place's name, zone, who sees it and [เดินทาง] (the "สถานที่" tab). */
export function PlaceTitle({ room, onTravel }: { room: RoomState; onTravel: (() => void) | null }) {
  const { you } = room;
  const astral = Boolean(you.astral);
  return (
    <header className="play-place__head" aria-label={t.place.label}>
      <div className="play-place__title">
        <h3 className="display play-place__name">{astral ? t.lock.astral_spirit : (you.place?.name ?? t.place.nowhere)}</h3>
        {!astral && you.place?.zone && <span className="muted">{you.place.zone.name}</span>}
        {astral && you.lock && <span className="muted">{you.lock.message}</span>}
        {!astral && (
          <span className="badge badge--public play-place__seen">
            <MaskIcon src={publicIcon} />
            {t.place.seenBy}
          </span>
        )}
        {onTravel && (
          <Button className="play-place__travel" onClick={onTravel} disabled={you.lock !== null}>
            {t.place.travel}
          </Button>
        )}
      </div>
    </header>
  );
}

/** Who is here (people by the name the payload gives or how they look, NPCs); an NPC not yet yours can be saved (Q-268b). */
export function HereList({ room, data, onSave }: { room: RoomState; data: PlayData; onSave: ((ref: string) => void) | null }) {
  const { you } = room;
  const chips = hereChips(data, you.allies);
  const mine = new Set((data.companions ?? []).map((c) => c.ref));
  const canSave = onSave !== null && data.companions != null && data.companions.length < MAX_COMPANIONS;
  if (you.astral) return null;
  if (chips.length === 0) return <p className="muted play-here--none">{data.seenBy === null ? '' : t.place.nobody}</p>;
  return (
    <ul className="play-here" aria-label={t.place.here}>
      {chips.slice(0, MAX_CHIPS).map((chip, i) => (
        <li key={i} className="chip">
          {chip.text}
          {canSave && chip.npc && !mine.has(chip.npc) && (
            <Button aria-label={t.companions.saveName(chip.text)} onClick={() => onSave(chip.npc!)}>
              {t.companions.save}
            </Button>
          )}
        </li>
      ))}
      {chips.length > MAX_CHIPS && (
        <li className="chip" title={chips.slice(MAX_CHIPS).map((c) => c.text).join(', ')}>
          {t.place.more(chips.length - MAX_CHIPS)}
        </li>
      )}
    </ul>
  );
}

const TAG: Record<DestinationTag, string> = t.travel.tag;

/** The travel sheet (GEN-066) over the feed: zones, what a trip costs, and [ไป] / [แทรกซึม] per destination. */
export function TravelSheet({
  apiBaseUrl,
  token,
  problem,
  busy,
  onGo,
  onClose,
}: {
  apiBaseUrl: string;
  token: string;
  /** Why the server refused the last move. */
  problem: string | undefined;
  busy: boolean;
  onGo: (id: string) => void;
  onClose: () => void;
}) {
  const [travel, setTravel] = useState<TravelResponse | null>();
  useEffect(() => {
    let live = true;
    void fetchTravel(apiBaseUrl, token).then((r) => live && setTravel(r.kind === 'ok' ? r.data : null));
    return () => {
      live = false;
    };
  }, [apiBaseUrl, token]);

  return (
    <section className="play-travel" role="dialog" aria-label={t.place.travel}>
      <header className="play-travel__head">
        <h3>{travel?.from ? t.travel.from(travel.from.name) : t.place.travel}</h3>
        <Button onClick={onClose}>{t.travel.close}</Button>
      </header>
      {problem && <p role="alert">{problem}</p>}
      {travel === undefined && <Skeleton label={t.travel.loading} />}
      {travel === null && <p role="alert">{t.travel.failed}</p>}
      {travel && travel.zones.length === 0 && <p className="muted">{t.travel.none}</p>}
      {travel?.zones.map((group) => (
        <section key={group.zone.id} className="play-travel__zone" aria-label={group.zone.name}>
          <h4>{group.zone.name}</h4>
          <p className="muted">{group.sameZone ? t.travel.sameZone(group.staminaCost) : t.travel.otherZone(group.staminaCost)}</p>
          <ul className="play-list">
            {group.destinations.map((d) => {
              const verb = d.action === 'infiltrate' ? t.travel.infiltrate : t.travel.go;
              return (
                <li key={d.id} className="play-travel__dest">
                  <span className="play-travel__name">{d.name}</span>
                  {d.tags.map((tag) => (
                    <span key={tag} className="chip">
                      {TAG[tag]}
                    </span>
                  ))}
                  {d.note && <small>{d.note}</small>}
                  {d.action ? (
                    <Button className="play-travel__go" aria-label={`${verb} ${d.name}`} disabled={busy} onClick={() => onGo(d.id)}>
                      {verb}
                    </Button>
                  ) : (
                    <small className="play-travel__go">{t.travel.cannot}</small>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}

// ---------- 4.4 the public feed ----------

export function EntryGroups({ entries, empty, children }: { entries: readonly RoomEntry[]; empty: string; children: (entry: RoomEntry) => ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = entries.at(-1)?.seq;
  // New entries come in at the bottom: keep the newest in view.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);
  return (
    <div className="play-scroll" ref={scroller} tabIndex={0}>
      {entries.length === 0 ? (
        <p className="muted play-empty">{empty}</p>
      ) : (
        turnGroups(entries).map((group) => (
          <section key={group.key} className="play-turn">
            <h4 className="play-turn__head">{group.heading}</h4>
            <ol className="play-entries">{group.entries.map(children)}</ol>
          </section>
        ))
      )}
    </div>
  );
}

// ---------- 4h Astral Spirit: one omen a night to one player (Q-193) ----------

export function OmenBox({
  room,
  problem,
  onSend,
}: {
  room: RoomState;
  problem: string | undefined;
  /** False = the socket is not open. */
  onSend: (to: string, text: string) => void;
}) {
  const astral = room.you.astral;
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [local, setLocal] = useState<string>();
  const toId = useId();
  const textId = useId();
  if (!astral) return null;
  const targets = astral.omen.targets;
  const blocked = omenBlocked(room, astral.omen.canSend) ?? (targets.length === 0 ? t.omen.noTarget : null);
  const target = targets.find((x) => x.ref === to) ?? targets[0];

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    if (text.trim() === '') return setLocal(t.omen.empty);
    setLocal(undefined);
    onSend(target.ref, text.trim());
  }

  return (
    <form className="play-action play-omen" onSubmit={submit} aria-label={t.omen.form}>
      <p className="play-action__hint">{t.omen.intro}</p>
      <div className="play-omen__row">
        <label htmlFor={toId}>{t.omen.to}</label>
        <select id={toId} value={target?.ref ?? ''} disabled={blocked !== null} onChange={(e) => setTo(e.target.value)}>
          {targets.map((x) => (
            <option key={x.ref} value={x.ref}>
              {x.label}
            </option>
          ))}
        </select>
      </div>
      <div className="play-action__write">
        <label htmlFor={textId}>{t.omen.text(OMEN_MAX_LENGTH - [...text].length)}</label>
        <textarea id={textId} value={text} maxLength={OMEN_MAX_LENGTH} rows={2} disabled={blocked !== null} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="play-action__controls">
        {blocked && <p className="play-action__quota">{blocked}</p>}
        <Button className="play-action__send" variant="primary" type="submit" disabled={blocked !== null}>
          {t.omen.send}
        </Button>
      </div>
      {(local ?? problem) && <p role="alert">{local ?? problem}</p>}
    </form>
  );
}
