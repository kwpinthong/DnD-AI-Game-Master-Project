# Deploy: server บน Railway + web บน Netlify (GEN-041a)

คู่มือ deploy / update / rollback ของ skeleton ตอนนี้ (scaffold GEN-023 + join GEN-024 + สร้างเกม GEN-025) ตาม Q-060 (Railway แทน PC + Cloudflare Tunnel) และ Q-031 (web บน Netlify, server แยก origin)
backup / restore ของ DB (GEN-037) อยู่ในข้อ 6 / ไม่รวม Cloudflare Access (Q-023)

```
browser ──https──> https://<site>.netlify.app        (Netlify: apps/web/dist, SPA)
   │
   └──https + Authorization: Bearer <token>──> https://<service>.up.railway.app   (Railway: node apps/server/src/index.ts)
                                                   └── Volume /data/isekai.sqlite (ไฟล์ DB เดียว, replica เดียว)
```

## ไฟล์ใน repo
| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `.railway/railway.ts` | ค่าของ service บน Railway (Infrastructure as Code) Railway **ไม่อ่านไฟล์นี้ตอน deploy** ต้อง apply ด้วย Railway CLI (`railway config plan` แล้ว `railway config apply`) หรือกรอกค่าเดียวกันใน dashboard ตามข้อ 1 |
| `netlify.toml` | build ของ `apps/web` (Netlify อ่านเองทุก build) |
| `apps/server/server.env.example` | ชื่อ env ของ server (ไม่มีค่า) |
| `apps/web/.env.example` | ชื่อ env ของ web (ไม่มีค่า) |

ทำไมไม่ใช้ `railway.json`: Railway ประกาศว่า Config as Code (`railway.json` / `railway.toml`) deprecated, service ใหม่เปิดใช้ไม่ได้ และหยุดอ่านไฟล์ตั้งแต่ 2026-12-01

## Env ทั้งหมด (ค่าอยู่ใน Railway / Netlify เท่านั้น ห้าม commit)
| ที่ | ตัวแปร | ค่า | หมายเหตุ |
|---|---|---|---|
| Railway | `NODE_ENV` | `production` | ทำให้ `WEB_ORIGIN` กับ `DB_PATH` เป็นค่าบังคับ ขาดตัวไหน server ไม่ start และ log ชื่อตัวที่ขาด |
| Railway | `DB_PATH` | `/data/isekai.sqlite` | ต้องอยู่ใน mount path ของ Volume ไม่งั้นข้อมูลหายทุก deploy |
| Railway | `WEB_ORIGIN` | `https://<site>.netlify.app` | origin ของ web ไม่มี path (มี `/` ท้ายได้) ใส่หลาย origin คั่นด้วย `,` |
| Railway | `BACKUP_DIR` | `/data/backups` | ที่เก็บ backup (GEN-037) ต้องอยู่ใน volume ไม่ตั้ง = `backups/` ข้างไฟล์ DB (ผลเท่ากัน) ดูข้อ 6 |
| Railway | `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | ไม่ต้องตั้ง (ค่าเริ่ม 6 / 28) | ทุก 6 ชม. เก็บ 28 ไฟล์ล่าสุด (7 วัน) / `BACKUP_INTERVAL_HOURS=0` = ปิด backup ค่าผิด = server ไม่ start และ log ชื่อตัวแปร |
| Railway | `RAILPACK_NODE_VERSION` | `26` | ให้ Railpack ใช้ Node 26 ตรงกับ `engines.node` |
| Railway | `CREATE_CODE_HASH` | hash ของ create code (`scrypt$...`) ไม่ใช่ตัว code | ต้องมีถึงจะสร้างเกมได้ (Q-021) ทำ hash ตามข้อ 1.4 ไม่มีค่านี้ = หน้าสร้างเกมตอบ "server นี้ยังไม่ได้ตั้ง create code" / ค่าที่ไม่ใช่ hash = server ไม่ start (log บอกชื่อตัวแปร ไม่พิมพ์ค่า) |
| Railway | `ADMIN_CODE_HASH` | hash ของ admin code ของเจ้าของ server (`scrypt$...`) ไม่ใช่ตัว code | เปิดหน้า AI usage dashboard ที่ `<web>/admin` (GEN-061, Q-058) ทำ hash ตามข้อ 1.5 ไม่มีค่านี้ = ไม่มีใครเปิด dashboard ได้ / ค่าที่ไม่ใช่ hash = server ไม่ start (log บอกชื่อตัวแปร ไม่พิมพ์ค่า) |
| Railway | `ANTHROPIC_API_KEY` | API key ของ Anthropic (secret) | AI GM (GEN-038) ไม่มีค่านี้ server ยัง start ได้ แต่สร้างเกมและเริ่มเกมไม่ได้ ตอบเหตุผลเป็นภาษาไทย (Q-075) ค่าอื่นของ AI (`AI_PROVIDER`, `AI_MODEL`, เพดาน `AI_GAME_MONTHLY_USD`) ดู `apps/server/server.env.example` |
| Railway | `PORT` | Railway ใส่เอง | ห้ามตั้งเอง |
| Railway | `HOST` | ไม่ต้องตั้ง | production ใช้ `0.0.0.0` เป็นค่าเริ่ม |
| Netlify | `VITE_API_URL` | `https://<service>.up.railway.app` | ฝังตอน build ถ้าไม่มีหรือไม่ใช่ https build บน Netlify จะ fail |

