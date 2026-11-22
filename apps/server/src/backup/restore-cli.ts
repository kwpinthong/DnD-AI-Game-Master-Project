import { resolve } from 'node:path';
import { restoreBackup } from './backup.ts';

// `pnpm db:restore <backup file> <new DB file>`: restores a backup into a NEW file (never over the
// running DB), applies pending migrations and prints the rows per table. Then point DB_PATH at the
// new file and restart the server (docs/deploy.md).
const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('usage: db:restore <backup file> <new DB file>');
  process.exit(1);
}
try {
  const result = await restoreBackup(resolve(source), resolve(target));
  console.log(`[isekai-server] restored into ${result.target} (migrations applied: ${result.migrationsApplied}), integrity_check ok`);
  for (const [table, rows] of Object.entries(result.counts)) console.log(`${table}\t${rows}`);
} catch (error) {
  console.error(`[isekai-server] restore failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
