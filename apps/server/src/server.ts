import cors from '@fastify/cors';
import type { HealthResponse } from '@isekai/protocol';
import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './config.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import type { Clock } from './auth/join.ts';
import { openDatabase, type Db } from './db/client.ts';
import { registerGameRoutes } from './game/routes.ts';
import { loadAiConfig, type AiConfig } from './ai/config.ts';
import { createAiService, type AiService, type BudgetReachedEvent } from './ai/core/service.ts';
import { createUsageStore } from './ai/core/usage.ts';
import type { AiProvider } from './ai/provider.ts';
import { providerFor } from './ai/registry.ts';
import { registerTimelineRoutes } from './timeline/routes.ts';
import { registerVisibilityRoutes } from './visibility/routes.ts';
import websocket from '@fastify/websocket';
import { createAiGmResolver } from './gm/loop.ts';
import type { PhaseResolver } from './room/resolver.ts';
import { registerRoomRoutes } from './room/routes.ts';
import { createWeatherService, type WeatherService } from './weather/service.ts';
import { assetFileLabel, buildGameAssets, DEFAULT_ASSETS_DIR, readRawDataSets, type GameAssets } from './assets/load.ts';
import { openGameData, type GameDataStore } from './assets/game-data.ts';
import { dirname, join } from 'node:path';
import { registerCompanionRoutes } from './companions/routes.ts';
import { registerNpcChatRoutes } from './npc-chat/routes.ts';
import { registerAdminRoutes } from './admin/routes.ts';
import { registerClosedGameGuard } from './admin/games-routes.ts';
import { createStyleReview, type StyleReview } from './admin/style-review.ts';
import { registerInventoryRoutes } from './skills/routes.ts';
import { registerGmConsoleRoutes } from './gm-console/routes.ts';
import { startBackupSchedule, type BackupSchedule } from './backup/schedule.ts';
import { registerHistoryRoutes } from './history/routes.ts';
import { registerRatingRoutes } from './rating/routes.ts';
import { createLearningExtractor, everyoneRated, startAutoExtract } from './learning/extract.ts';
import { registerGameLearningRoutes } from './learning/extract-routes.ts';
import { syncExamples } from './learning/examples.ts';
import { buildStyles } from './learning/style.ts';
import { registerPlayerStyleRoutes } from './learning/style-routes.ts';
import { registerVoteRoutes } from './room/vote-routes.ts';
import type { Rng } from '@isekai/rules';
import { CryptoRng } from './rng.ts';
import { registerWebStatic } from './web-static.ts';
import { registerFeedbackRoutes } from './feedback/routes.ts';

export interface RunningServer {
  url: string;
  dbPath: string;
  migrationsApplied: number;
  /** Raw SQLite handle (tests and admin scripts). */
  db: Database.Database;
  orm: Db;
  /** The AI GM boundary (GEN-038): check `ai.ready()` before creating / starting a game. */
  ai: AiService;
  /** Each period's weather (GEN-068); the room picks it when a period opens. */
  weather: WeatherService;
  /** `METHOD /url` of every HTTP route (HEAD left out). */
  routes: readonly string[];
  /** Game data from the DB (GEN-147; seeded once from apps/server/assets), always the latest admin edit. */
  assets: GameAssets;
  /** GEN-178: the style review round (tests end games through `gameEnded`). */
  styleReview: StyleReview;
  /** The backup job (GEN-037) when `config.backup` is set. */
  backups?: BackupSchedule;
  close(): Promise<void>;
}

/**
 * Opens and migrates the database first, then listens. If the database is unusable this rejects
 * with a DatabaseUnavailableError naming the path, and nothing is listening.
 */
