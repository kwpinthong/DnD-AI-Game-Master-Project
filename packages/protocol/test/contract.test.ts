import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.ts';
import {
  CONTRACT,
  CONTRACT_DOC_BEGIN,
  CONTRACT_DOC_END,
  CONTRACT_FIXTURES,
  CONTRACT_SCHEMAS,
  CONTRACT_SCREENS,
  PENDING_FIELDS,
  PLAYER_NUMBER_ALLOWED,
  playerNumberLeaks,
  renderContractDocs,
  valuesAt,
} from '../src/contract/index.ts';

/** Every screen of Screens and Flows v2 (GEN-086) the contract has to cover (GEN-099 C1). */
const V2_SCREENS = [
  'home',
  'join',
  'create-game',
  'scenario-editor',
  'lobby',
  'character',
  'origin-card',
  'play-top-bar',
  'play-place',
  'play-feed',
  'play-private',
  'play-changes',
  'play-npc',
  'play-hit',
  'play-self',
  'play-companions',
  'play-inventory',
  'play-action',
  'play-lock',
  'play-astral',
  'gm-console',
  'ending',
  'ending-rating',
  'learning-library',
  'ai-usage',
  'my-style',
  // GEN-147: the server owner's game data editor (after v2).
  'game-data',
];

const schemaNames = Object.keys(CONTRACT_SCHEMAS) as (keyof typeof CONTRACT_SCHEMAS)[];

function namesOf(item: (typeof CONTRACT)[number]): string[] {
  return item.kind === 'http' ? [item.request, item.response].filter((n): n is NonNullable<typeof n> => n !== null) : [item.schema];
}

describe('C1: every v2 screen has its schemas, exported for the web', () => {
  it('the contract lists exactly the v2 screens', () => {
    expect(CONTRACT_SCREENS.map((s) => s.id)).toEqual(V2_SCREENS);
  });

  it.each(V2_SCREENS)('screen %s uses at least one endpoint or socket event', (screen) => {
    expect(CONTRACT.filter((item) => (item.screens as readonly string[]).includes(screen)).length).toBeGreaterThan(0);
  });

  it('every schema the contract names is exported from @isekai/protocol under the same name', () => {
    const exported = protocol as unknown as Record<string, unknown>;
    for (const name of schemaNames) expect(exported[name], name).toBe(CONTRACT_SCHEMAS[name]);
  });

  it('every endpoint / event names schemas of the contract, and every contract schema is used or nested', () => {
    for (const item of CONTRACT) for (const name of namesOf(item)) expect(schemaNames, `${item.kind} ${JSON.stringify(item)}`).toContain(name);
  });
});

describe('C2: player-facing schemas carry no karma / reputation / affinity / DC number', () => {
  const playerSchemas = new Set<string>();
  for (const item of CONTRACT) if (item.audience === 'player' || item.audience === 'any') for (const n of namesOf(item)) playerSchemas.add(n);

  it('the player-facing set includes the play room and the end page', () => {
    for (const name of ['RoomState', 'RoomEntryMessage', 'CharacterResponse', 'SurroundingsResponse', 'CompanionsResponse', 'GameLogResponse', 'TravelResponse']) {
      expect([...playerSchemas], name).toContain(name);
    }
  });

  it('the whole play-room union a player socket parses has none either', () => {
    expect(playerNumberLeaks(protocol.RoomServerMessage, 'RoomServerMessage')).toEqual([]);
  });

  it.each([...playerSchemas])('%s has no forbidden number', (name) => {
    expect(playerNumberLeaks(CONTRACT_SCHEMAS[name as keyof typeof CONTRACT_SCHEMAS], name)).toEqual([]);
  });

  it('the only allowed exception is the karma number on the end page reveal (Q-196)', () => {
    expect(PLAYER_NUMBER_ALLOWED).toEqual(['GameLogResponse.reveal.players[].karma']);
  });

  it('the scanner is not blind: it finds a forbidden number at any depth, and a word field is fine', () => {
    const bad = z.strictObject({
      you: z.strictObject({ karma: z.number().int() }).nullable(),
      people: z.array(z.strictObject({ affinityScore: z.number(), karmaTier: z.string() })),
      roll: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('a'), dc: z.number() }), z.strictObject({ kind: z.literal('b'), total: z.number().optional() })]),
      bonds: z.array(z.strictObject({ relationship: z.number().int().default(0) })),
      rep: z.strictObject({ reputation: z.number() }).optional(),
    });
    expect(playerNumberLeaks(bad, 'Bad').sort()).toEqual(
      ['Bad.bonds[].relationship', 'Bad.people[].affinityScore', 'Bad.rep.reputation', 'Bad.roll.dc', 'Bad.roll.total', 'Bad.you.karma'].sort(),
    );
    // The GM view does carry karma: the scanner sees it there.
    expect(playerNumberLeaks(protocol.GmConsoleResponse, 'GmConsoleResponse').length).toBeGreaterThan(0);
  });
});

