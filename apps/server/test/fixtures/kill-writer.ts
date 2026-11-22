import { writeSync } from 'node:fs';
import { openDatabase } from '../../src/db/client.ts';

// GEN-037 C7: writes transactions as fast as it can until it is killed. After each COMMIT it prints the
// transaction number with a synchronous write, so the parent knows what was committed before the kill.
const [dbPath] = process.argv.slice(2);
if (!dbPath) throw new Error('usage: kill-writer.ts <db path>');

const { sqlite } = openDatabase(dbPath);
const ROWS = 40;
const filler = 'ข้อมูลเกม'.repeat(2_000);
const insert = sqlite.prepare('insert into app_meta (key, value) values (?, ?)');
const write = sqlite.transaction((n: number) => {
  for (let i = 0; i < ROWS; i++) insert.run(`kill-${n}-${i}`, filler);
});
writeSync(1, 'ready\n');
for (let n = 1; ; n++) {
  write(n);
  writeSync(1, `committed ${n}\n`);
}
