import { ResponseVoteResponse, type EntryVote } from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

/** PUT /api/game/entries/:seq/vote (GEN-107): the vote on an AI-written entry; `null` cancels. GEN-122 wires it to `VoteButtons`. */
export type VoteResult = { ok: true; myVote: EntryVote | null } | { ok: false; message: string };

const FAILED = 'ให้คะแนนไม่สำเร็จ ลองใหม่อีกครั้ง';

export const voteApi = (baseUrl: string, token: string) => ({
  vote: async (seq: number, vote: EntryVote | null): Promise<VoteResult> => {
    try {
      const res = await fetchWithTimeout(apiUrl(baseUrl, `/api/game/entries/${seq}/vote`), {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ vote }),
      });
      const parsed = ResponseVoteResponse.safeParse(await res.json());
      return res.ok && parsed.success ? { ok: true, myVote: parsed.data.myVote } : { ok: false, message: FAILED };
    } catch {
      return { ok: false, message: FAILED };
    }
  },
});