export interface ServerOptions {
  /** Current time in epoch ms (tests move it to check lockout and session expiry). */
  now?: Clock;
  /** AI provider settings; default `loadAiConfig({})` (Anthropic, not ready without a key). */
  ai?: AiConfig;
  /** AI metadata log lines (default console.log). Never prompt text, never a key. */
  aiLog?: (line: string) => void;
  /** Where the per-game ceiling notice goes until rooms (GEN-056) deliver it to the owner / GM. */
  onAiBudgetReached?: (event: BudgetReachedEvent) => void;
  /** Overrides the provider `ai` picks (tests pass a scripted Mock). */
  aiProvider?: AiProvider;
  /** Resolves a closed turn; default the AI GM turn loop (GEN-057) on `ai`. Tests may plug in their own. */
  phaseResolver?: PhaseResolver;
  /** Folder of the asset JSON files; default apps/server/assets (tests point it at a broken copy). */
  assetsDir?: string;
  /** Backup job log lines (default console.log): file, size, time only. */
  backupLog?: (line: string) => void;
  /**
   * Source of the start-scenario rolls at game start (GEN-065, default CryptoRng); tests pass a scripted or
   * seeded Rng. `null` = no start scenarios: everyone starts at the scenario's first place with the GEN-047
   * starting stats (the test fixtures written before GEN-065 use it).
   */
  rng?: Rng | null;
  /** The built web app (apps/web/dist) to serve from the same origin (Q-162); left out = API only (tests). */
  webDistDir?: string;
}

