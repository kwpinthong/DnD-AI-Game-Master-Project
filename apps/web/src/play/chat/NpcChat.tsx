import { ApiError, NPC_CHAT_MAX_LENGTH, NpcChatResponse, NpcChatStatus } from '@isekai/protocol';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { apiUrl, fetchWithTimeout } from '../../session.ts';
import { Button, Skeleton, playText } from '../../ui/index.ts';

const t = playText.npcChat;

export type NpcChatSendResult = { ok: true; data: NpcChatResponse } | { ok: false; message: string; retry: boolean };

/** What the chat box needs of the server (GEN-149); the page passes `httpNpcChatApi`, tests a fake. */
export interface NpcChatApi {
  status(): Promise<NpcChatStatus | null>;
  send(ref: string, text: string, whisper: boolean): Promise<NpcChatSendResult>;
}

export function httpNpcChatApi(baseUrl: string, token: string): NpcChatApi {
  const auth = { authorization: `Bearer ${token}` };
  return {
    async status() {
      try {
        const res = await fetchWithTimeout(apiUrl(baseUrl, '/api/game/npc-chat'), { headers: auth });
        const parsed = NpcChatStatus.safeParse(res.ok ? await res.json() : null);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async send(ref, text, whisper) {
      try {
        const res = await fetchWithTimeout(apiUrl(baseUrl, '/api/game/npc-chat'), {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ npc: ref, text, whisper }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (res.ok) {
          const parsed = NpcChatResponse.safeParse(body);
          return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: t.offline, retry: true };
        }
        const error = ApiError.safeParse(body);
        // C8: only an AI failure (503) is worth the same message again; a refusal says why instead.
        return { ok: false, message: error.success ? error.data.message : t.offline, retry: res.status >= 500 };
      } catch {
        return { ok: false, message: t.offline, retry: true };
      }
    },
  };
}

interface Line {
  from: 'me' | 'npc';
  text: string;
  hint?: string | null;
}

/**
 * GEN-149: the chat box with one NPC at your place, over the feed (like the travel sheet). The reply comes at once and
 * the turn does not move; the quota of the period shows, and the send button says why when it is used up (C2).
 */
export function NpcChatBox({ npc, api, onClose }: { npc: { ref: string; name: string }; api: NpcChatApi; onClose: () => void }) {
  const [status, setStatus] = useState<NpcChatStatus | null>();
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [whisper, setWhisper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; retry: { text: string; whisper: boolean } | null }>();
  const textId = useId();
  const whisperId = useId();

  useEffect(() => {
    let live = true;
    void api.status().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, [api]);

  async function send(message: string, quiet: boolean) {
    setBusy(true);
    setProblem(undefined);
    const result = await api.send(npc.ref, message, quiet);
    setBusy(false);
    if (!result.ok) return setProblem({ message: result.message, retry: result.retry ? { text: message, whisper: quiet } : null });
    setLines((all) => [...all, { from: 'me', text: message }, { from: 'npc', text: result.data.reply, hint: result.data.suggestion }]);
    setStatus(result.data.status);
    setText('');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === '') return setProblem({ message: t.empty, retry: null });
    void send(text.trim(), whisper);
  }

  const usedUp = status?.left === 0;
  return (
    <section className="play-travel npc-chat" role="dialog" aria-label={t.title(npc.name)}>
      <header className="play-travel__head">
        <h3>{t.title(npc.name)}</h3>
        <Button onClick={onClose}>{t.close}</Button>
      </header>
      <p className="muted">{t.intro}</p>
      <ol className="npc-chat__log" aria-live="polite">
        {lines.map((line, i) => (
          <li key={i} className={`npc-chat__line npc-chat__line--${line.from}`}>
            <strong className="npc-chat__who">{line.from === 'me' ? t.me : npc.name}</strong>
            <p>{line.text}</p>
            {line.hint && <small className="npc-chat__hint">{t.hint(line.hint)}</small>}
          </li>
        ))}
      </ol>
      <form className="npc-chat__form" onSubmit={submit}>
        <label htmlFor={textId}>{t.text(npc.name)}</label>
        <textarea id={textId} value={text} rows={2} maxLength={NPC_CHAT_MAX_LENGTH} disabled={usedUp} onChange={(e) => setText(e.target.value)} />
        <label className="npc-chat__whisper" htmlFor={whisperId}>
          <input id={whisperId} type="checkbox" checked={whisper} disabled={usedUp} onChange={(e) => setWhisper(e.target.checked)} />
          {t.whisper}
        </label>
        <div className="play-action__controls">
          {status === undefined && <Skeleton label={t.loading} />}
          {status === null && <small>{t.loadFailed}</small>}
          {status && status.left > 0 && <small>{t.left(status.left, status.perPeriod)}</small>}
          <Button variant="primary" type="submit" loading={busy} loadingText={t.sending} disabled={usedUp} disabledReason={t.used(status?.perPeriod ?? 0)}>
            {t.send}
          </Button>
        </div>
      </form>
      {problem && (
        <div className="npc-chat__problem">
          <p role="alert">{problem.message}</p>
          {problem.retry && (
            <Button onClick={() => void send(problem.retry!.text, problem.retry!.whisper)} disabled={busy}>
              {t.retry}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
