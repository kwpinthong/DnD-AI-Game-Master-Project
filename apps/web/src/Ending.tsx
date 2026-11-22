import {
  PHASE_LABEL,
  RATING_COMMENT_MAX_LENGTH,
  RATING_MAX,
  RATING_MIN,
  type EndingPath,
  type GameRatingView,
  type GameReveal,
  type GameRevealPlayer,
  type Phase,
} from '@isekai/protocol';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ratingApi, type RatingResult } from './rating-api.ts';
import { Button } from './ui/Button.tsx';
import { ErrorState, Skeleton } from './ui/parts.tsx';
import { endText } from './ui/strings.ts';
import './ending.css';

/**
 * The end page (GEN-091, Screens and Flows v2 §6): the ending, everyone's fate and secrets, then the game
 * score 1–10 and the 👍 on rulings, in that order on one page. Built on the GEN-099 contract; the rating
 * endpoints are GEN-078's, so until the server has them this page shows the reveal and an error state for
 * the rating part.
 */

export const when = (p: { day: number; phase: Phase; turn?: number }) =>
  `วันที่ ${p.day} · ${PHASE_LABEL[p.phase]}${p.turn === undefined ? '' : ` · เทิร์น ${p.turn}/2`}`;

const PATH_TEXT: Record<EndingPath, string> = {
  good: 'เส้นทาง Good: ม่านปาฏิหาริย์เบี่ยงอุกกาบาตปกป้องเมือง',
  evil: 'เส้นทาง Evil: ดูดซับพลังอุกกาบาตครองโลก',
  neutral: 'เส้นทาง Neutral: ร่วมกับแอสทราและเซเรน่าลบล้างผลเป็นศูนย์',
  none: 'ไม่มีเส้นทางใดสำเร็จ: อุกกาบาตชนเมือง',
};
const OUTCOME_TEXT = { survived: 'รอดชีวิต', defeated: 'พ่ายแพ้ (Bad Ending)' } as const;

// ---------- rating state ----------

type RatingState = { state: 'loading' } | { state: 'error' } | { state: 'ready'; rating: GameRatingView };

export interface RatingHandle {
  state: RatingState;
  reload: () => void;
  /** Each returns null on success or the Thai reason. */
  submit: (score: number, comment: string) => Promise<string | null>;
  toggleLike: (sourceRef: string, on: boolean) => Promise<string | null>;
}

