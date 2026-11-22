import { ACTION_MAX_LENGTH, FALLBACK_NARRATION_LABEL, OMEN_MAX_LENGTH, type ActionVisibility, type DestinationTag, type PlaceActionId, type RoomEntry, type RoomState, type TravelResponse } from '@isekai/protocol';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import publicIcon from '../assets/icons/visibility-public.svg';
import secretIcon from '../assets/icons/visibility-secret.svg';
import { lockDetail, lockTitle, omenBlocked, secretQuota, sentHow, turnGroups, turnName } from '../screen-models.ts';
import { Button, MaskIcon, Skeleton, playText, uiText } from '../ui/index.ts';
import { fetchTravel, type PlayData } from './play-api.ts';

const t = playText;
const VISIBILITY_LABEL = { public: uiText.visibility.public.label, secret: uiText.visibility.secret.label } as const;

/** What the player is composing for this turn. `editing`: changing an action that is already sent. */
export interface ActionDraft {
  text: string;
  visibility: ActionVisibility;
  rest: boolean;
  train: boolean;
  placeAction: PlaceActionId | null;
  editing: boolean;
}
export const EMPTY_DRAFT: ActionDraft = { text: '', visibility: 'public', rest: false, train: false, placeAction: null, editing: false };

// ---------- 4.2 the place: name, zone, who is here, travel ----------

const MAX_CHIPS = 5;

function hereChips(data: PlayData, allies: RoomState['you']['allies']): string[] {
  const allyRefs = new Set(allies.map((a) => a.ref));
  const people = data.people.map((p) =>
    [p.name ?? p.appearance, p.injury === 'ปกติ' ? null : p.injury === 'หมดสติ' ? t.self.injury.down : p.injury, p.socialTitle, allyRefs.has(p.ref) ? t.place.ally : null]
      .filter((s): s is string => Boolean(s))
      .join(' · '),
  );
  return [...people, ...data.npcs.map((n) => n.name)];
}