## 1. ตั้งค่าครั้งแรก

### 1.1 Railway (server)
1. สมัคร / login Railway แล้วเลือก plan **Hobby** (plan Free / Trial ให้ volume แค่ 0.5 GB และ service sleep ได้)
2. **New Project → Deploy from GitHub repo** → เลือก `kwpinthong/DnD-AI-Game-Master-Project` (ให้สิทธิ์ GitHub App ของ Railway กับ repo นี้)
3. เข้า service ที่สร้าง → **Settings**
   - **Source**: Branch = branch ที่ตกลงกัน (`main` ตาม `.railway/railway.ts` — ยังเป็นคำถามให้ Nok), **Root Directory** เว้นว่าง (ต้องเป็น root ของ repo เพราะ pnpm workspace ต้องใช้ `pnpm-lock.yaml` และ `packages/protocol`)
   - **Build**: Builder = Railpack, **Custom Build Command** = `pnpm --filter "@isekai/server..." run typecheck`, **Watch Paths** = `apps/server/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.railway/**`
   - **Deploy**: **Custom Start Command** = `node apps/server/src/index.ts`, **Pre-deploy Command** เว้นว่าง (ดูหมายเหตุ migration ข้อ 2), **Healthcheck Path** = `/health`, **Healthcheck Timeout** = `60`, **Restart Policy** = On Failure, **Max Retries** = `10`, **Replicas** = `1`
4. **Volume**: ใน canvas ของ project กด **+ / Create → Volume** (หรือคลิกขวาที่ service → Attach volume) เลือก service นี้ **Mount Path** = `/data`
5. **Variables** ของ service: `NODE_ENV=production`, `DB_PATH=/data/isekai.sqlite`, `BACKUP_DIR=/data/backups`, `RAILPACK_NODE_VERSION=26`, `CREATE_CODE_HASH=<hash จากข้อ 1.4>` (`WEB_ORIGIN` ใส่หลัง Netlify มี URL ในข้อ 1.3)
6. **Settings → Networking → Generate Domain** ได้ `https://<service>.up.railway.app` จดไว้
7. deploy แรกจะยังไม่ผ่าน healthcheck จนกว่าจะมี `WEB_ORIGIN` (server หยุดพร้อม log `NODE_ENV=production needs these environment variables: WEB_ORIGIN`) เป็นพฤติกรรมที่ตั้งใจ

