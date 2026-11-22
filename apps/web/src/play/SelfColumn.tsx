import type { CharacterView, CompanionView, InventoryEntry, InventoryView } from '@isekai/protocol';
import type { ReactNode } from 'react';
import { bondBar, injuryWord, staminaWord } from '../screen-models.ts';
import { Button, Meter, Skeleton, StepBar, playText } from '../ui/index.ts';
import type { PlayData } from './play-api.ts';

const t = playText;

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="play-stat">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Gauge({ label, gauge, word }: { label: string; gauge: { current: number; max: number }; word: string }) {
  const tone = gauge.current <= 0 ? 'spent' : gauge.current * 4 < gauge.max ? 'low' : 'ok';
  return (
    <Stat label={label}>
      <span className="play-stat__value">
        {gauge.current}/{gauge.max}
      </span>
      <span className="play-stat__word">{word}</span>
      <Meter label={t.self.gauge(label, gauge.current, gauge.max)} value={gauge.current} max={gauge.max} tone={tone} />
    </Stat>
  );
}

/**
 * 4.3 your own status. Own HP / Stamina / coins are numbers with a word; Reputation is the title only and Karma
 * one of the 11 words (C3: the numbers never reach the web). `secret`: the quota line of `secretQuota`.
 */
export function SelfStatus({ character, secret, drowsy }: { character: CharacterView; secret: string; drowsy: boolean }) {
  const statuses = [...character.statuses, ...(drowsy && !character.statuses.includes(t.self.drowsy) ? [t.self.drowsy] : [])];
  return (
    <>
      <header className="play-status__who">
        <h3 className="display play-status__name">{character.name}</h3>
        <small>{t.self.realName}</small>
      </header>
      <p className="play-status__look">{character.appearance}</p>
      <dl className="play-stats">
        <Gauge label={t.self.hp} gauge={character.hp} word={injuryWord(character.hp)} />
        <Gauge label={t.self.stamina} gauge={character.stamina} word={staminaWord(character.stamina)} />
        <Stat label={t.self.coins}>{character.coins}</Stat>
        <Stat label={t.self.title}>
          <span className="play-status__title">{character.socialTitle}</span>
        </Stat>
        <Stat label={t.self.conduct}>{character.conduct}</Stat>
        <Stat label={t.self.secret}>{secret}</Stat>
      </dl>
      {statuses.length > 0 && (
        <ul className="play-chips" aria-label={t.self.statuses}>
          {statuses.map((s) => (
            <li key={s} className="chip">
              {s}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One panel of the column. The section stays the same element while its data loads, fails or reloads. */
function Part<T>({ label, value, children }: { label: string; value: T | null | undefined; children: (value: T) => ReactNode }) {
  return (
    <section className="panel panel--ornament play-panel" aria-label={label}>
      {value === undefined ? <Skeleton lines={3} /> : value === null ? <p className="muted">{t.loadFailed}</p> : children(value)}
    </section>
  );
}

const MAX_COMPANIONS = 3;

/** 4.3 companions: the alias or the name, "หลัก" for the main one, the bond as a word + 6 steps (F4, no number). */
function Companions({ companions }: { companions: CompanionView[] }) {
  return (
    <>
      <h3>{t.companions.count(companions.length)}</h3>
      {companions.length === 0 ? (
        <p className="muted">{t.companions.empty}</p>
      ) : (
        <ul className="play-list">
          {companions.map((c) => (
            <li key={c.ref} className="play-companion">
              <span className="play-companion__name">{c.name}</span>
              {c.role === 'main' && <span className="chip">{t.companions.main}</span>}
              {c.bond && (
                <span className="play-companion__bond">
                  <StepBar label={t.companions.bond(c.bond.word)} cells={bondBar(c.bond)} />
                  <span>{c.bond.word}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {companions.length > 0 && companions.length < MAX_COMPANIONS && <p className="muted play-panel__foot">{t.companions.free(MAX_COMPANIONS - companions.length)}</p>}
    </>
  );
}

const isActive = (e: InventoryEntry) => /active/i.test(e.triggerType ?? '') && e.usesLeftToday !== 0;

function Entry({ entry, onUse }: { entry: InventoryEntry; onUse: ((name: string) => void) | null }) {
  return (
    <li className="play-skill" title={entry.description}>
      <span className="play-skill__name">{entry.name}</span>
      <span className="play-skill__meta">
        {[entry.rank ? t.inventory.rank(entry.rank) : null, entry.triggerType, entry.usesLeftToday != null ? t.inventory.usesLeft(entry.usesLeftToday) : null]
          .filter((s): s is string => Boolean(s))
          .join(' · ')}
      </span>
      {onUse && isActive(entry) && (
        <Button className="play-skill__use" aria-label={t.inventory.useName(entry.name)} onClick={() => onUse(entry.name)}>
          {t.inventory.use}
        </Button>
      )}
    </li>
  );
}

/** 4.3 skills + items: name, Rank, Active "วันนี้เหลือ n" / Passive; [ใช้] puts the skill into the action box. */
function Skills({ inventory, onUse }: { inventory: InventoryView; onUse: ((name: string) => void) | null }) {
  const entries = [...inventory.skills, ...inventory.items];
  return (
    <>
      <h3>{t.inventory.heading}</h3>
      {entries.length === 0 ? (
        <p className="muted">{t.inventory.empty}</p>
      ) : (
        <ul className="play-list">
          {entries.map((e) => (
            <Entry key={e.id} entry={e} onUse={onUse} />
          ))}
        </ul>
      )}
      {inventory.discoveries.length > 0 && (
        <>
          <h4>{t.inventory.discoveries(inventory.discoveries.length)}</h4>
          <ul className="play-list play-list--small">
            {inventory.discoveries.map((d) => (
              <li key={`${d.kind}:${d.name}`}>
                {d.name}: {d.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** The left column (272): status / companions / skills + items. */
export function SelfColumn({ data, secret, drowsy, onUse }: { data: PlayData; secret: string; drowsy: boolean; onUse: ((name: string) => void) | null }) {
  return (
    <aside className="play-self" aria-label={t.self.column}>
      <Part label={t.self.status} value={data.character}>
        {(character) => <SelfStatus character={character} secret={secret} drowsy={drowsy} />}
      </Part>
      <Part label={t.companions.label} value={data.companions}>
        {(companions) => <Companions companions={companions} />}
      </Part>
      <Part label={t.inventory.label} value={data.inventory}>
        {(inventory) => <Skills inventory={inventory} onUse={onUse} />}
      </Part>
    </aside>
  );
}
