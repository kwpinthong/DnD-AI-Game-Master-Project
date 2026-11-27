import { PHASES, weatherText, type CharacterView, type RoomState } from '@isekai/protocol';
import type { ReactNode } from 'react';
import coinIcon from '../../assets/icons/status-coin.svg';
import hpIcon from '../../assets/icons/status-hp.svg';
import staminaIcon from '../../assets/icons/status-stamina.svg';
import { injuryWord, staminaWord, topBar } from '../../screen-models.ts';
import { Button, MaskIcon, playText } from '../../ui/index.ts';
import { Avatar } from './Bubbles.tsx';
import { PERIOD_WORD, dialAngle, dialLabel } from './chat-model.ts';
import { ClockHud } from './ClockHud.tsx';

const t = playText.chat.hud;

/** Avatar + the character's name + how the others see them (the alias); `character` undefined while it loads. */
export function CharacterTag({ character }: { character: (Pick<CharacterView, 'name' | 'appearance'> & { avatarId?: string | null }) | null | undefined }) {
  return (
    <div className="hud-who" role="group" aria-label={t.label}>
      <Avatar name={character?.name ?? '?'} size="lg" own avatarId={character?.avatarId} />
      <div>
        <div className="hud-who__name display">{character?.name ?? t.loading}</div>
        <div className="hud-who__seen">
          {t.seenAs} {character?.appearance ?? t.loading}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <span className="hud-stat">
      <MaskIcon src={icon} />
      <span className="hud-stat__label">{label}</span>
      <span className="hud-stat__value">{children}</span>
    </span>
  );
}

/** HP (number + word), Stamina (word), coins, each with its icon AND its label. */
export function StatusHud({ character }: { character: Pick<CharacterView, 'hp' | 'stamina' | 'coins'> | null | undefined }) {
  if (!character) {
    return (
      <div className="hud-stats">
        <span className="muted">{t.loading}</span>
      </div>
    );
  }
  return (
    <div className="hud-stats">
      <Stat icon={hpIcon} label={t.hp}>
        {character.hp.current}
        <span className="hud-stat__max">/{character.hp.max}</span> <span className="hud-stat__word">{injuryWord(character.hp)}</span>
      </Stat>
      <Stat icon={staminaIcon} label={t.stamina}>
        {staminaWord(character.stamina)}
      </Stat>
      <Stat icon={coinIcon} label={t.coinsLabel}>
        {character.coins}
      </Stat>
    </div>
  );
}

const SLOT_PATH = [
  // a half circle cut into 4 slots of 45 degrees: centre (60,60), radius 50, from the left
  'M10 60 A50 50 0 0 1 24.6 24.6',
  'M24.6 24.6 A50 50 0 0 1 60 10',
  'M60 10 A50 50 0 0 1 95.4 24.6',
  'M95.4 24.6 A50 50 0 0 1 110 60',
] as const;

/** The day as a half-circle dial of 4 periods with a hand on the current one; the words are in `aria-label`. */
export function PeriodDial({ room }: { room: Pick<RoomState, 'day' | 'phase' | 'turn' | 'weather'> }) {
  const now = PHASES.indexOf(room.phase);
  return (
    <svg className="hud-dial" viewBox="0 0 120 66" role="img" aria-label={dialLabel(room)}>
      {SLOT_PATH.map((d, i) => (
        <path key={d} d={d} className={i === now ? 'hud-dial__slot hud-dial__slot--now' : i < now ? 'hud-dial__slot hud-dial__slot--done' : 'hud-dial__slot'} />
      ))}
      <line className="hud-dial__hand" x1="60" y1="60" x2="60" y2="20" transform={`rotate(${dialAngle(room.phase)} 60 60)`} />
      <circle className="hud-dial__pin" cx="60" cy="60" r="4" />
    </svg>
  );
}

/** The whole top bar: who you are, your values, the time, and the way to the menu / history. `character` is null for the Human GM. */
export function HudBar({ room, character, menuOpen, onMenu, onHistory }: { room: RoomState; character: CharacterView | null | undefined; menuOpen: boolean; onMenu: () => void; onHistory: () => void }) {
  const t2 = playText.top;
  return (
    <div className="hud">
      {character !== null && <CharacterTag character={character} />}
      {character !== null && <StatusHud character={character} />}
      <ClockHud room={room}>
        <div className="hud-menu">
          <Button onClick={onHistory}>{t2.history}</Button>
          <Button aria-expanded={menuOpen} onClick={onMenu}>
            {t2.menu}
          </Button>
        </div>
      </ClockHud>
    </div>
  );
}

/**
 * The phone's top bar (GEN-123), two lines: the place + a small dial with the period / [เมนู], then HP, Stamina, coins +
 * "ส่งแล้ว x/y". Same dial, same labels as the desktop bar; History lives in the menu here.
 */
export function CompactHudBar({ room, character, menuOpen, onMenu }: { room: RoomState; character: CharacterView | null | undefined; menuOpen: boolean; onMenu: () => void }) {
  const bar = topBar(room);
  const place = room.you.astral ? playText.lock.astral_spirit : (room.you.place?.name ?? playText.place.nowhere);
  return (
    <div className="hud hud--compact">
      <div className="hud-line">
        <h3 className="display hud-place">{place}</h3>
        <div className="hud-time" role="group" aria-label={playText.top.label}>
          <PeriodDial room={room} />
          <span className="hud-time__now">
            {bar.day} · {PERIOD_WORD[room.phase]} · {playText.top.turn(room.turn)}
          </span>
        </div>
        <Button aria-expanded={menuOpen} onClick={onMenu}>
          {playText.top.menu}
        </Button>
      </div>
      <div className="hud-line">
        {character !== null && <StatusHud character={character} />}
        {bar.submitted && <span className="hud-sent">{bar.submitted}</span>}
      </div>
    </div>
  );
}

/** The dial, the day, the turn, the weather and "ส่งแล้ว x/y" (the count only, Q-195). */
export function TimeHud({ room, children }: { room: RoomState; children?: ReactNode }) {
  const bar = topBar(room);
  return (
    <div className="hud-time" role="group" aria-label={playText.top.label}>
      <PeriodDial room={room} />
      <div className="hud-time__text">
        <span className="hud-time__day">{bar.day}</span>
        <span className="hud-time__now">
          {PERIOD_WORD[room.phase]} · {playText.top.turn(room.turn)}
        </span>
        <span className="hud-time__weather">
          <span className="sr-only">{playText.top.weather} </span>
          {room.weather ? weatherText(room.weather) : bar.weather}
        </span>
      </div>
      {bar.submitted && <span className="hud-sent">{bar.submitted}</span>}
      {children}
    </div>
  );
}
