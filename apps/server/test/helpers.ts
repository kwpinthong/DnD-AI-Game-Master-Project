import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { loadGameAssets, type GameAssets } from '../src/assets/load.ts';
import { offerFrom } from '../src/game/loot.ts';

/** Fresh empty directory per test; removed by the returned cleanup. */
export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'isekai-server-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A loot choice (GEN-073) seeded straight into `character_loot`, so a test can start a game without the AI
 * loot step (Q-144: the start needs one). `legacy`: an old GEN-048 Common choice that needs a new pick.
 * Uses the first Rank B Ability and Item of the sheet.
 */
export function seedChosenLoot(db: Database.Database, memberId: string, options: { legacy?: boolean } = {}): void {
  const assets = (seedChosenLoot.assets ??= loadGameAssets());
  const strength = { label: 'ช่างสังเกต', scope: 'observe', description: 'มองเห็นรายละเอียด' };
  const weakness = { label: 'ลังเล', scope: 'priority', description: 'คิดนาน' };
  const offer = offerFrom(
    { strength, weakness, skills: [assets.abilities.find((a) => a.rank === 'B')!.name], items: [assets.items.find((i) => i.rank === 'B')!.nameEn] },
    assets,
  );
  if (!offer.ok) throw new Error(`seedChosenLoot: ${offer.problems.join(' / ')}`);
  const legacy = (kind: 'skill' | 'item') => ({ id: `old-${kind}`, kind, name: `ของเก่า-${kind}`, description: 'ของ Common เดิม', tier: 'Common', buffType: 'Utility', effect: null });
  const chosen = {
    strength: offer.offer.strength,
    weakness: offer.offer.weakness,
    skill: options.legacy ? legacy('skill') : offer.offer.skills[0],
    item: options.legacy ? legacy('item') : offer.offer.items[0],
  };
  db.prepare(
    'insert into character_loot (member_id, offer_json, chosen_json, rerolls_used, updated_at) values (?, null, ?, 0, 0) on conflict(member_id) do update set offer_json = null, chosen_json = excluded.chosen_json',
  ).run(memberId, JSON.stringify(chosen));
}
seedChosenLoot.assets = undefined as GameAssets | undefined;

/** A port that was free a moment ago, for tests that must check nothing listens on it. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      probe.close(() => resolve(address.port));
    });
  });
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export async function isListening(port: number): Promise<boolean> {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