ทางเลือกแทนข้อ 3-5: ติดตั้ง Railway CLI, `railway login`, `railway link` แล้วรัน `railway config plan` ที่ root ของ repo ตรวจว่าแผนตรงกับข้างบน จากนั้น `railway config apply` (ต้องติดตั้ง package `railway` ใน repo ก่อน ซึ่งยังไม่ได้เพิ่ม — ดูคำถามท้าย GEN-041a)

### 1.2 Netlify (web)
1. login Netlify → **Add new project → Import an existing project → GitHub** → เลือก repo เดียวกัน
2. **Branch to deploy** = branch เดียวกับ Railway, **Base directory** เว้นว่าง, Build command / Publish directory ไม่ต้องกรอก (อ่านจาก `netlify.toml`: `pnpm --filter "@isekai/web..." run build` → `apps/web/dist`)
3. **Environment variables** → Add `VITE_API_URL` = `https://<service>.up.railway.app` (จากข้อ 1.1.6) → Deploy
4. ได้ `https://<site>.netlify.app` (เปลี่ยนชื่อ site ได้ที่ Site configuration → Change site name ถ้าเปลี่ยนต้องแก้ `WEB_ORIGIN` ด้วย)

### 1.3 ผูกสองฝั่ง
1. Railway → Variables → `WEB_ORIGIN=https://<site>.netlify.app` → Railway redeploy เอง
2. รอ deployment ขึ้น **Active** (healthcheck `/health` ผ่าน) แล้วทำ checklist ข้อ 4

### 1.4 Create code (สร้างเกม, GEN-025)
create code คือรหัสระดับ server ที่ต้องใส่ตอนสร้างเกม (Q-021) แยกจากโค้ดเกม (invite code) ที่ระบบออกให้แต่ละเกม server เก็บแค่ hash (scrypt) ใน `CREATE_CODE_HASH`
1. ที่ root ของ repo ในเครื่อง รัน `pnpm --silent --filter @isekai/server run create-code:hash` แล้วพิมพ์ create code ที่ตั้งเอง กด Enter ตามด้วย Ctrl+D (PowerShell / cmd: Ctrl+Z แล้ว Enter) — code อ่านจาก stdin จึงไม่ค้างใน history ของ shell
2. คัดลอกบรรทัดที่ได้ (`scrypt$16384$8$1$...`) ไปใส่ Railway → Variables → `CREATE_CODE_HASH` ทั้งบรรทัดตามที่พิมพ์ออกมา
3. บอก create code กับคนที่ให้สร้างเกมได้ทางช่องทางส่วนตัว ห้ามใส่ใน repo หรือแชทกลุ่ม
4. เปลี่ยน code: ทำข้อ 1-2 ใหม่ (Railway redeploy เอง) เกมที่สร้างไว้แล้วไม่กระทบ
5. ใส่ create code ผิด 10 ครั้งใน 10 นาที (นับรวมทั้ง server) = สร้างเกมไม่ได้ 10 นาที ตัวนับอยู่ใน memory รีสตาร์ทแล้วหาย

### 1.5 Admin code (AI usage dashboard, GEN-061)
admin code คือรหัสของเจ้าของ server คนเดียว (Q-058) ใช้เปิดหน้า `<web>/admin` ที่ดู token และค่าใช้จ่ายของ AI GM ทุกเกม (ไม่มี narration ชื่อ หรือ action) server เก็บแค่ hash ใน `ADMIN_CODE_HASH` ตั้งให้ต่างจาก create code
1. รัน `pnpm --silent --filter @isekai/server run admin-code:hash` แล้วพิมพ์ admin code กด Enter ตามด้วย Ctrl+D (PowerShell / cmd: Ctrl+Z แล้ว Enter)
2. คัดลอกบรรทัด `scrypt$...` ไปใส่ Railway → Variables → `ADMIN_CODE_HASH`
3. เปิด `<web>/admin` ใส่ admin code → ได้ admin token อายุ 1 ชั่วโมง (เก็บใน sessionStorage ของ tab นั้น ปิด tab = ออก) server เก็บแค่ SHA-256 ของ token ใน memory รีสตาร์ทแล้วต้องใส่ใหม่
4. ใส่ผิด 10 ครั้งใน 10 นาที = เปิดไม่ได้ 10 นาที (นับรวมทั้ง server เหมือน create code)

