import type { z } from 'zod';

/**
 * GEN-099 C2: a player-facing schema must not have a number for Karma, Reputation, affinity / relationship
 * or the roll's DC / total / modifier. Players get words (conduct, socialTitle, bond, difficulty) instead.
 * The scan walks the zod schema itself, so a new field fails the test before any server sends it.
 */

/** Keys that are forbidden whatever their type. */
const FORBIDDEN_KEYS = new Set(['karma', 'reputation', 'reputationscore', 'affinity', 'relationship', 'dc', 'difficultyclass', 'total', 'modifier', 'modifiers', 'mods']);
/** A number under a key that contains one of these is forbidden too (e.g. `affinityScore`, `karmaValue`). */
const FORBIDDEN_PARTS = ['karma', 'reputation', 'affinity', 'relationship'];

/** Q-196: the end page shows the karma tier word with the number small beside it, after the end only. */
export const PLAYER_NUMBER_ALLOWED = ['GameLogResponse.reveal.players[].karma'];

type Def = { type: string; [key: string]: unknown };
const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;

/** Unwraps optional / nullable / default / readonly / catch / pipe-input to the value's own kind. */
function isNumeric(schema: unknown): boolean {
  const def = defOf(schema);
  switch (def.type) {
    case 'number':
    case 'int':
    case 'bigint':
      return true;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return isNumeric(def.innerType);
    case 'pipe':
      return isNumeric(def.in) || isNumeric(def.out);
    case 'union':
      return (def.options as unknown[]).some(isNumeric);
    default:
      return false;
  }
}

/**
 * Paths (`Name.you.karma`, `Name.people[].affinityScore`) of every forbidden field in `schema`. Union
 * options whose `view` is the literal `gm` are the Human GM's branch (SurroundingsResponse, OriginResponse,
 * GameTimelineResponse) and are skipped: a player never gets them.
 */
export function playerNumberLeaks(schema: z.ZodType, name: string): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (s: unknown, path: string) => {
    if (seen.has(s)) return;
    seen.add(s);
    const def = defOf(s);
    switch (def.type) {
      case 'object': {
        const shape = def.shape as Record<string, unknown>;
        for (const [key, child] of Object.entries(shape)) {
          const childPath = `${path}.${key}`;
          const lower = key.toLowerCase();
          const bad = FORBIDDEN_KEYS.has(lower) || (FORBIDDEN_PARTS.some((part) => lower.includes(part)) && isNumeric(child));
          if (bad && !PLAYER_NUMBER_ALLOWED.includes(childPath)) found.push(childPath);
          walk(child, childPath);
        }
        if (def.catchall) walk(def.catchall, `${path}.*`);
        break;
      }
      case 'array':
        walk(def.element, `${path}[]`);
        break;
      case 'tuple':
        for (const item of def.items as unknown[]) walk(item, `${path}[]`);
        break;
      case 'record':
        walk(def.valueType, `${path}.*`);
        break;
      case 'union':
        for (const option of def.options as unknown[]) {
          const od = defOf(option);
          const view = od.type === 'object' ? (od.shape as Record<string, unknown>).view : undefined;
          if (view && defOf(view).type === 'literal' && (defOf(view).values as unknown[]).includes('gm')) continue;
          walk(option, path);
        }
        break;
      case 'intersection':
        walk(def.left, path);
        walk(def.right, path);
        break;
      case 'pipe':
        walk(def.in, path);
        walk(def.out, path);
        break;
      case 'lazy':
        walk((def.getter as () => unknown)(), path);
        break;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'readonly':
      case 'catch':
      case 'nonoptional':
        walk(def.innerType, path);
        break;
      default:
        break;
    }
    seen.delete(s);
  };
  walk(schema, name);
  return found;
}

/** Every value at a dotted path (`you.lock.code`, `entries[].roll`) of a plain JSON value; `[]` fans out over arrays. */
export function valuesAt(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const raw of path.split('.')) {
    const fan = raw.endsWith('[]');
    const key = fan ? raw.slice(0, -2) : raw;
    current = current.flatMap((v) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return [];
      const next = (v as Record<string, unknown>)[key];
      return fan ? (Array.isArray(next) ? next : []) : [next];
    });
  }
  return current;
}
