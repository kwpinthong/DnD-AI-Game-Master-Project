/** Q-267: which hit cards this member has acknowledged, kept on this device (docs/contract.md: client-side). */
const key = (gameId: string, memberId: string, seq: number) => `isekai.hitAck.${gameId}.${memberId}.${seq}`;

export function hitAcknowledged(gameId: string, memberId: string, seq: number): boolean {
  try {
    return localStorage.getItem(key(gameId, memberId, seq)) === '1';
  } catch {
    return false;
  }
}

export function rememberHitAcknowledged(gameId: string, memberId: string, seq: number): void {
  try {
    localStorage.setItem(key(gameId, memberId, seq), '1');
  } catch {
    // no storage: the card pins again after a reload, nothing else breaks
  }
}