**ย้ายจาก GEN-041a:** ถ้า Railway ยังมี `BOOTSTRAP_INVITE_CODE` ให้ลบ `BOOTSTRAP_INVITE_CODE` ออกจาก Variables (server ไม่อ่านค่านี้แล้ว เกมที่เคยสร้างจากค่านี้ยังอยู่และยัง join ได้ด้วยโค้ดเดิม แต่ไม่มีเจ้าของเกม จึงเตะ / ออกโค้ดใหม่ / เริ่มเกมไม่ได้ ให้สร้างเกมใหม่ผ่านหน้าเว็บแทน)

## 2. Update (deploy version ใหม่)
1. merge งานเข้า branch ที่ deploy แล้ว `git push`
2. Railway build เองเมื่อไฟล์ที่เปลี่ยนตรงกับ Watch Paths / Netlify build เองทุก push (แต่ละ production deploy ของ Netlify ใช้ credit ดูข้อ 5)
3. Railway: container ใหม่ start → `openDatabase()` รัน migration ที่ยังไม่เคยรันกับไฟล์ใน volume (Drizzle จดไว้ในตาราง `__drizzle_migrations` จึงรันครั้งเดียวต่อ migration) → `/health` ได้ 2xx → สลับ traffic ไป version ใหม่ ถ้าไม่ผ่านภายใน 60 วิ deployment เป็น Failed และ version เดิมยังรับ traffic
4. ดูผลที่ **Deployments → Deploy Logs**: บรรทัด `[isekai-server] database /data/isekai.sqlite (migrations applied: N)` (N = จำนวน migration ใหม่, ไม่มี migration ใหม่ = 0)
5. service ที่มี volume จะหยุดสั้น ๆ ตอนสลับ version (Railway ต่อ volume กับ container เดียวได้ทีละตัว) หน้า web จะขึ้น "ต่อไม่ได้" ชั่วครู่ ให้ deploy นอกเวลาเล่น

**Migration ทำไมไม่อยู่ใน Pre-deploy Command:** Railway รัน pre-deploy ใน container แยกที่ไม่ mount volume จึงจะ migrate ไฟล์ทิ้ง ไม่ใช่ DB จริง migration จึงรันตอน start ของ server เท่านั้น

**กติกา migration:** ให้เขียนแบบเพิ่ม (add table / column ที่มี default) เพราะ rollback ไม่ย้อน migration — โค้ดเก่าต้องยังทำงานกับ schema ใหม่ได้ ถ้าจำเป็นต้องลบ / เปลี่ยนชื่อ ให้ทำเป็น 2 deploy (เลิกใช้ก่อน ค่อยลบ) และ backup ก่อน (GEN-037)

## 3. Rollback
- **Railway**: service → **Deployments** → เลือก deployment เก่าที่เคย Active → เมนู ⋮ → **Redeploy** (Rollback) → รอ Active ข้อมูลใน volume ไม่ถูกแตะ แต่ migration ที่ version ใหม่รันไปแล้วยังอยู่ (ดูกติกาข้างบน)
- **Netlify**: **Deploys** → เลือก deploy เก่า → **Publish deploy** (ถ้าเปิด "Lock publishing" ไว้ push ถัดไปจะไม่ขึ้นเอง ต้อง Unlock)
- rollback ทั้งสองฝั่งให้ตรงคู่กันถ้า API เปลี่ยน
- ถ้า push แก้ทับใน branch แล้ว ให้ `git revert <sha>` แล้ว push เป็นทางหลัก ปุ่ม Redeploy ใช้ตอนเร่งด่วน

