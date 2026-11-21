// Prints the CREATE_CODE_HASH value for a create code (Q-021). The code is read from stdin so it
// stays out of the command line and shell history:
//   pnpm --silent --filter @isekai/server run create-code:hash     (type the code, Enter, then Ctrl+D / Ctrl+Z Enter)
// Only the hash is printed; put it in Railway > Variables as CREATE_CODE_HASH.
import { text } from 'node:stream/consumers';
import { hashSecret } from './pin.ts';

if (process.stdin.isTTY) process.stderr.write('พิมพ์ create code แล้วกด Enter ตามด้วย Ctrl+D (Windows: Ctrl+Z แล้ว Enter)\n');

const code = (await text(process.stdin)).replace(/\r?\n$/, '');
if (code.trim() === '') {
  process.stderr.write('create code ว่าง ไม่ได้สร้าง hash\n');
  process.exit(1);
}
process.stdout.write(`${await hashSecret(code)}\n`);
