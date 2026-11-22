# Handoff: สร้าง UI asset ด้วย Scenario (Isekai Chronicles, UI v3 แชต)

เอกสารนี้สำหรับ agent ที่จะทำต่อ อ่านให้จบก่อนเรียก Scenario
ตอบ Nok เป็นภาษาไทยเสมอ

## 1. เป้าหมาย

สร้างชุด UI asset แบบภาพวาดให้หน้าเว็บเกม Isekai Chronicles (AI-GM text RPG) ตามแบบ **B+C แชตซ้าย-ขวา** ที่ Nok เลือก
แล้วตัด / แปลงไฟล์ใส่ repo `C:\Users\kwpin\Documents\Dnd Project` ตามกฎของ `apps/web/src/assets/README.md`

- แบบหน้าจอ (canvas): https://claude.ai/artifact/CDnwSr2hTFpaTKKPfWVE3U (แถวล่างสุด `BC_Play`, `BC_Mobile`)
- สเปกหน้าจอ: `docs/design/ui-v3-chat/README.md` (ไฟล์อยู่โฟลเดอร์เดียวกับเอกสารนี้)

## 2. Scenario: ตั้งค่าที่ใช้

| รายการ | ค่า |
|---|---|
| Team | `team_PCRgKduyEb3Qt8DhCFtZtJNg` (Kw Pinthong's Organization) |
| Project | `proj_L28ZbUMBBAZvG6m9ejEz8LNQ` (Default Project) |
| Model | `model_openai-gpt-image-2-5-sunburst` (Nok เลือกแล้ว) |
| พารามิเตอร์ | `width 1536, height 1024` (texture ใช้ 1024×1024), `quality "high"`, `numOutputs 1`, `background "transparent"` สำหรับกรอบ / ปุ่ม / ไอคอนพื้นใส, `"opaque"` สำหรับภาพเต็ม / texture |
| ค่าใช้ ~ | 12–13 CU ต่อภาพ |
| ข้อจำกัด | แพ็กเกจ cu-basic รันพร้อมกันได้ **2 job** เท่านั้น (เกินแล้วได้ 429) ส่งทีละ 2 ด้วย `wait:false` แล้ว `jobs_wait` |
| ต้องส่ง | `team_id` + `project_id` ทุก call ที่เขียน (model_run) |

**ความสม่ำเสมอของสไตล์:** ส่ง `referenceImages` ทุกครั้ง
- ภาพ UI (กรอบ ปุ่ม ไอคอน กรอบรูป): `asset_XsoJsnD4qtuqxyRSs7FHu4xr` (กรอบนาฬิกา: ทองเหลือง ไม้ ขอบอำพัน ดาว-จันทร์เสี้ยว)
- ภาพฉาก / สถานที่ / texture: `asset_X8gct5mePnpcvaJMstPWABZK` (key art เมืองยามค่ำ)

**ทุก prompt ต้องมี:** "No text, no numbers, no letters" (ข้อความทั้งหมดใส่ด้วย HTML), สีจาก token ด้านล่าง, "same style as the reference image"

## 3. สไตล์และ token

- โทน: "Netlify + กลิ่นแฟนตาซี" พาเลต N2 Amber Tide, ภาพวาด painterly นุ่ม ทองเหลือง + ไม้ + ลายดาว / จันทร์เสี้ยว
- สี: navy `#0F1A2B` · พื้นลึก `#0B1422` · panel `#16243A` · เส้น `#2B3F5A` · teal `#3CCFC0` · amber `#F0B44C` · text `#E8EEF5`
- ฟอนต์ (ไม่ต้องสร้าง): Trirong หัวข้อ, Anuphan เนื้อหา
- ห้ามลอกงานที่มีลิขสิทธิ์ (เช่นหน้าตา UI ของ Stardew Valley) ใช้แค่ "แนวคิด" นาฬิกาครึ่งวงกลม

## 4. ทำแล้ว (อยู่ใน Scenario project ข้างบน)

| asset_id | อะไร | สถานะ |
|---|---|---|
| `asset_X8gct5mePnpcvaJMstPWABZK` | key art เมืองยามค่ำ | ใน repo แล้ว `illustrations/home-keyart.webp` (1024px — ควรได้ 1600) |
| `asset_TdcdwA1TSNqVwqYBeCjSCsMX` | สถานที่ น้ำพุกลางเมือง (`fountain`) | ใน repo แล้ว `illustrations/place-fountain.webp` |
| `asset_a9pYG5THsEasqbXRURG5sFUv` | ไอคอนวาด 12 ตัว (HP ฯลฯ) | ใช้แค่ใน mockup — repo ใช้ SVG เส้นแทน (กฎ icons = SVG) |
| `asset_8euwbUGjJg5pEvMbgM63iSbk` | ลายประดับ เส้นคั่น + มุม | ยังไม่ได้ใช้ (repo ใช้ SVG) |
| `asset_XsoJsnD4qtuqxyRSs7FHu4xr` | กรอบนาฬิกา มีเข็มติดภาพ | แทนแล้ว ไม่ใช้ |
| `asset_DJNg8LDux8AN7V4fqTqkkvdq` | **กรอบนาฬิกา ไม่มีเข็ม** (เข็มวาดด้วยโค้ด) | ใช้ใน mockup desktop / ยังไม่เข้า repo |
| `asset_VrBt7ji6W2zX8HYUM4epkeHC` | ไอคอนอากาศ 5 แบบ: แดด ฝน หมอก คืนเดือนมืด ภัยพิบัติ | ใช้แค่ฝนใน mockup / ยังไม่เข้า repo |
| `asset_BK42V1raA7TYd4ofzjHTMDoL` | UI kit: ปุ่มหลัก (ปกติ/hover), ปุ่มรอง, กรอบ panel 9-slice, แถบแท็บ 4 ช่อง, กล่องคำพูด, badge กลม | ใช้ปุ่มหลัก + panel ใน mockup / ยังไม่เข้า repo |
| `asset_RT7k7LcRjzHqWns4sofCRHux` | กรอบรูปประจำตัว 6 ระดับ: F เหล็ก, B ทองแดง, A เงิน, S ทอง, SS ทอง+teal, ผู้เล่น (พิณ) | ใช้ F, B, ผู้เล่น ใน mockup / ยังไม่เข้า repo |
| `asset_zdHzDtxGQ7aU7X7mbmm8K2yX` | texture พื้นดาว 1024² | ใช้ใน mockup / ยังไม่เข้า repo |

## 5. งานที่ต้องทำ (เรียงตามลำดับ)

### 5.1 เอาไฟล์จริงที่มีพื้นใส
- **ปัญหา:** container ของ Claude ดาวน์โหลดจาก `cdn.cloud.scenario.com` ไม่ได้ (proxy 403) mockup จึงใช้ภาพ preview แล้วตัดพื้นดำเอง ขอบไม่เนียน
- **ทางแก้:** ใช้ `asset_download` (format `png`) แล้วดาวน์โหลดด้วยเครื่องที่ออกเน็ตได้ (device_bash บนเครื่อง Nok ถ้า allowlist ให้ผ่าน) หรือขอให้ Nok ดาวน์โหลดจากหน้า Scenario เองแล้ววางในโฟลเดอร์ที่บอก ห้ามเดา / ห้ามใช้ภาพ preview ใน repo

### 5.2 สร้างเพิ่ม (prompt ตามแบบหัวข้อ 2)
1. **ปุ่มแยกชิ้น** ให้ 9-slice ได้: ปุ่มหลัก (ปกติ / hover / กด / disabled), ปุ่มรอง, ปุ่มไอคอนสี่เหลี่ยม 44px สำหรับแถบ action
2. **แท็บแยกชิ้น**: แท็บเลือก / ไม่เลือก (ชิ้นเดียวยืดได้) แทนแถบ 4 ช่องที่ขนาดตายตัว
3. **กล่องแชต 3 แบบ** (ยืดได้): ของเรา (อำพัน หางขวา), NPC (`#1D2C45` หางซ้าย), ผู้เล่นอื่น (`#16243A`) — ขอบบาง ไม่รก
4. **ป้ายผล (chip)** ทรงแคปซูลเล็ก สำหรับ "ทอย 14 · สำเร็จ", "Stamina −1"
5. **ภาพสถานที่ที่เหลือ** 16 แห่ง (id ใน `packages/protocol/src/scenario-default.ts`): ใช้ prompt แบบน้ำพุ "eye-level, wide 3:2, darker edges so UI text can sit on top", ref = key art; ห้ามมีภาพที่เปิดเผยความลับ (เช่นแท่นพิธีลัทธิใต้ดิน ให้เป็นทางเดินมืดเฉย ๆ, มิติพิศวงไม่ทำจนกว่า Nok สั่ง)
6. (ถ้า Nok อนุมัติ) ภาพ NPC: ระวังชื่อจริงเกรด S / B ที่ยังเป็นความลับ ห้ามตั้งชื่อไฟล์ด้วยชื่อลับ

ทำทีละกลุ่ม แสดงผลให้ Nok ดูด้วย `asset_display` ก่อนเข้ากลุ่มถัดไป ถ้าใช้เกิน ~150 CU ในรอบเดียวให้ถาม Nok ก่อน

### 5.3 ตัด / แปลง / ใส่ repo
ตาม `apps/web/src/assets/README.md` (สรุป):
- ภาพวาด → WebP คุณภาพ 75–85; เต็มหน้า 1600px ≤ 500 KB; การ์ด / สถานที่ / NPC 800px ≤ 300 KB; ทำ `@2x` ถ้าใช้บนจอความละเอียดสูง
- กรอบ / ปุ่ม / กล่องแชต ที่เป็นภาพวาด → WebP พื้นใส (เก็บใน `illustrations/` หรือสร้าง `frames/` แล้วเพิ่มแถวในตารางโฟลเดอร์ของ README)
- texture → `textures/` 256–512px ต่อขอบได้ ≤ 50 KB, หลังปูแล้ว contrast ตัวหนังสือยัง ≥ 4.5:1
- ไอคอนในปุ่ม ยังคงเป็น SVG `currentColor` (มีครบ 12 ตัวแล้วใน `icons/`) ไอคอนอากาศแบบวาดใส่ `illustrations/weather-*.webp` ได้ (ใช้เป็นภาพ ไม่ใช่ไอคอนปุ่ม) พร้อม `alt` เป็นคำ
- ชื่อไฟล์: อังกฤษตัวเล็กคั่น `-`, ขึ้นต้นด้วยหมวด `place-`, `weather-`, `frame-`, `btn-`, `avatar-ring-<f|b|a|s|ss|player>`, `bubble-`
- จดทุกไฟล์ใน `CREDITS.md` ของโฟลเดอร์ (asset_id, model, วันที่)
- อัปเดตตาราง "Asset ที่เพิ่ม" ใน `docs/design/ui-v3-chat/README.md`

ไฟล์บนเครื่อง Nok: เขียนด้วย `device_commit_files` เป็นไฟล์ใหม่เท่านั้น **ห้าม git commit / checkout / merge** (dispatcher ทำงานบน `develop` พร้อมกัน) และห้ามแก้ไฟล์โค้ดเดิม

### 5.4 อัปเดต mockup (ถ้า Nok ขอ)
canvas slug `5addc2e0-a637-4c6d-9281-e157859db0d3` (Design type) — อ่าน `project/canvas.json` และไฟล์ artboard ล่าสุดก่อนแก้ทุกครั้ง (Nok แก้บน canvas เองด้วย) อัปโหลดภาพด้วย `upload_asset` แล้วใช้ url `/_blob/<id>`

## 6. ห้าม

- ห้ามใส่ข้อความ / ตัวเลขในภาพ
- ห้ามพิมพ์หรือเก็บ API key / token ใด ๆ
- ห้ามอัปเกรดแพ็กเกจ Scenario หรือทำอะไรที่เสียเงินเพิ่มนอกจาก CU ปกติ (ถ้าเครดิตไม่พอให้หยุดแล้วบอก Nok)
- ห้ามเผยความลับของเกมในภาพ / ชื่อไฟล์ (ทุกไฟล์ใน `assets/` ผู้เล่นโหลดได้)

## 7. ส่งงาน

- ตอบ Nok สั้น ๆ: asset ที่สร้าง (ตาราง), CU ที่ใช้, ไฟล์ที่ใส่ repo, สิ่งที่ Nok ต้องทำเอง (เช่นดาวน์โหลด PNG)
- log ลง Obsidian `Claude Log/Activity/YYYY-MM-DD.md` ตาม skill `obsidian-activity-log`
- ถ้าพร้อมให้ dispatcher ทำโค้ด ให้เสนอแตก task (ห้ามเขียน board เองถ้าไม่ได้ถูกสั่ง; ถ้าเขียน อ่าน `Tasks!A:A` ใหม่ก่อน ใช้ ID ต่อจากล่าสุด ตอนนี้ล่าสุดคือ GEN-117)
