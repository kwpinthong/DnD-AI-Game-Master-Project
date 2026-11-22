# UI v3: หน้า Play แบบแชตซ้าย-ขวา (B + C)

Nok เลือก 2026-11-22: รวมทิศทาง B (สมุดบันทึก) กับ C (HUD เกมแบบแท็บ) แล้วทำ feed เป็นแชตซ้าย-ขวา
ต้นฉบับบน canvas: https://claude.ai/artifact/CDnwSr2hTFpaTKKPfWVE3U (แถวล่างสุด "B+C")

ไฟล์ในโฟลเดอร์นี้เป็น **แบบอ้างอิง** ไม่ใช่โค้ดที่ใช้จริง เปิด `mockup-play-desktop.html` / `mockup-play-mobile.html` ใน browser ได้เลย
(`mockup-icon-sheet.jpg` ใช้เฉพาะใน mockup โค้ดจริงใช้ SVG ใน `apps/web/src/assets/icons/`)

## โครงหน้า Play (desktop ≥ 1280)

| ส่วน | อยู่ไหน | มีอะไร |
|---|---|---|
| แถบบน (HUD) | บนสุด | รูป + ชื่อตัวละคร + "คนอื่นเห็นคุณเป็น: <ฉายา>", HP / Stamina (เป็นคำ) / เหรียญ พร้อมไอคอน, แถบเวลา 4 ช่วงของวัน + ช่วงปัจจุบัน + อากาศ, "ส่งแล้ว x/y" |
| feed แชต | กลาง กว้างสุด 900px | ดูตารางชนิดข้อความด้านล่าง |
| แผงข้อมูล | ขวา 340px | 4 แท็บ: สถานที่ / ตัวฉัน / กระเป๋า / คนรอบตัว รายละเอียดเป็น `<details>` พับได้ (จุดแข็ง-จุดอ่อน, สกิล, บันทึกค่าที่เปลี่ยน) |
| แถบ action | ล่างสุด | ปุ่ม action มีไอคอน + คำ (พูดคุย, สังเกต, สืบค้น, โจมตี, ป้องกัน, สวด, ลอบเร้น, พัก) กดแล้วเติมคำในช่องพิมพ์, checkbox "ลับ", ช่องพิมพ์ทรงมน, ปุ่ม "ส่ง" สีอำพัน |

## ชนิดข้อความใน feed

| ชนิด | ฝั่ง | หน้าตา |
|---|---|---|
| action ของเรา | ขวา | กล่องพื้น `#3A2E14` ขอบ `--amber` มุมล่างขวาแหลม, ป้าย "คุณ" |
| บทพูด NPC | ซ้าย | avatar วงกลมขอบตามเกรด + ชื่อสีอำพัน + กล่องพื้น `#1D2C45` |
| action ผู้เล่นคนอื่น | ซ้าย | avatar ขอบเทา + **ฉายา** (ไม่ใช่ชื่อ ถ้าไม่รู้จักกัน — GEN-117) + กล่องพื้น `#16243A` |
| **บรรยาย (GM) และ reaction** | ซ้าย เยื้อง 46px | **ไม่มีกล่อง ไม่มี avatar** ตัวเอียง สี `#C8D4E1` 15px line-height 1.7 (Nok สั่ง: บรรยายทุกอย่างใช้แบบนี้) |
| ผลทอย / ค่าที่เปลี่ยน | กลาง | ป้ายทรงแคปซูลเล็ก 12px (เช่น "ทอย 14 · สำเร็จ", "Stamina −1 · เล่นดนตรี", เหรียญบวกเป็นสีอำพัน) — GEN-114 |
| ตัวคั่นช่วงเวลา | กลาง | "— บ่าย · เทิร์น 1 · <สถานที่> —" 12px สีเทา |
| ปุ่มโหวต | ใต้บรรยาย GM | "ถูกใจ / ไม่ถูกใจ" — GEN-107 |

## มือถือ (390)

- แถบบน 2 บรรทัด: สถานที่ + เวลา / HP Stamina เหรียญ + ส่งแล้ว
- feed เต็มจอ กล่องกว้างสุด 78%
- แถบ action เหลือไอคอน 44×44 (มี `aria-label`) + ปุ่ม "อื่นๆ"
- แท็บข้อมูลย้ายเป็นแถบล่างสุด: ฉาก / ตัวฉัน / กระเป๋า / คนรอบตัว

