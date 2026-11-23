import { ResponseVoteResponse, type EntryVote, type VoteReason } from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

/**
 * PUT /api/game/entries/:seq/vote (GEN-107): the vote on an AI-written entry; `null` cancels. GEN-122 wires it to
 * `VoteButtons`. GEN-168: `reasons` go with a 👎 only; `myReasons` comes back with a 👎.
 */
export type VoteResult = { ok: true; myVote: EntryVote | null; myReasons?: VoteReason[] } | { ok: false; message: string };

const FAILED = 'ให้คะแนนไม่สำเร็จ ลองใหม่อีกครั้ง';

export const voteApi = (baseUrl: string, token: string) => ({
  vote: async (seq: number, vote: EntryVote | null, reasons?: readonly VoteReason[]): Promise<VoteResult> => {
    try {
      const res = await fetchWithTimeout(apiUrl(baseUrl, `/api/game/entries/${seq}/vote`), {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(reasons ? { vote, reasons } : { vote }),
      });
      const parsed = ResponseVoteResponse.safeParse(await res.json());
      if (!res.ok || !parsed.success) return { ok: false, message: FAILED };
      return { ok: true, myVote: parsed.data.myVote, ...(parsed.data.myReasons ? { myReasons: parsed.data.myReasons } : {}) };
    } catch {
      return { ok: false, message: FAILED };
    }
  },
});