export function PlaceHead({ room, data, onTravel }: { room: RoomState; data: PlayData; onTravel: (() => void) | null }) {
  const { you } = room;
  const chips = hereChips(data, you.allies);
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
      {!astral &&
        (chips.length === 0 ? (
          <p className="muted play-here--none">{data.seenBy === null ? '' : t.place.nobody}</p>
        ) : (
          <ul className="play-here" aria-label={t.place.here}>
            {chips.slice(0, MAX_CHIPS).map((chip, i) => (
              <li key={i} className="chip">
                {chip}
              </li>
            ))}
            {chips.length > MAX_CHIPS && (
              <li className="chip" title={chips.slice(MAX_CHIPS).join(', ')}>
                {t.place.more(chips.length - MAX_CHIPS)}
              </li>
            )}
          </ul>
        ))}
    </header>
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

/**
 * The centre feed: what happened where you are (the server sends only what you witnessed). An Astral Spirit
 * gets every place, read-only, and picks which one to look at (Q-192).
 */
export function Feed({ entries, placeId, astral }: { entries: readonly RoomEntry[]; placeId: string | null; astral: boolean }) {
  const [only, setOnly] = useState('');
  const selectId = useId();
  const places = [...new Map(entries.flatMap((e) => (e.place ? [[e.place.id, e.place.name] as const] : []))).entries()];
  const shown = astral && only ? entries.filter((e) => e.place === null || e.place.id === only) : entries;
  return (
    <section className="play-feed" aria-label={t.feed.label}>
      {astral && (
        <div className="play-feed__astral">
          <span className="chip">{t.feed.readOnly}</span>
          <label htmlFor={selectId}>{t.feed.pickPlace}</label>
          <select id={selectId} value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="">{t.feed.allPlaces}</option>
            {places.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      <EntryGroups entries={shown} empty={t.feed.empty}>
        {(e) => (
          <li key={e.seq} className={e.place ? 'play-entry' : 'play-entry play-entry--town'}>
            {!e.place && <span className="play-entry__tag">{t.feed.town}</span>}
            {e.place && e.place.id !== placeId && <span className="play-entry__tag">{t.feed.at(e.place.name)}</span>}
            {e.fallback && <small className="fallback-label">{FALLBACK_NARRATION_LABEL}</small>}
            <p>{e.text}</p>
          </li>
        )}
      </EntryGroups>
    </section>
  );
}

// ---------- 4.6 the action box + its locked states (4b–4g) ----------

function GmStatus({ room, onRetry }: { room: RoomState; onRetry: () => void }) {
  if (!room.gmStatus) return null;
  return (
    <div className="play-gm-status">
      <p role="alert">{room.gmStatus.message}</p>
      {room.gmStatus.canRetry && <Button onClick={onRetry}>{t.retry}</Button>}
    </div>
  );
}

export function ActionBox({
  room,
  seenBy,
  draft,
  setDraft,
  problem,
  sending,
  onSend,
  onRetry,
}: {
  room: RoomState;
  /** People + NPCs at your place who would see a public action; null = not known yet. */
  seenBy: number | null;
  draft: ActionDraft;
  setDraft: (next: ActionDraft) => void;
  problem: string | undefined;
  sending: boolean;
  onSend: (draft: ActionDraft) => void;
  onRetry: () => void;
}) {
  const { you } = room;
  const group = useId();
  const textId = useId();
  const quota = secretQuota(room);
  const lock = you.lock;
  const sent = you.action;
  const composing = !lock && (!sent || draft.editing);
  const left = ACTION_MAX_LENGTH - [...draft.text].length;
  // The quota can run out while ลับ is picked (the server answers the other tab): fall back to เปิดเผย.
  const visibility: ActionVisibility = draft.visibility === 'secret' && you.secretUsed ? 'public' : draft.visibility;
  const chips = you.placeActions;
  const now = turnName(room);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSend({ ...draft, visibility });
  }

  function pickChip(id: PlaceActionId, label: string) {
    const on = draft.placeAction !== id;
    setDraft({ ...draft, placeAction: on ? id : null, rest: on && id !== 'train', train: on && id === 'train', text: on && draft.text.trim() === '' ? label : draft.text });
  }

  return (
    <form className={visibility === 'secret' && composing ? 'play-action play-action--secret' : 'play-action'} onSubmit={submit} aria-label={t.action.form}>
      <GmStatus room={room} onRetry={onRetry} />
      {sent && !draft.editing && (
        <div className="play-action__sent">
          <p>{t.action.sent(sentHow(sent, VISIBILITY_LABEL), sent.text)}</p>
          {!lock && room.status === 'collecting' && (
            <Button onClick={() => setDraft({ text: sent.text, visibility: sent.visibility, rest: sent.rest, train: Boolean(sent.train), placeAction: null, editing: true })}>
              {t.action.edit}
            </Button>
          )}
        </div>
      )}
      {sent && !draft.editing && !lock && (
        <p className="play-action__wait">{room.mode === 'single' ? t.action.waitResult : t.action.waitOthers(t.submitted(room.submittedCount, room.members.filter((m) => m.role === 'player').length))}</p>
      )}
      {lock && (
        <div className="play-lock" role="note" aria-label={lockTitle(lock.code)}>
          <strong>{lockTitle(lock.code)}</strong>
          <p>{lock.message}</p>
          {lockDetail(room, lock.code) && <p className="muted">{lockDetail(room, lock.code)}</p>}
        </div>
      )}
      {(composing || lock) && (
        <>
          <div className="play-action__write">
            <label htmlFor={textId}>{t.action.label(now)}</label>
            <small>{t.action.left(left)}</small>
            <textarea
              id={textId}
              value={lock ? '' : draft.text}
              disabled={Boolean(lock)}
              placeholder={lock ? t.action.closed : undefined}
              rows={2}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </div>
          <div className="play-action__controls">
            <fieldset className="play-vis" disabled={Boolean(lock)}>
              <legend className="sr-only">{t.action.who}</legend>
              <label className="play-vis__opt play-vis__opt--public" title={uiText.visibility.public.tooltip}>
                <input type="radio" name={group} checked={visibility === 'public'} onChange={() => setDraft({ ...draft, visibility: 'public' })} />
                <MaskIcon src={publicIcon} />
                {VISIBILITY_LABEL.public}
              </label>
              <label className="play-vis__opt play-vis__opt--secret" title={uiText.visibility.secret.tooltip}>
                <input type="radio" name={group} checked={visibility === 'secret'} disabled={you.secretUsed} onChange={() => setDraft({ ...draft, visibility: 'secret' })} />
                <MaskIcon src={secretIcon} />
                {VISIBILITY_LABEL.secret}
              </label>
            </fieldset>
            <Button aria-pressed={draft.rest && !draft.placeAction} disabled={Boolean(lock)} onClick={() => setDraft({ ...draft, rest: !(draft.rest && !draft.placeAction), train: false, placeAction: null })}>
              {t.action.rest}
            </Button>
            {/* The server does not send the place's chips yet (GEN-069 pending): TRAIN stays reachable without them. */}
            {chips === undefined && (
              <Button aria-pressed={draft.train} disabled={Boolean(lock)} onClick={() => setDraft({ ...draft, train: !draft.train, rest: false, placeAction: null })}>
                {t.action.train}
              </Button>
            )}
            {chips?.map((chip) => (
              <Button key={chip.id} aria-pressed={draft.placeAction === chip.id} disabled={Boolean(lock) || chip.blocked !== null} title={chip.blocked ?? undefined} onClick={() => pickChip(chip.id, chip.label)}>
                {chip.label}
              </Button>
            ))}
            <Button className="play-action__send" variant="primary" type="submit" disabled={Boolean(lock)} loading={sending} loadingText={t.action.sending}>
              {sent ? t.action.resend : t.action.send}
            </Button>
          </div>
          {!lock && (
            <p className="play-action__effect">
              {quota.blocked && <span className="play-action__quota">{quota.blocked}</span>}
              <span>{visibility === 'secret' ? t.action.secretEffect : t.action.publicEffect(seenBy)}</span>
            </p>
          )}
          {!lock && room.phase === 'NOCTHERION' && <p className="play-action__hint">{t.action.night}</p>}
        </>
      )}
      {you.drowsy && (
        <p className="play-action__hint" role="note">
          {t.action.drowsy}
        </p>
      )}
      {problem && <p role="alert">{problem}</p>}
    </form>
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