## Token (ของเดิม Amber Tide)

navy `#0F1A2B` · พื้นลึก `#0B1422` · panel `#16243A` / `#13203A` · เส้น `#2B3F5A` · teal `#3CCFC0` · amber `#F0B44C` · text `#E8EEF5` · รอง `#C8D4E1` · จาง `#9FB0C3`
ฟอนต์: หัวข้อ Trirong, เนื้อหา Anuphan (self-host อยู่แล้วใน `assets/fonts`)

## Asset ที่เพิ่ม (apps/web/src/assets)

| ไฟล์ | ใช้ที่ |
|---|---|
| `illustrations/home-keyart.webp` | หน้าแรก (ภาพเต็มหน้า) — ตอนนี้กว้าง 1024px ต่ำกว่าที่ README กำหนด 1600 ดาวน์โหลดใหม่จาก Scenario ได้ |
| `illustrations/place-fountain.webp` | การ์ดสถานที่ `fountain` ในแท็บสถานที่ (800px) |
| `icons/status-*.svg` | hp, stamina, coin, karma บนแถบบน |
| `icons/action-*.svg` | attack, defend, pray, observe, investigate, stealth, persuade, rest บนแถบ action |
| `ornaments/divider-star.svg`, `ornaments/corner.svg` | เส้นคั่นหัวข้อ / มุมกรอบ panel |

ไอคอนและ ornament เป็น SVG `currentColor` ใช้กับ `MaskIcon` ตาม `assets/README.md`

## Asset ภาพวาดจาก Scenario (เพิ่ม 2026-11-22, ชั่วคราว)

| ไฟล์ | ใช้ที่ |
|---|---|
| `frames/frame-clock.webp` | นาฬิกา HUD desktop (เข็ม + ข้อความวางทับด้วยโค้ด ดูพิกัดใน `frames/CREDITS.md`) |
| `frames/btn-primary.webp` | พื้นปุ่มหลัก (ส่ง) |
| `frames/frame-panel.webp` | กรอบแผงข้อมูลขวา (`border-image` 9-slice) |
| `frames/avatar-ring-*.webp` | กรอบ avatar: NPC ตามเกรด f / b / a / s / ss, ผู้เล่นเรา = player, ผู้เล่นอื่น = b |
| `textures/texture-stars.webp` | พื้นหลังส่วนกลางทั้งหมดระหว่าง HUD กับแถบ action (เต็มความกว้าง) |
| `illustrations/weather-*.webp` | ภาพอากาศ 5 แบบ บนนาฬิกาและแท็บสถานที่ |

ไฟล์เหล่านี้ตัดพื้นจากภาพ preview จะถูกแทนที่ด้วยไฟล์จริง (ชื่อเดิม) ตาม `HANDOFF-scenario-ui-assets.md`
`frames/` เป็นโฟลเดอร์ใหม่ ให้เพิ่มแถวในตาราง "โฟลเดอร์" ของ `apps/web/src/assets/README.md` ตอนทำ GEN-122

## ภาพสถานที่ (Nok 2026-11-22)

`illustrations/place-<id>.webp` (800px) + `place-<id>@2x.webp` (1600px) ครบ 13 แห่ง: inn, fountain, temple, forest, farmland, theater, manor, market, barracks, sea, dawn-church, clinic, library
- ใช้ใน: การ์ดสถานที่ในแท็บ "สถานที่" (และพื้นหลังจางของ feed ได้ถ้าต้องการ) เลือกไฟล์จาก `PlaceView.id` ใช้ `srcset` 1x/2x
- ยังไม่มีภาพ: `church-crypt`, `community`, `astral-rift` → แสดงกรอบว่างพื้น navy + ชื่อสถานที่ (ห้ามแตก)
- ต้นฉบับ PNG (~43 MB) อยู่ใน `assets/place/` **ห้าม commit** (README ห้ามไฟล์ต้นฉบับใหญ่ใน repo) ให้ย้ายออกหรือใส่ .gitignore