export async function startServer(config: ServerConfig, options: ServerOptions = {}): Promise<RunningServer> {
  // Before the database: bad asset JSON stops start-up with nothing opened (AssetLoadError names the file and field).
  const assetsDir = options.assetsDir ?? DEFAULT_ASSETS_DIR;
  const seed = readRawDataSets(assetsDir);
  buildGameAssets(seed, assetFileLabel(assetsDir));
  const { sqlite, db, dbPath, migrationsApplied } = openDatabase(config.dbPath);
  // GEN-147: the DB holds the game data; the files only seed a set it does not have yet (never overwrite an edit).
  let gameData: GameDataStore;
  try {
    gameData = openGameData(db, seed, { backupDir: join(config.backup?.dir ?? join(dirname(dbPath), 'backups'), 'game-data'), now: options.now ?? Date.now, assetsDir });
  } catch (error) {
    sqlite.close();
    throw error;
  }
  const assets = gameData.assets;

  const aiConfig = options.ai ?? loadAiConfig({});
  const ai = createAiService({
    provider: options.aiProvider ?? providerFor(aiConfig),
    config: aiConfig,
    usage: createUsageStore(db),
    now: options.now ?? Date.now,
    ...(options.aiLog ? { log: options.aiLog } : {}),
    ...(options.onAiBudgetReached ? { onBudgetReached: options.onAiBudgetReached } : {}),
  });

  const app = Fastify({ logger: false });
  // Every route, so the GEN-050 scan test can check it covers all of them (a new route cannot slip by).
  const routes: string[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD') routes.push(`${method} ${route.url}`);
  });
  // PUT, PATCH and DELETE are not all in @fastify/cors's default methods; the web uses them.
  await app.register(cors, { origin: config.webOrigins ?? [], methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  // The play room's WebSocket (GEN-056). 16 KiB is far above one action (1000 code points ≈ 4 KB in UTF-8).
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  app.get('/health', async (_req, reply) => {
    let body: HealthResponse;
    try {
      sqlite.prepare('select 1').get();
      body = { ok: true, db: 'connected' };
    } catch {
      body = { ok: false, db: 'error' };
    }
    return reply.code(body.ok ? 200 : 503).send(body);
  });

  const now = options.now ?? Date.now;
  registerClosedGameGuard(app, db, now);
  registerAuthRoutes(app, db, now);
  registerGameRoutes(app, db, now, {
    ai,
    // A getter: an admin edit of the Karma Tiers rows reaches the next request (GEN-147).
    get karmaTiers() {
      return assets.karmaTiers;
    },
    assets,
    rng: options.rng === undefined ? new CryptoRng() : options.rng,
    ...(config.createCodeHash ? { createCodeHash: config.createCodeHash } : {}),
  });
  registerTimelineRoutes(app, db, now);
  registerVisibilityRoutes(app, db, now, assets);
  const weather = createWeatherService(db, ai, now, options.aiLog ?? ((line) => console.log(line)));
  const resolver = options.phaseResolver ?? createAiGmResolver({ db, ai, assets, now, log: options.aiLog ?? ((line) => console.log(line)), styleRewriteMs: aiConfig.styleRewriteMs });
  // The backup job starts after `listen`; the room reaches it through this late binding (Q-185).
  let backups: BackupSchedule | undefined;
  const styleReview = createStyleReview({ db, ai, gameData, now, log: options.aiLog ?? ((line) => console.log(line)) });
  const learning = createLearningExtractor({ db, ai, assets, now, log: options.aiLog ?? ((line) => console.log(line)) });
  const room = registerRoomRoutes(app, db, now, {
    resolver,
    assets,
    webOrigins: config.webOrigins ?? [],
    weather,
    onGameEnded: (gameId, status) => {
      void backups?.gameEnded(gameId, status);
      // GEN-178: every 5th ended game starts a style review round (in the background).
      void styleReview.gameEnded(gameId);
      // GEN-081: the votes of play become good / avoid examples.
      syncExamples(db, gameId, now());
      // GEN-082: the style of each player who joined with a player code.
      buildStyles(db, gameId, now());
    },
    budgetNotice: (gameId) => ai.budgetNotice(gameId),
    ...(options.aiLog ? { log: options.aiLog } : {}),
  });
  registerCompanionRoutes(app, db, now, assets);
  registerNpcChatRoutes(app, { db, ai, assets, now, log: options.aiLog ?? ((line) => console.log(line)), styleRewriteMs: aiConfig.styleRewriteMs, publish: room.publish });
  registerAdminRoutes(app, db, now, {
    ai: aiConfig,
    log: options.aiLog ?? ((line) => console.log(line)),
    gameData,
    styleReview,
    learning,
    onGameClosed: (gameId, closed) => {
      room.closed(gameId, closed);
      if (!closed.hasSummary) return;
      // ISK-001: a played game closed early ends like a finale for the backup and learning (no style review: no AI from a close).
      void backups?.gameEnded(gameId, 'finale');
      syncExamples(db, gameId, now());
      buildStyles(db, gameId, now());
    },
    ...(config.adminCodeHash ? { adminCodeHash: config.adminCodeHash } : {}),
  });
  registerInventoryRoutes(app, db, now, assets);
  registerGmConsoleRoutes(app, db, now, room, assets);
  registerHistoryRoutes(app, db, now, assets);
  // GEN-080: once every member rated, the lore + feedback extract runs in the background (the owner can also start it).
  registerRatingRoutes(app, db, now, (gameId) => {
    if (everyoneRated(db, gameId)) void learning.extract(gameId);
  });
  registerGameLearningRoutes(app, db, now, learning);
  registerVoteRoutes(app, db, now);
  registerPlayerStyleRoutes(app, db, now);
  registerFeedbackRoutes(app, db, now);
  if (options.webDistDir) registerWebStatic(app, options.webDistDir);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const { port } = app.server.address() as AddressInfo;
  const urlHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  backups = config.backup
    ? startBackupSchedule({ ...config.backup, sqlite, now, log: options.backupLog ?? ((line) => console.log(line)) })
    : undefined;
  // Q-364: an ended game nobody's ratings started is extracted N hours after it ended.
  const stopAutoExtract = config.learningAutoExtractMs ? startAutoExtract(db, learning, now, config.learningAutoExtractMs) : () => {};

  return {
    url: `http://${urlHost}:${port}`,
    dbPath,
    migrationsApplied,
    db: sqlite,
    orm: db,
    ai,
    weather,
    routes,
    assets,
    styleReview,
    ...(backups ? { backups } : {}),
    async close() {
      stopAutoExtract();
      await app.close();
      await weather.idle();
      await styleReview.idle();
      await learning.idle();
      // After the room and the weather picks stopped writing: the shutdown backup has everything.
      await backups?.stop();
      if (sqlite.open) sqlite.close();
    },
  };
}