## 4. Checklist หลัง deploy (ตรงกับ Case C1-C7 ของ GEN-041a)
แทน `<api>` = `https://<service>.up.railway.app`, `<web>` = `https://<site>.netlify.app` (รัน curl ใน Git Bash)

| Case | ตรวจอย่างไร | ผ่านเมื่อ |
|---|---|---|
| C1 | มือถือปิด Wi-Fi (4G) เปิด `<web>` / `curl -s <api>/health` | หน้าแสดง `Server: ต่อได้ (database connected)` / ได้ `{"ok":true,"db":"connected"}` |
| C2 | `curl -sI http://<site>.netlify.app/` และ `curl -sI http://<service>.up.railway.app/health` | ทั้งคู่ได้ `301` (หรือ 308) และ `location: https://...` / เปิดแบบ http ใน browser แล้ว URL เปลี่ยนเป็น https |
| C3 | ที่ `<web>` กด "สร้างเกมใหม่" ใส่ create code (ข้อ 1.4), ชื่อเกม, ชื่อ, PIN 4-6 หลัก → สร้าง แล้วกด reload / อีกเครื่องกรอกโค้ดเกมที่ได้ + ชื่อ + PIN → เข้าร่วม | เห็นห้องรอ `เข้าเกมแล้ว: <ชื่อ>` พร้อมโค้ดเกม ทั้งก่อนและหลัง reload / อีกเครื่องเห็นชื่อตัวเองในรายชื่อผู้เล่น |
| C3 (CORS) | `curl -s -D - -o /dev/null -H "Origin: <web>" <api>/health \| grep -i access-control-allow-origin` แล้วรันซ้ำด้วย `-H "Origin: https://evil.example.com"` | ครั้งแรกได้ `access-control-allow-origin: <web>` ครั้งที่สองไม่มีบรรทัดนี้ |
| C4 | ในเครื่อง: `pnpm test` (มี `repo-secrets.test.ts`) และ `git ls-files \| grep -iE '(^\|/)\.env$\|\.sqlite'` | test ผ่าน / grep ไม่มีผล / Railway, Netlify token ไม่เคยถูกสร้างหรือใส่ใน repo |
| C5 | หลัง C3 (มี member + session แล้ว) push commit ใหม่ที่แตะ `apps/server` (หรือ Redeploy) → รอ Active → ดู Deploy Logs → reload `<web>` | log ของ deploy แรก `migrations applied: 3` (ถ้า DB เคยรัน GEN-041a มาแล้ว = 1) ของ deploy ถัดไป `migrations applied: 0` / ยัง login อยู่ ชื่อเดิม |
| C6 | Deployments → deployment ที่ Active → ⋮ → **Restart** แล้ว reload `<web>` / Settings → Deploy ยังเป็น Restart Policy On Failure | กลับมา Active เองไม่ต้องกดอะไรอีก ยัง login อยู่ log `migrations applied: 0` |
| C7 (web) | Chrome DevTools → Network → คลิกขวา request `/health` → **Block request domain** แล้ว reload `<web>` (ปลด block หลังตรวจ) | หน้าแสดง `Server: ต่อไม่ได้` ไม่มี error ดิบ ถ้า server ไม่ตอบเลยจะขึ้นภายใน 8 วิ |
| C7 (Railway) | Variables → ลบ `WEB_ORIGIN` ชั่วคราว → Railway redeploy → รอ → ใส่ค่าเดิมกลับ | deployment ใหม่เป็น **Failed** (healthcheck ไม่ผ่าน, log บอกว่าขาด `WEB_ORIGIN`) deployment เดิมยัง Active และ `<web>` ยัง `ต่อได้` ตลอด |

