import { dirname, join } from 'node:path';
import { loadAiConfig } from '../ai/config.ts';
import { providerFor } from '../ai/registry.ts';
import { openGameData } from '../assets/game-data.ts';
import { assetFileLabel, buildGameAssets, DEFAULT_ASSETS_DIR, readRawDataSets } from '../assets/load.ts';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/client.ts';
import { npcReplyReport, runStyleEval } from './style-eval.ts';

// `pnpm eval:style` (GEN-167): one round of the Thai style eval set against the AI of AI_PROVIDER, saved in the DB of
// DB_PATH for the /admin compare page. Never creates or reads a game. STYLE_EVAL_MAX_USD (default 1) stops the round.
const usd = (micros: number) => (micros / 1_000_000).toFixed(4);

try {
  const config = loadConfig(process.env);
  const ai = loadAiConfig(process.env);
  const maxUsd = Number(process.env.STYLE_EVAL_MAX_USD ?? '1');
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error(`STYLE_EVAL_MAX_USD must be a number above 0, got "${process.env.STYLE_EVAL_MAX_USD}"`);
  const seed = readRawDataSets(DEFAULT_ASSETS_DIR);
  buildGameAssets(seed, assetFileLabel(DEFAULT_ASSETS_DIR));
  const { sqlite, db, dbPath } = openDatabase(config.dbPath);
  try {
    // The Voice data set as /admin last saved it (the files only seed a set the DB does not have).
    const gameData = openGameData(db, seed, { backupDir: join(config.backup?.dir ?? join(dirname(dbPath), 'backups'), 'game-data'), now: Date.now, assetsDir: DEFAULT_ASSETS_DIR });
    const run = await runStyleEval({ db, assets: gameData.assets, provider: providerFor(ai), config: ai, maxUsd });
    console.log(`[eval:style] round ${run.id} in ${dbPath}: provider ${run.provider}, models ${run.models.join(', ') || '-'}, Voice v${run.voiceVersion}, ${usd(run.costUsdMicros)} USD`);
    for (const s of run.scenes) {
      const status = s.ok ? 'ok' : `FAILED (${s.failure})`;
      console.log(`[eval:style] ${s.sceneId} ${s.purpose}: ${status}${s.flags.length > 0 ? ` flags=${s.flags.join(',')}` : ''} ${usd(s.costUsdMicros)} USD`);
    }
    const failed = run.scenes.filter((s) => !s.ok).length;
    const leaked = run.scenes.filter((s) => s.flags.includes('real_name')).length;
    console.log(`[eval:style] ${run.scenes.length - failed}/${run.scenes.length} scenes ok, ${failed} failed, ${leaked} with a real name`);
    // ISK-025 C8: the bar for NPC replies (every one ≤ 120, all 4 parts in ≥ 80%).
    const npc = npcReplyReport(db, run.id);
    console.log(`[eval:style] NPC replies: ${npc.withinLength}/${npc.replies} within 120, ${npc.complete}/${npc.replies} with all 4 parts (${Math.round(npc.completeRate * 100)}%): ${npc.pass ? 'PASS' : 'BELOW THE BAR'}`);
    for (const s of npc.samples) console.log(`[eval:style]   ${s}`);
  } finally {
    sqlite.close();
  }
} catch (error) {
  console.error(`[eval:style] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
