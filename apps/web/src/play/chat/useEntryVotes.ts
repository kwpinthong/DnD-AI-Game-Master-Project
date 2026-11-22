import type { EntryVote, RoomEntry } from '@isekai/protocol';
import { useCallback, useMemo, useState } from 'react';
import { voteApi, type VoteResult } from '../../vote-api.ts';

/**
 * ถูกใจ / ไม่ถูกใจ on the entries (GEN-107 API, GEN-122 wiring). The press shows at once; the server's answer
 * replaces it, and a refusal puts back what was there. What the entry came with (`myVote`, also after a reload)
 * is the base, so only the changes of this session are kept here.
 */
export function useEntryVotes(apiBaseUrl: string, token: string, send?: (seq: number, vote: EntryVote | null) => Promise<VoteResult>) {
  const [local, setLocal] = useState<ReadonlyMap<number, EntryVote | null>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [problem, setProblem] = useState<string>();
  const api = useMemo(() => (send ? { vote: send } : voteApi(apiBaseUrl, token)), [apiBaseUrl, token, send]);

  const vote = useCallback(
    async (entry: Pick<RoomEntry, 'seq' | 'myVote'>, next: EntryVote | null) => {
      const before = local.has(entry.seq) ? local.get(entry.seq)! : (entry.myVote ?? null);
      setLocal((m) => new Map(m).set(entry.seq, next));
      setBusy((s) => new Set(s).add(entry.seq));
      setProblem(undefined);
      const result = await api.vote(entry.seq, next);
      setBusy((s) => {
        const copy = new Set(s);
        copy.delete(entry.seq);
        return copy;
      });
      if (result.ok) setLocal((m) => new Map(m).set(entry.seq, result.myVote));
      else {
        setLocal((m) => new Map(m).set(entry.seq, before));
        setProblem(result.message);
      }
    },
    [api, local],
  );

  return { local, busy, problem, vote };
}