## 5. ข้อจำกัดที่ต้องรู้
- **replica เดียว**: SQLite อยู่บน volume ที่ต่อได้ทีละ container ขยายแนวนอนไม่ได้ (พอสำหรับกลุ่มเพื่อน)
- **backup อยู่บน volume เดียวกับ DB** (ข้อ 6): กันไฟล์ DB เสีย / ลบผิด / migration พัง แต่ไม่กัน volume ทั้งก้อนหาย จนกว่าจะมีสำเนานอก Railway (offsite, Q-022 ยังไม่ได้ทำ)
- **Netlify Free** ใช้ credit: production deploy ละ 15 credit จาก 300 ต่อเดือน (ประมาณ 20 deploy ถ้าไม่นับ bandwidth) credit หมด site หยุดถึงรอบเดือนใหม่ → deploy จาก branch ที่ไม่ push บ่อย
- **Deploy Preview ของ Netlify** อยู่คนละ origin (`deploy-preview-N--<site>.netlify.app`) CORS จะไม่ให้ผ่านจนกว่าจะเพิ่ม origin นั้นใน `WEB_ORIGIN`
- Railway healthcheck ตรวจแค่ตอน deploy ไม่ได้เฝ้าระหว่างรัน (ถ้าอยากรู้ตอนล่มต้องมี uptime monitor แยก)

## 6. Backup และ restore (GEN-037)
server สำรองไฟล์ DB เองระหว่างที่คนเล่นอยู่ (SQLite online backup API ไม่ต้องหยุดเกม) แต่ละไฟล์ต้องผ่าน `PRAGMA integrity_check` ก่อนได้ชื่อจริง ไฟล์ที่ทำไม่เสร็จ (เครื่องดับ / ถูก kill) ค้างเป็น `.tmp` และไม่ถูกนับ

| เรื่อง | ค่า |
|---|---|
| ที่เก็บ | `BACKUP_DIR=/data/backups` (บน volume เดียวกับ DB) ชื่อไฟล์ `isekai-<เวลา UTC>.sqlite` เช่น `isekai-20261122T120000123Z.sqlite` |
| เมื่อไร | ทุก `BACKUP_INTERVAL_HOURS` ชม. (ค่าเริ่ม 6) + ตอน start ถ้าไฟล์ล่าสุดเก่ากว่ารอบ + ตอน shutdown (SIGTERM ตอน deploy / restart) / `BACKUP_INTERVAL_HOURS=0` = ปิด |
| เก็บกี่ไฟล์ | `BACKUP_KEEP` ไฟล์ล่าสุด (ค่าเริ่ม 28 = 7 วัน) ที่เก่ากว่าถูกลบหลัง backup ใหม่สำเร็จ / backup ที่ทำด้วยมือนับรวมด้วย |
| log | Deploy Logs: `[isekai-server] backups: every 6 h + at shutdown into /data/backups, keep 28` ตอน start และ `[backup] scheduled: /data/backups/isekai-....sqlite (N bytes, M ms), removed K old` ทุกครั้ง (ไม่มีข้อมูลผู้เล่นใน log) / backup ล้ม = `[backup] ... failed: <เหตุผล>` เกมเล่นต่อได้ รอบถัดไปลองใหม่ |
| ขนาด | ประมาณเท่าไฟล์ DB ต่อ 1 ไฟล์ × 28 ไฟล์ (DB 10 MB = ~280 MB บน volume 1 GB) |
| ตอนเกมจบ (Q-185) | ทันทีหลังเทิร์นที่ทำให้เกมจบ (finale หรือ game_over) ได้ไฟล์ `gameend-<finale\|game_over>-<game id>-<เวลา UTC>.sqlite` 1 ไฟล์ต่อเกม ในโฟลเดอร์เดียวกัน **ไม่นับใน `BACKUP_KEEP` และไม่ถูกลบอัตโนมัติ** (ลบเองเมื่อไม่ใช้แล้ว) / log `[backup] game end (finale) game=<id>: ...` / ปิด backup (`BACKUP_INTERVAL_HOURS=0`) = ไม่มีไฟล์นี้ด้วย / restore ใช้ `db:restore` เหมือนไฟล์อื่น |

