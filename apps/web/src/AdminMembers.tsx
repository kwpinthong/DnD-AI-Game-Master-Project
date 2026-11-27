import { formatInviteCode, type AdminGameRow, type AdminMemberRow } from '@isekai/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { fetchAdminMembers, kickAdminMember, renewAdminInviteCode, type AdminResult } from './admin-api.ts';
import { Button } from './ui/Button.tsx';
import { ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { EmptyState, ErrorState, Skeleton } from './ui/parts.tsx';
import { adminMembersText as t } from './ui/strings.ts';

interface Props {
  apiBaseUrl: string;
  token: string;
  game: AdminGameRow;
  onForbidden: (message: string) => void;
}

/**
 * ISK-020: the players of one game in the เกม tab (ISK-018's members), the kick and a new invite code; neither on an
 * ended game (finale / game_over / closed = phase `ended`, like ISK-018's already_ended). The parent keys it by game,
 * so a late answer for the game shown before is dropped.
 */
export function AdminMembers({ apiBaseUrl, token, game, onForbidden }: Props) {
  const titleId = useId();
  const [members, setMembers] = useState<AdminMemberRow[] | 'loading' | { error: string }>('loading');
  const [attempt, setAttempt] = useState(0);
  const [kicking, setKicking] = useState<AdminMemberRow | null>(null);
  const [renewing, setRenewing] = useState(false);
  const onForbiddenRef = useRef(onForbidden);
  onForbiddenRef.current = onForbidden;
  const section = useRef<HTMLElement>(null);
  const open = game.phase !== 'ended';

  // At 390 px the panel sits under the whole list. Braces: Chrome's scrollIntoView answers a Promise, which React
  // would take for the cleanup (jsdom has none).
  useEffect(() => {
    void section.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  useEffect(() => {
    let live = true;
    setMembers('loading');
    void fetchAdminMembers(apiBaseUrl, token, game.id).then((result) => {
      if (!live) return;
      if (result.kind === 'forbidden') return onForbiddenRef.current(result.message);
      setMembers(result.kind === 'ok' ? result.data.members : { error: result.message });
    });
    return () => {
      live = false;
    };
  }, [apiBaseUrl, token, game.id, attempt]);

  return (
    <section ref={section} aria-labelledby={titleId} className="amembers">
      <div className="amembers__head">
        <h3 id={titleId}>{t.title(game.name)}</h3>
        {open && <Button onClick={() => setRenewing(true)}>{t.newCode}</Button>}
      </div>
      {members === 'loading' ? (
        <Skeleton lines={3} label={t.loading} />
      ) : !Array.isArray(members) ? (
        <ErrorState message={members.error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : members.length === 0 ? (
        <EmptyState title={t.empty} />
      ) : (
        <table aria-labelledby={titleId} className="agames">
          <thead>
            <tr>
              <th>{t.head.name}</th>
              <th>{t.head.role}</th>
              <th>{t.head.character}</th>
              <th>{t.head.ready}</th>
              <th>{t.head.status}</th>
              <th>
                <span className="sr-only">{t.kick}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <th scope="row">{m.name}</th>
                <td data-label={t.head.role}>{t.role[m.role]}</td>
                <td data-label={t.head.character}>{m.hasCharacter ? t.character.yes : t.character.no}</td>
                <td data-label={t.head.ready}>{m.ready ? t.ready.yes : t.ready.no}</td>
                <td data-label={t.head.status}>{m.kickedAt === null ? t.status.in : t.status.kicked}</td>
                <td>
                  {open && m.kickedAt === null && (
                    <Button variant="danger" aria-label={t.kickLabel(m.name)} onClick={() => setKicking(m)}>
                      {t.kick}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {kicking && (
        <KickDialog
          {...{ apiBaseUrl, token, onForbidden }}
          gameId={game.id}
          member={kicking}
          onCancel={() => setKicking(null)}
          onKicked={(list) => {
            setMembers(list);
            setKicking(null);
          }}
        />
      )}
      {renewing && <InviteCodeDialog {...{ apiBaseUrl, token, onForbidden }} gameId={game.id} onDone={() => setRenewing(false)} />}
    </section>
  );
}

/** One request at a time: a second press before React renders the disabled button sends nothing. Errors stay in the box. */
function useSendOnce<T>(send: () => Promise<AdminResult<T>>, onOk: (data: T) => void, onForbidden: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  async function run() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const result = await send();
    sending.current = false;
    setBusy(false);
    if (result.kind === 'ok') onOk(result.data);
    else if (result.kind === 'forbidden') onForbidden(result.message);
    else setError(result.message);
  }
  return { busy, error, run: () => void run() };
}

function KickDialog({
  apiBaseUrl,
  token,
  gameId,
  member,
  onForbidden,
  onCancel,
  onKicked,
}: Omit<Props, 'game'> & { gameId: string; member: AdminMemberRow; onCancel: () => void; onKicked: (members: AdminMemberRow[]) => void }) {
  const { busy, error, run } = useSendOnce(() => kickAdminMember(apiBaseUrl, token, gameId, member.id), (d) => onKicked(d.members), onForbidden);
  return (
    <ConfirmDialog title={t.kickTitle(member.name)} confirmLabel={t.kickConfirm} cancelLabel={t.cancel} busy={busy} error={error} onConfirm={run} onCancel={onCancel}>
      {t.kickText(member.name)}
    </ConfirmDialog>
  );
}

/** The new code lives only in this box: closing it unmounts the code; it is never logged, stored or put in the URL. */
function InviteCodeDialog({ apiBaseUrl, token, gameId, onForbidden, onDone }: Omit<Props, 'game'> & { gameId: string; onDone: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const { busy, error, run } = useSendOnce(() => renewAdminInviteCode(apiBaseUrl, token, gameId), (d) => setCode(formatInviteCode(d.inviteCode)), onForbidden);
  if (code === null) {
    return (
      <ConfirmDialog title={t.newCodeTitle} confirmLabel={t.newCodeConfirm} cancelLabel={t.cancel} busy={busy} error={error} onConfirm={run} onCancel={onDone}>
        {t.newCodeText}
      </ConfirmDialog>
    );
  }
  return <CodeBox code={code} onDone={onDone} />;
}

function CodeBox({ code, onDone }: { code: string; onDone: () => void }) {
  const id = useId();
  const box = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<'copied' | 'manual' | null>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);

  async function copy() {
    // Selected first: a clipboard call that never settles still leaves the code ready to copy by hand.
    box.current?.focus();
    box.current?.select();
    try {
      // No clipboard (http, old browser) throws here as well as a refused permission.
      await navigator.clipboard.writeText(code);
      setCopied('copied');
    } catch {
      setCopied('manual');
    }
  }

  return (
    <div className="dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}title`}
        aria-describedby={`${id}note`}
        className="dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone();
        }}
      >
        <h3 id={`${id}title`} className="dialog__title">
          {t.codeTitle}
        </h3>
        <input ref={box} readOnly value={code} aria-label={t.codeTitle} className="invite-code" />
        <p id={`${id}note`} className="dialog__text">
          {t.codeNote}
        </p>
        {copied && (
          <p role="status" className="dialog__text">
            {copied === 'copied' ? t.copied : t.copyYourself}
          </p>
        )}
        <div className="dialog__actions">
          <Button onClick={() => void copy()}>{t.copy}</Button>
          <Button variant="primary" onClick={onDone}>
            {t.done}
          </Button>
        </div>
      </div>
    </div>
  );
}
