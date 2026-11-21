# Deploy: server บน Railway + web บน Netlify (GEN-041a)

คู่มือ deploy / update / rollback ของ skeleton ตอนนี้ (scaffold GEN-023 + join GEN-024) ตาม Q-060 (Railway แทน PC + Cloudflare Tunnel) และ Q-031 (web บน Netlify, server แยก origin)
ไม่รวม backup job (GEN-037), realtime / Socket.IO (GEN-056) และ Cloudflare Access (Q-023)

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
| Railway | `RAILPACK_NODE_VERSION` | `26` | ให้ Railpack ใช้ Node 26 ตรงกับ `engines.node` |
| Railway | `BOOTSTRAP_INVITE_CODE` | โค้ดเกมที่ Nok ตั้งเอง เช่น 6 ตัวอักษร | ไม่บังคับ server สร้างเกมนี้ตอน start ถ้ายังไม่มี (ใช้จนกว่า GEN-025 จะมีหน้าสร้างเกม) ถือเป็นความลับระดับเดียวกับ invite code |
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
5. **Variables** ของ service: `NODE_ENV=production`, `DB_PATH=/data/isekai.sqlite`, `RAILPACK_NODE_VERSION=26` และถ้าจะทดสอบ join ให้ใส่ `BOOTSTRAP_INVITE_CODE=<โค้ดที่ตั้งเอง>` (`WEB_ORIGIN` ใส่หลัง Netlify มี URL ในข้อ 1.3)
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
| C3 | ที่ `<web>` กรอก โค้ดเกม = `BOOTSTRAP_INVITE_CODE`, ชื่อ, PIN 4-6 หลัก → เข้าร่วม แล้วกด reload | เห็น `เข้าเกมแล้ว: <ชื่อ>` ทั้งก่อนและหลัง reload |
| C3 (CORS) | `curl -s -D - -o /dev/null -H "Origin: <web>" <api>/health \| grep -i access-control-allow-origin` แล้วรันซ้ำด้วย `-H "Origin: https://evil.example.com"` | ครั้งแรกได้ `access-control-allow-origin: <web>` ครั้งที่สองไม่มีบรรทัดนี้ |
| C4 | ในเครื่อง: `pnpm test` (มี `repo-secrets.test.ts`) และ `git ls-files \| grep -iE '(^\|/)\.env$\|\.sqlite'` | test ผ่าน / grep ไม่มีผล / Railway, Netlify token ไม่เคยถูกสร้างหรือใส่ใน repo |
| C5 | หลัง C3 (มี member + session แล้ว) push commit ใหม่ที่แตะ `apps/server` (หรือ Redeploy) → รอ Active → ดู Deploy Logs → reload `<web>` | log ของ deploy แรก `migrations applied: 2` ของ deploy ถัดไป `migrations applied: 0` / ยัง login อยู่ ชื่อเดิม |
| C6 | Deployments → deployment ที่ Active → ⋮ → **Restart** แล้ว reload `<web>` / Settings → Deploy ยังเป็น Restart Policy On Failure | กลับมา Active เองไม่ต้องกดอะไรอีก ยัง login อยู่ log `migrations applied: 0` |
| C7 (web) | Chrome DevTools → Network → คลิกขวา request `/health` → **Block request domain** แล้ว reload `<web>` (ปลด block หลังตรวจ) | หน้าแสดง `Server: ต่อไม่ได้` ไม่มี error ดิบ ถ้า server ไม่ตอบเลยจะขึ้นภายใน 8 วิ |
| C7 (Railway) | Variables → ลบ `WEB_ORIGIN` ชั่วคราว → Railway redeploy → รอ → ใส่ค่าเดิมกลับ | deployment ใหม่เป็น **Failed** (healthcheck ไม่ผ่าน, log บอกว่าขาด `WEB_ORIGIN`) deployment เดิมยัง Active และ `<web>` ยัง `ต่อได้` ตลอด |

## 5. ข้อจำกัดที่ต้องรู้
- **replica เดียว**: SQLite อยู่บน volume ที่ต่อได้ทีละ container ขยายแนวนอนไม่ได้ (พอสำหรับกลุ่มเพื่อน)
- **ไม่มี backup ในงานนี้**: ไฟล์ DB มีที่เดียวคือ volume จนกว่า GEN-037 จะทำ backup (Railway มี volume backup ให้ตั้งใน GEN-037 ได้)
- **Netlify Free** ใช้ credit: production deploy ละ 15 credit จาก 300 ต่อเดือน (ประมาณ 20 deploy ถ้าไม่นับ bandwidth) credit หมด site หยุดถึงรอบเดือนใหม่ → deploy จาก branch ที่ไม่ push บ่อย
- **Deploy Preview ของ Netlify** อยู่คนละ origin (`deploy-preview-N--<site>.netlify.app`) CORS จะไม่ให้ผ่านจนกว่าจะเพิ่ม origin นั้นใน `WEB_ORIGIN`
- Railway healthcheck ตรวจแค่ตอน deploy ไม่ได้เฝ้าระหว่างรัน (ถ้าอยากรู้ตอนล่มต้องมี uptime monitor แยก)

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