/** Loads the rating of an ended game and keeps it in step with every answer (`enabled` false = no request). */
export function useRating(apiBaseUrl: string | undefined, token: string | undefined, enabled: boolean): RatingHandle {
  const api = useMemo(() => (apiBaseUrl !== undefined && token ? ratingApi(apiBaseUrl, token) : null), [apiBaseUrl, token]);
  const [state, setState] = useState<RatingState>({ state: 'loading' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const take = useCallback((result: RatingResult): string | null => {
    if (!alive.current) return null;
    if (result.ok) setState({ state: 'ready', rating: result.rating });
    return result.ok ? null : result.message;
  }, []);

  const load = useCallback(async () => {
    if (!api) return setState({ state: 'error' });
    setState({ state: 'loading' });
    const result = await api.get();
    if (alive.current && !result.ok) setState({ state: 'error' });
    take(result);
  }, [api, take]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return {
    state,
    reload: () => void load(),
    submit: async (score, comment) => (api ? take(await api.put({ score, comment })) : null),
    toggleLike: async (sourceRef, on) => (api ? take(on ? await api.like(sourceRef) : await api.unlike(sourceRef)) : null),
  };
}

// ---------- reveal: ending + fates + secrets ----------

function FateCard({ player: p, rating, onToggleLike }: { player: GameRevealPlayer; rating: GameRatingView | null; onToggleLike: (ref: string, on: boolean) => void }) {
  return (
    <article aria-label={p.lobbyName} className="fate">
      <header className="fate__head">
        <h4 className="fate__name">{p.characterName}</h4>
        <p className="fate__who">
          {p.appearance && <span>{p.appearance}</span>}
          <span>{endText.player(p.lobbyName)}</span>
        </p>
        <p className={`fate__outcome fate__outcome--${p.outcome ?? 'unknown'}`}>{p.outcome === null ? endText.noRecord : OUTCOME_TEXT[p.outcome]}</p>
      </header>
      <dl className="fate__facts">
        <div>
          <dt>{endText.spawn}</dt>
          <dd>{p.spawn ?? endText.noRecord}</dd>
        </div>
        {p.finalTitle && (
          <div>
            <dt>{endText.finalTitle}</dt>
            <dd className="fate__title">{p.finalTitle}</dd>
          </div>
        )}
        <div>
          <dt>{endText.karma}</dt>
          {/* Q-196: the tier word is the label, the number small in brackets. */}
          <dd>
            <span>{p.karmaTier}</span> <small>({p.karma})</small>
          </dd>
        </div>
        <div>
          <dt>{endText.companions}</dt>
          <dd>{p.companions.length === 0 ? endText.none : p.companions.join(', ')}</dd>
        </div>
      </dl>
      {p.epilogue && <p className="fate__epilogue">{p.epilogue}</p>}
      <h5 className="fate__secrets-title">{endText.secrets}</h5>
      {p.secretActions.length === 0 ? (
        <p className="fate__no-secrets">{endText.noSecrets}</p>
      ) : (
        <ul className="fate__secrets">
          {p.secretActions.map((s, i) => {
            const ref = s.sourceRef;
            const liked = Boolean(ref && rating?.liked.includes(ref));
            return (
              <li key={i} className="secret-row">
                <span className="secret-row__when">{when(s)}</span>
                <span className="secret-row__text">{s.text}</span>
                {rating && ref && (
                  <Button className="secret-row__like" aria-pressed={liked} aria-label={endText.likeLabel(s.text)} onClick={() => onToggleLike(ref, !liked)}>
                    <span aria-hidden="true">👍</span>
                    {liked ? endText.liked : endText.like}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

/** GEN-059 C5: the secrets of everyone, only once the game ended (the server sends `reveal` then only). */
export function EndingReveal({
  reveal,
  rating,
  onToggleLike,
  endingId,
  fatesId,
}: {
  reveal: GameReveal;
  /** null = the rating is not loaded (or failed): no 👍 buttons. */
  rating: GameRatingView | null;
  onToggleLike: (sourceRef: string, on: boolean) => void;
  endingId?: string;
  fatesId?: string;
}) {
  const [only, setOnly] = useState('');
  const players = reveal.players.filter((p) => only === '' || p.memberId === only);
  return (
    <section aria-label="ความลับของทุกคน" className="end-reveal">
      <div className="end-scene" id={endingId}>
        <h3 className="end-scene__title">{endText.ending}</h3>
        <p className="end-scene__path">{reveal.path === null ? 'ไม่มีบันทึกตอนจบ' : PATH_TEXT[reveal.path]}</p>
      </div>
      <div className="end-fates" id={fatesId}>
        <div className="end-fates__head">
          <h3>{endText.fates}</h3>
          {reveal.players.length > 1 && (
            <label className="end-fates__filter">
              {endText.filter}
              <select value={only} onChange={(e) => setOnly(e.target.value)}>
                <option value="">{endText.everyone}</option>
                {reveal.players.map((p) => (
                  <option key={p.memberId} value={p.memberId}>
                    {`${p.characterName} (${p.lobbyName})`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="end-fates__list">
          {players.map((p) => (
            <FateCard key={p.memberId} player={p} rating={rating} onToggleLike={onToggleLike} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- rating: form, sent, learning status ----------

const SCORES = Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, i) => RATING_MIN + i);

function RatingForm({ mine, onSubmit, onCancel }: { mine: GameRatingView['mine']; onSubmit: (score: number, comment: string) => Promise<string | null>; onCancel?: () => void }) {
  const name = useId();
  const [score, setScore] = useState<number | null>(mine?.score ?? null);
  const [comment, setComment] = useState(mine?.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (score === null) return setError(endText.pickScore);
    setBusy(true);
    const problem = await onSubmit(score, comment.trim());
    setBusy(false);
    setError(problem);
  }

  return (
    <form className="rating__form" onSubmit={submit}>
      <fieldset className="rating__scores">
        <legend>{endText.score}</legend>
        {SCORES.map((n) => (
          <label key={n} className="rating__score">
            <input type="radio" name={name} value={n} checked={score === n} onChange={() => setScore(n)} />
            <span>{n}</span>
          </label>
        ))}
      </fieldset>
      <label className="rating__comment">
        {endText.comment}
        <textarea rows={3} maxLength={RATING_COMMENT_MAX_LENGTH} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="rating__actions">
        <Button type="submit" variant="primary" loading={busy}>
          {mine ? endText.saveEdit : endText.send}
        </Button>
        {onCancel && <Button onClick={onCancel}>{endText.cancel}</Button>}
      </div>
    </form>
  );
}

/** Q-163 / Q-164 / Q-222: passes when the average is over 8 and at least half the members (GM counted) rated. */
function LearningStatus({ rating }: { rating: GameRatingView }) {
  const need = Math.ceil(rating.members / 2);
  const verdict = rating.eligible
    ? { tone: 'passed', title: endText.passed, note: endText.passedNote }
    : rating.blocker === 'too_few_raters'
      ? { tone: 'waiting', title: endText.waiting(Math.max(1, need - rating.raters)), note: endText.waitingNote }
      : rating.blocker === 'score_too_low'
        ? { tone: 'failed', title: endText.failed, note: endText.failedNote }
        : { tone: 'waiting', title: endText.notYet, note: endText.waitingNote };
  return (
    <div role="status" aria-label={endText.learning} className={`learning learning--${verdict.tone}`}>
      <p className="learning__verdict">{verdict.title}</p>
      <p className="learning__note">{verdict.note}</p>
      <p className="learning__average">
        {rating.average === null ? endText.noAverage(rating.raters, rating.members) : endText.average(rating.average, rating.raters, rating.members)}
      </p>
    </div>
  );
}

export function RatingSection({ rating: handle, id }: { rating: RatingHandle; id?: string }) {
  const [editing, setEditing] = useState(false);
  const { state } = handle;
  const mine = state.state === 'ready' ? state.rating.mine : null;

  async function submit(score: number, comment: string) {
    const problem = await handle.submit(score, comment);
    if (problem === null) setEditing(false);
    return problem;
  }

  return (
    <section aria-label="ให้คะแนนเกม" className="rating" id={id}>
      <h3 className="rating__title">{endText.rateTitle}</h3>
      {state.state === 'loading' && <Skeleton lines={2} />}
      {state.state === 'error' && <ErrorState message={endText.loadFailed} onRetry={handle.reload} />}
      {state.state === 'ready' && (
        <>
          {mine && !editing ? (
            <div className="rating__sent">
              <p className="rating__sent-label">{endText.sent}</p>
              <p className="rating__yours">{endText.yours(mine.score)}</p>
              {mine.comment && <p className="rating__your-comment">{mine.comment}</p>}
              <Button onClick={() => setEditing(true)}>{endText.edit}</Button>
            </div>
          ) : (
            <RatingForm mine={mine} onSubmit={submit} {...(mine ? { onCancel: () => setEditing(false) } : {})} />
          )}
          <LearningStatus rating={state.rating} />
          <p className="rating__likes">{endText.likes(state.rating.liked.length)}</p>
        </>
      )}
    </section>
  );
}

/** The sticky table of contents (phones): jumps to a part of the page. */
export function EndingToc({ parts }: { parts: readonly { id: string; label: string }[] }) {
  return (
    <nav aria-label={endText.toc} className="end-toc">
      {parts.map((p) => (
        <a
          key={p.id}
          href={`#${p.id}`}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(p.id)?.scrollIntoView({ block: 'start' });
          }}
        >
          {p.label}
        </a>
      ))}
    </nav>
  );
}
