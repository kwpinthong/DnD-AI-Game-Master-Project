/**
 * Keys that must never appear in anything sent to a player (GEN-050): Karma, the Reputation number,
 * affinity numbers and (GEN-067) the relationship number between players are GM-only. The C6 test runs
 * every HTTP route through `forbiddenKeysIn`, the C2 test every play-room socket frame.
 */
export const PLAYER_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['karma', 'reputation', 'reputationScore', 'affinity', 'relationship']);

/** Dotted paths (`people.0.karma`) of every forbidden key anywhere in `payload`; empty = safe for a player. */
export function forbiddenKeysIn(payload: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (PLAYER_FORBIDDEN_KEYS.has(key)) found.push(childPath);
        walk(child, childPath);
      }
    }
  };
  walk(payload, '');
  return found;
}