### 6.1 backup ด้วยมือ (เช่น ก่อน deploy ที่มี migration)
1. ติดตั้ง Railway CLI แล้ว `railway login`, `railway link` (เลือก project + service)
2. `railway ssh` (เปิด shell ใน container ที่รันอยู่)
3. `node apps/server/src/backup/backup-cli.ts` → ได้บรรทัด `[isekai-server] backup /data/backups/isekai-....sqlite (... integrity_check ok)` ใช้ได้ระหว่างที่ server รันอยู่และมีคนเล่น
4. ในเครื่อง (dev): `pnpm db:backup` (อ่าน `DB_PATH` / `BACKUP_DIR` จาก env เหมือน server)

### 6.2 restore (ลง DB ไฟล์ใหม่เสมอ ไม่ทับไฟล์เดิม)
1. `railway ssh` แล้ว `ls -l /data/backups` เลือกไฟล์ที่ต้องการ (ชื่อเรียงตามเวลา UTC)
2. `node apps/server/src/backup/restore-cli.ts /data/backups/isekai-<เวลา>.sqlite /data/isekai-restored-<วันที่>.sqlite`
   - ตรวจ `integrity_check` ของ backup → copy ลงไฟล์ใหม่ → รัน migration ที่ขาด (backup จาก version เก่า) → ตรวจ `integrity_check` อีกครั้ง → พิมพ์จำนวนแถวทุกตาราง (`member`, `room_entry`, ...)
   - ไฟล์ปลายทางมีอยู่แล้ว / backup เสีย = หยุดพร้อมเหตุผล ไม่เขียนอะไร
3. Railway → Variables → `DB_PATH=/data/isekai-restored-<วันที่>.sqlite` → Railway redeploy เอง (ไฟล์ DB เดิมยังอยู่ ถ้าต้องย้อนกลับให้เปลี่ยน `DB_PATH` กลับ)
4. ตรวจ: Deploy Logs มี `database /data/isekai-restored-....sqlite (migrations applied: 0)` / เข้าเกมเดิมด้วย session เดิมได้ / หน้า "รายการเกม" เห็นเกมครบ
5. ในเครื่อง (dev): `pnpm db:restore <backup> <ไฟล์ใหม่>` แล้วรัน server ด้วย `DB_PATH=<ไฟล์ใหม่>`

### 6.3 ยังไม่ได้ทำ
- สำเนานอก Railway (offsite, Google Drive ตาม Q-022) — backup อยู่บน volume เดียวกับ DB volume หายคือหายทั้งคู่
- Railway volume backup (ฟีเจอร์ของ Railway) เป็นชั้นเสริมได้ ยังไม่ได้เปิด
- backup ตอนเกมจบ (ADR เขียนว่า "ตอน Session จบ") ตอนนี้มีแค่ตามรอบ + ตอน start (ถ้าไฟล์ล่าสุดเก่ากว่ารอบ) + ตอน shutdown

## แหล่งอ้างอิง (ตรวจ 2026-11-22)
- Railway Config as Code (deprecated, cutoff 2026-12-01): https://docs.railway.com/reference/config-as-code
- Railway Infrastructure as Code: https://docs.railway.com/infrastructure-as-code และ reference https://docs.railway.com/infrastructure-as-code/reference
- Railway pre-deploy command (ไม่ mount volume): https://docs.railway.com/guides/pre-deploy-command
- Railway volumes: https://docs.railway.com/reference/volumes
- Railway healthchecks: https://docs.railway.com/reference/healthchecks
- Railway restart policy: https://docs.railway.com/deployments/restart-policy
- Railpack Node (version / pnpm / workspace): https://railpack.com/languages/node
- Railway public networking (http → https): https://docs.railway.com/networking/public-networking/specs-and-limits
- Netlify monorepos: https://docs.netlify.com/build/configure-builds/monorepos/
- Netlify manage dependencies (NODE_VERSION, pnpm): https://docs.netlify.com/build/configure-builds/manage-dependencies/
- Netlify HTTPS: https://docs.netlify.com/manage/domains/secure-domains-with-https/https-ssl/
