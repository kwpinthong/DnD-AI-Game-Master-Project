import type { EntryVote, RoomEntry, VoteReason } from '@isekai/protocol';
import { useCallback, useMemo, useState } from 'react';
import { voteApi, type VoteResult } from '../../vote-api.ts';

type Send = (seq: number, vote: EntryVote | null, reasons?: readonly VoteReason[]) => Promise<VoteResult>;

/**
 * ถูกใจ / ไม่ถูกใจ on the entries (GEN-107 API, GEN-122 wiring). The press shows at once; the server's answer
 * replaces it, and a refusal puts back what was there. What the entry came with (`myVote`, also after a reload)
 * is the base, so only the changes of this session are kept here. GEN-168: `reasons` = the 👎 reasons changed in
 * this session (the entry's `myReasons` is the base); 👍 or a cancel empties them.
 */
export function useEntryVotes(apiBaseUrl: string, token: string, send?: Send) {
  const [local, setLocal] = useState<ReadonlyMap<number, EntryVote | null>>(new Map());
  const [reasons, setReasonMap] = useState<ReadonlyMap<number, readonly VoteReason[]>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [problem, setProblem] = useState<string>();
  const api = useMemo(() => (send ? { vote: send } : voteApi(apiBaseUrl, token)), [apiBaseUrl, token, send]);

  const run = useCallback(
    async (entry: Pick<RoomEntry, 'seq' | 'myVote' | 'myReasons'>, next: EntryVote | null, picked?: VoteReason[]) => {
      const before = local.has(entry.seq) ? local.get(entry.seq)! : (entry.myVote ?? null);
      const reasonsBefore = reasons.get(entry.seq) ?? entry.myReasons ?? [];
      setLocal((m) => new Map(m).set(entry.seq, next));
      setReasonMap((m) => new Map(m).set(entry.seq, picked ?? []));
      setBusy((s) => new Set(s).add(entry.seq));
      setProblem(undefined);
      const result = picked ? await api.vote(entry.seq, next, picked) : await api.vote(entry.seq, next);
      setBusy((s) => {
        const copy = new Set(s);
        copy.delete(entry.seq);
        return copy;
      });
      if (result.ok) {
        setLocal((m) => new Map(m).set(entry.seq, result.myVote));
        setReasonMap((m) => new Map(m).set(entry.seq, result.myReasons ?? []));
      } else {
        setLocal((m) => new Map(m).set(entry.seq, before));
        setReasonMap((m) => new Map(m).set(entry.seq, reasonsBefore));
        setProblem(result.message);
      }
    },
    [api, local, reasons],
  );

  const vote = useCallback((entry: Pick<RoomEntry, 'seq' | 'myVote' | 'myReasons'>, next: EntryVote | null) => run(entry, next), [run]);
  /** C1: the chips re-send the 👎 with the reasons picked (the 👎 itself was saved when pressed). */
  const setReasons = useCallback((entry: Pick<RoomEntry, 'seq' | 'myVote' | 'myReasons'>, picked: VoteReason[]) => run(entry, 'down', picked), [run]);

  return { local, reasons, busy, problem, vote, setReasons };
}