describe('C4: every schema has at least one fixture that parses', () => {
  it.each(schemaNames)('%s', (name) => {
    const fixtures = CONTRACT_FIXTURES[name] as readonly unknown[];
    expect(fixtures.length, `${name} needs a fixture`).toBeGreaterThan(0);
    for (const [i, fixture] of fixtures.entries()) {
      const result = CONTRACT_SCHEMAS[name].safeParse(fixture);
      expect(result.success, `${name}[${i}]: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
    }
  });

  it.each(PENDING_FIELDS.map((f) => [`${f.schema}.${f.path}`, f] as const))('pending field %s has a sample in a fixture', (_label, field) => {
    const fixtures = CONTRACT_FIXTURES[field.schema] as readonly unknown[];
    const values = fixtures.flatMap((f) => valuesAt(f, field.path));
    if (field.value === undefined) expect(values.filter((v) => v !== undefined).length).toBeGreaterThan(0);
    else expect(values).toContain(field.value);
  });
});

describe('Q-198 difficulty words, F4 bond words', () => {
  it('rounds a DC to the nearest ladder step, ties go up, outside the ladder clamps', () => {
    const { difficultyWord } = protocol;
    expect([5, 8, 11, 14, 17, 20, 23].map(difficultyWord)).toEqual(['ง่ายมาก', 'ง่าย', 'ปานกลาง', 'ยาก', 'ยากมาก', 'สุดขีด', 'แทบเป็นไปไม่ได้']);
    expect(difficultyWord(6)).toBe('ง่ายมาก');
    expect(difficultyWord(7)).toBe('ง่าย');
    expect(difficultyWord(12.5)).toBe('ยาก');
    expect(difficultyWord(1)).toBe('ง่ายมาก');
    expect(difficultyWord(30)).toBe('แทบเป็นไปไม่ได้');
  });

  it('turns an affinity into a word and a step of 6, never a number', () => {
    const { bondFor } = protocol;
    expect([-100, -61, -60, -21, -20, 8, 9, 40, 41, 69, 70, 100].map((a) => bondFor(a))).toEqual([
      { word: 'เกลียดชัง', step: 1 },
      { word: 'เกลียดชัง', step: 1 },
      { word: 'ไม่ไว้ใจ', step: 2 },
      { word: 'ไม่ไว้ใจ', step: 2 },
      { word: 'ห่างเหิน', step: 3 },
      { word: 'ห่างเหิน', step: 3 },
      { word: 'คุ้นเคย', step: 4 },
      { word: 'คุ้นเคย', step: 4 },
      { word: 'สนิท', step: 5 },
      { word: 'สนิท', step: 5 },
      { word: 'ผูกพัน', step: 6 },
      { word: 'ผูกพัน', step: 6 },
    ]);
  });
});

describe('C6: docs/contract.md matches the code', () => {
  it('the table in docs/contract.md is the one the registry renders (run `pnpm --filter @isekai/protocol contract:docs`)', () => {
    const doc = readFileSync(new URL('../../../docs/contract.md', import.meta.url), 'utf8');
    const begin = doc.indexOf(CONTRACT_DOC_BEGIN);
    const end = doc.indexOf(CONTRACT_DOC_END);
    expect(begin, 'begin marker').toBeGreaterThan(-1);
    expect(end, 'end marker').toBeGreaterThan(begin);
    expect(doc.slice(begin, end + CONTRACT_DOC_END.length).replace(/\r\n/g, '\n')).toBe(renderContractDocs());
  });

  it('every item has an owner task: ready = the task that built it, pending = the task that will', () => {
    for (const item of [...CONTRACT, ...PENDING_FIELDS]) expect(item.owner, JSON.stringify(item)).toMatch(/^(GEN-\d{3}[a-z]?|new)( \+ GEN-\d{3})*$/);
  });

  it('the socket events are exactly the messages of the room unions (ready = on the wire today)', () => {
    const typesOf = (union: { options: readonly { shape: { type: { value: unknown } } }[] }) => union.options.map((o) => String(o.shape.type.value)).sort();
    const sockets = CONTRACT.filter((i) => i.kind === 'socket');
    const client = sockets.filter((i) => i.direction === 'client');
    const server = sockets.filter((i) => i.direction === 'server');
    expect(client.filter((i) => i.status === 'ready').map((i) => i.type).sort()).toEqual(typesOf(protocol.RoomClientMessage));
    expect(server.map((i) => i.type).sort()).toEqual(typesOf(protocol.RoomServerMessage));
    // A pending client message is not in the union yet: the server would treat it as an action.
    for (const item of client.filter((i) => i.status === 'pending')) expect(typesOf(protocol.RoomClientMessage)).not.toContain(item.type);
  });
});
