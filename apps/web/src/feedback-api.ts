import type { FeedbackInput } from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

export type FeedbackResult = { kind: 'ok' } | { kind: 'rate_limited' } | { kind: 'session_lost' } | { kind: 'unreachable' } | { kind: 'failed' };

/** ISK-010's POST /api/feedback with the player's session; the box says what each answer means. */
export async function postFeedback(baseUrl: string, token: string, body: FeedbackInput): Promise<FeedbackResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(apiUrl(baseUrl, '/api/feedback'), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (res.ok) return { kind: 'ok' };
  if (res.status === 429) return { kind: 'rate_limited' };
  if (res.status === 401) return { kind: 'session_lost' };
  return { kind: 'failed' };
}
