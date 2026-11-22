import { GmConsoleResponse, type GmPendingTurn } from '@isekai/protocol';
import type { Call } from './visibility-fixture.ts';

/** Waits (up to 5 s) until the console shows a turn held for the Human GM (GEN-058, Q-030). */
export async function heldTurn(call: Call, gmToken: string): Promise<GmPendingTurn> {
  const until = Date.now() + 5_000;
  for (;;) {
    const res = await call('GET', '/api/game/gm/console', { token: gmToken });
    if (res.status !== 200) throw new Error(`console answered ${res.status}: ${JSON.stringify(res.body)}`);
    const pending = GmConsoleResponse.parse(res.body).pending;
    if (pending) return pending;
    if (Date.now() > until) throw new Error('no turn was held for the GM');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The Human GM approves the held turn as it is. */
export async function approveHeldTurn(call: Call, gmToken: string): Promise<GmPendingTurn> {
  const pending = await heldTurn(call, gmToken);
  const res = await call('POST', '/api/game/gm/turn/approve', { token: gmToken });
  if (res.status !== 200) throw new Error(`approve answered ${res.status}: ${JSON.stringify(res.body)}`);
  return pending;
}
