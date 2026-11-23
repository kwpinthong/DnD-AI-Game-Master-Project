# UI inventory (ISK-003)

ภาพทุกหน้า × ทุกสถานะของเว็บ Isekai Chronicles ณ `develop` 71d86d2 เพื่อใช้ออกแบบใหม่ทั้งระบบ ไม่มีการแก้โค้ด production

- **ภาพ:** `img/<หน้า>-<สถานะ>-<desktop|mobile>.webp` desktop 1366×768, มือถือ 390×844 (เก็บเฉพาะ viewport) webp quality 80 ทุกไฟล์ ≤ 150 KB (ไฟล์ที่เกินลด quality ทีละ 10)
- **วิธีถ่าย:** Chrome headless คุมผ่าน DevTools Protocol (`Emulation.setDeviceMetricsOverride` ตั้งขนาดจอตรงๆ แทน iframe) เปิด web ใน mock mode (`VITE_MOCK=1`) ที่ localhost
  - ภาพ "gallery scenario" = `/dev/gallery?screen=<screen>&scenario=<id>` ซ่อนหัว / caption ของ gallery ในแท็บที่ถ่ายเท่านั้น
  - ภาพที่ต้องคลิก = แอปจริงใน mock (`/?scenario=…`, `/admin?scenario=…`) หรือ gallery frame แล้วคลิกปุ่มตามคอลัมน์ "ได้มาอย่างไร" (ป้าย "mock: …" มุมซ้ายล่างเป็นของ mock mode ไม่ใช่ UI จริง)
  - ภาพจาก scenario ที่เปลี่ยนตามเวลา (waiting, reconnect, period-change, lobby-join, hit, late-npc) ถ่ายที่ราว 3 วินาทีหลังเปิดหน้า
  - เครื่องมือถ่าย (script ทิ้งได้ ไม่อยู่ใน repo): Chrome headless + Node WebSocket ในตัว ไม่ได้เพิ่ม dependency
  - หน้า admin ใช้ token สมมติใน sessionStorage ของ mock (mock ไม่ตรวจ token) ไม่ได้ใช้หรือพิมพ์ admin code จริง
- **ข้อมูลในภาพ:** fixture ของ `@isekai/protocol/contract` + `apps/web/src/mock/scenarios.ts` เท่านั้น (ชื่อผู้เล่นสมมติ เช่น นก ลิน ปลา) ไม่ได้ต่อ server จริงหรือ AI
- **ชื่อ NPC (C4):** สแกนข้อความที่ render ของทุกภาพเทียบรายชื่อจาก `apps/server/assets/npc.json`: ชื่อจริงที่ยังไม่เปิดเผย (Elena, Garrett, Victor, Marcus, ชื่อร่างจริงเกรด SS/S) = 0 ภาพ / ชื่อสาธารณะที่ปรากฏ: ลูเซีย ในห้องเล่น (คุยกับผู้เล่นแล้ว), โนอา ในหน้าสรุปตอนจบ (คู่หู) และหน้า admin (ไม่ใช่มุมผู้เล่น); NPC ที่ยังไม่รู้จักแสดงเป็นลักษณะ เช่น "เด็กขอทานตาบอดข้างหนึ่ง" / "เด็กชายตัวผอม"
- **UI v3** = หน้าที่ใช้ component ใน `apps/web/src/ui` หรือ `apps/web/src/play/chat` (บน token ของ `tokens.css`) / **หน้าเก่า** = element ธรรมดา (ได้แค่สีจาก theme.css)
- สรุป: 20 หน้า, 217 ภาพ, สถานะที่ไม่มีภาพ 30 แถว (มีเหตุผลกำกับทุกแถว)

## ตาราง inventory

| หน้า | route | component | สถานะ | ภาพ | UI v3 / หน้าเก่า | หมายเหตุ |
|---|---|---|---|---|---|---|
| เข้าเกม · หน้าแรก | `/` | App.tsx | ยังไม่เข้าเกม (ฟอร์ม join) / เข้าเกมแล้ว เกมเริ่มแล้ว / เข้าเกมแล้ว ห้องรอ / เข้าเกมแล้ว เกมจบ / สลับไปฟอร์มสร้างเกม / checking / restoring (กำลังเข้าเกม…) / server ต่อไม่ได้ | [guest](img/home-guest-desktop.webp) [normal](img/home-normal-desktop.webp) [lobby](img/home-lobby-desktop.webp) [ended](img/home-ended-desktop.webp) [guest-create](img/home-guest-create-desktop.webp) | หน้าเก่า | หัวหน้า + สถานะ server + ปุ่มรายการเกม ใช้ element ธรรมดา (ฟอร์มที่ฝังอยู่ข้างในเป็น UI v3) |
| เข้าเกม · เข้าร่วมเกม | `/` (guest) | JoinForm.tsx | ว่าง ปุ่มส่งยังกดไม่ได้ / เปิดในเกม normal / ช่องว่างแล้วออกจากช่อง (field error) / กำลังเข้าร่วม… / server ตอบ error ของฟอร์ม | [guest](img/join-guest-desktop.webp) [normal](img/join-normal-desktop.webp) [field-error](img/join-field-error-desktop.webp) | UI v3 | Button / Field / Panel จาก ui/ |
| เข้าเกม · สร้างเกม | `/` (guest → สร้างเกมใหม่) | CreateGameForm.tsx (+ TonePicker, NpcDialoguePicker) | ค่าเริ่มต้น / เปิดในเกม normal / field error / เลือกเล่นคนเดียว (ซ่อนส่วน GM) / ดูเกมที่ใช้ได้ / เปิดความทรงจำ / ไม่มีเกมให้ใช้ / โหลดแหล่งความทรงจำไม่ได้ / server error | [guest](img/create-game-guest-desktop.webp) [normal](img/create-game-normal-desktop.webp) [field-error](img/create-game-field-error-desktop.webp) [single](img/create-game-single-desktop.webp) | UI v3 | TonePicker / NpcDialoguePicker เป็น radio ธรรมดา (ส่วนเก่าในหน้า v3) |
| เข้าเกม · รายการเกม | `/` → รายการเกม | GameHistory.tsx | มีเกมในรายการ / ไม่มีเกม (browser ใหม่) / โหลดอยู่ / เกมหนึ่งติดต่อไม่ได้ | [home-history-open](img/home-history-open-desktop.webp) [home-history-empty](img/home-history-empty-desktop.webp) | หน้าเก่า (ส่วนบันทึกเกมเป็น UI v3) | ส่วนรายการใช้ element ธรรมดา; GameLog / GameSummaryPage ใช้ ui/ |
| เข้าเกม · ห้องรอ | `/` (member) | Lobby.tsx | เจ้าของเกม ยังเริ่มไม่ได้ / ยังไม่มีตัวละคร / มีคนเข้าเพิ่ม (ภาพที่ 3 วิ อาจยังไม่เห็นคนใหม่ซึ่งมาที่ 4 วิ) / เกมเริ่มระหว่างสร้างตัวละคร / เกมเริ่มแล้ว (เข้าห้องเล่น) / คัดลอกโค้ดเกม (toast) / ยืนยันลบเกม (modal) / skeleton ตอนโหลด / โหลดไม่ได้ / action error | [lobby](img/lobby-lobby-desktop.webp) [no-character](img/lobby-no-character-desktop.webp) [lobby-join](img/lobby-lobby-join-desktop.webp) [start-while-creating](img/lobby-start-while-creating-desktop.webp) [normal](img/lobby-normal-desktop.webp) [confirm-delete](img/lobby-confirm-delete-desktop.webp) | UI v3 | Panel / Button / Skeleton / Toast |
| เข้าเกม · สร้างตัวละคร | `/` → สร้างตัวละคร | CharacterScreen.tsx (+ LootStep.tsx) | ขั้น 1 ตัวตน (ว่าง) / เกมเริ่มแล้ว แก้ตัวละครไม่ได้ (ล็อก) / ขั้น 2 ของติดตัว ก่อนให้ AI วิเคราะห์ (ปุ่มถัดไปปิด + เหตุผลใต้ปุ่ม) / ของติดตัว (scenario AI ล้ม ก่อนกด) / AI กำลังวิเคราะห์ / AI ล้ม + ปุ่มลองใหม่ / เปิดสรุป (aside, มีเฉพาะมือถือ) / ข้อเสนอของติดตัวจาก AI / เลือกแล้ว / validation ของติดตัว / ขั้น 3 ตรวจทาน / ต้องเลือกใหม่ / โหลดไม่ได้ | [no-character](img/character-no-character-desktop.webp) [normal](img/character-normal-desktop.webp) [loot-loading](img/character-loot-loading-desktop.webp) [loot-error](img/character-loot-error-desktop.webp) [loot-analysing](img/character-loot-analysing-desktop.webp) [loot-error-retry](img/character-loot-error-retry-desktop.webp) [summary-open](img/character-summary-open-mobile.webp) | UI v3 | Stepper / Field / Panel |
| เข้าเกม · การ์ดจุดเกิด | `/` → เข้าห้องเล่น ครั้งแรก | OriginCard.tsx | จุดเกิดปกติ / จุดเกิดหายาก เรื่องยังเขียนไม่เสร็จ / โหลดอยู่ | [normal](img/origin-card-normal-desktop.webp) [origin-rare](img/origin-card-origin-rare-desktop.webp) | UI v3 | modal ครั้งเดียวต่อเกม (localStorage isekai.originSeen.*) |
| ในเกม · ห้องเล่น (Play) | `/` → เข้าห้องเล่น | PlayRoom.tsx + play/chat/* (DesktopLayout ≥ 768 px, MobileLayout < 768 px) | ปกติ เทิร์นเปิด / ส่งแล้ว รอคนอื่น / แก้ action ที่ส่งแล้ว / กดส่งตอนช่องว่าง / ติ๊ก ลับ / quota ลับหมด / โหวต AI GM (👍/👎 + เหตุผล) / socket หลุดแล้วต่อใหม่ / เปลี่ยนช่วงเวลา / อากาศ / NPC พูดมาทีหลัง / สีแชต (badge, โหวต, ผู้เล่นอื่น) / เล่นคนเดียว / โดนผลจากคนอื่น (hit pin) / lock: หมดแรง / lock: สลบ / lock: กำลังสรุปผล + GM narrating / lock: เดินทางข้ามโซน / lock: พักฟื้น / Astral Spirit (ลางสังหรณ์) / AI GM ติดขัด + ลองใหม่ / AI GM หยุดเพราะงบ / lock: เกมจบ / เมนูเปิด / ประวัติ (บันทึกเกม) / แท็บ/แผ่น ตัวฉัน / แท็บ/แผ่น กระเป๋า / แท็บ/แผ่น คนรอบตัว / แผ่น ฉาก (มือถือเท่านั้น) / action อื่นๆ (มือถือเท่านั้น) / เลือกที่เดินทาง / คุยกับ NPC / Whisper (เลื่อนลงในแผงคนรอบตัว) / skeleton ตอนต่อ socket / fatal (ห้องปิด / session หลุด) / เดินทางล้ม / quota คุย NPC หมด / คุยล้ม | [normal](img/play-normal-desktop.webp) [waiting](img/play-waiting-desktop.webp) [edit-sent](img/play-edit-sent-desktop.webp) [send-validation](img/play-send-validation-desktop.webp) [secret-on](img/play-secret-on-desktop.webp) [secret-used](img/play-secret-used-desktop.webp) [vote](img/play-vote-desktop.webp) [reconnect](img/play-reconnect-desktop.webp) [period-change](img/play-period-change-desktop.webp) [late-npc](img/play-late-npc-desktop.webp) [chat-colours](img/play-chat-colours-desktop.webp) [single](img/play-single-desktop.webp) [hit](img/play-hit-desktop.webp) [exhausted](img/play-exhausted-desktop.webp) [unconscious](img/play-unconscious-desktop.webp) [resolving](img/play-resolving-desktop.webp) [traveling](img/play-traveling-desktop.webp) [recovering](img/play-recovering-desktop.webp) [astral](img/play-astral-desktop.webp) [stuck](img/play-stuck-desktop.webp) [budget-reached](img/play-budget-reached-desktop.webp) [ended](img/play-ended-desktop.webp) [menu-open](img/play-menu-open-desktop.webp) [history-open](img/play-history-open-desktop.webp) [tab-self](img/play-tab-self-desktop.webp) [tab-bag](img/play-tab-bag-desktop.webp) [tab-people](img/play-tab-people-desktop.webp) [sheet-place](img/play-sheet-place-mobile.webp) [quick-more](img/play-quick-more-mobile.webp) [travel](img/play-travel-desktop.webp) [npc-chat](img/play-npc-chat-desktop.webp) [whisper](img/play-whisper-desktop.webp) | UI v3 | ทุก screen play-* ใน gallery คือหน้าเดียวกัน ภาพแยกตาม scenario; มือถือ = MobileLayout |
| จบ · สรุปเกม + ให้คะแนน | `/` → รายการเกม → ดูสรุป / ห้องเล่น → ประวัติ | Ending.tsx (GameSummaryPage, GameLog) | เปิดความลับ + ฟอร์มคะแนน / ความลับหลายวัน (ตัวกรองวัน) / โหวต 👎 การตัดสิน / มุม Human GM (ไม่มีปุ่มโหวต) / สกัดความรู้ไม่สำเร็จ + ลองใหม่ / บันทึกเกมที่ยังไม่จบ / บันทึกเกมที่ยังไม่จบ (ผ่านรายการเกม) / ส่วนให้คะแนน ยังไม่ส่ง / ให้คะแนนแล้ว ผ่านเกณฑ์ / คะแนนไม่ผ่านเกณฑ์ / ส่วนให้คะแนน + โหวต 👎 / ส่วนให้คะแนน มุม GM / ส่วนให้คะแนน เกม normal / กดส่งโดยไม่เลือกคะแนน / ส่งคะแนนแล้ว / แก้คะแนน / โหลดคะแนน / สรุปไม่ได้ | [ended](img/ending-ended-desktop.webp) [ended-days](img/ending-ended-days-desktop.webp) [ended-down](img/ending-ended-down-desktop.webp) [ended-gm](img/ending-ended-gm-desktop.webp) [ended-learning-failed](img/ending-ended-learning-failed-desktop.webp) [normal](img/ending-normal-desktop.webp) [log-not-ended](img/ending-log-not-ended-desktop.webp) [rating-ended](img/ending-rating-ended-desktop.webp) [rating-ended-rated](img/ending-rating-ended-rated-desktop.webp) [rating-ended-low](img/ending-rating-ended-low-desktop.webp) [rating-ended-down](img/ending-rating-ended-down-desktop.webp) [rating-ended-gm](img/ending-rating-ended-gm-desktop.webp) [rating-normal](img/ending-rating-normal-desktop.webp) [rating-pick-error](img/ending-rating-pick-error-desktop.webp) | UI v3 | ภาพ ending-rating-* = หน้าเดียวกันเลื่อนลงไปที่ส่วนให้คะแนน |
| GM · GM console | `/` (Human GM) → ห้องเล่น | GmConsole.tsx | เทิร์นรออนุมัติ / ฉากจบรออนุมัติ / ถึงเพดานงบ AI / เปิดด้วย session ผู้เล่น / ฟอร์มปรับค่า / แทรกเหตุการณ์ error / โหลดอยู่ / โหลดไม่ได้ | [gm](img/gm-console-gm-desktop.webp) [gm-finale](img/gm-console-gm-finale-desktop.webp) [gm-budget](img/gm-console-gm-budget-desktop.webp) [normal](img/gm-console-normal-desktop.webp) | UI v3 (บางส่วน) | ใช้ Button / ErrorState / Skeleton จาก ui/ แต่แผงส่วนใหญ่เป็น markup ของตัวเอง |
| GM · Scenario editor | `/` (GM) → ดู scenario | ScenarioEditor.tsx | อ่านอย่างเดียว แท็บเหตุการณ์ 12 วัน / เปิดด้วย session ผู้เล่น / แท็บ NPC / แท็บ ตำนานลับ / แก้ได้ / validation error / บันทึก / reset | [gm](img/scenario-editor-gm-desktop.webp) [normal](img/scenario-editor-normal-desktop.webp) [tab-npc](img/scenario-editor-tab-npc-desktop.webp) [tab-lore](img/scenario-editor-tab-lore-desktop.webp) | หน้าเก่า | fixture ทุกตัว canEditScenario: false จึงเห็นแต่แบบอ่านอย่างเดียว |
| GM · ห้องเล่นมุม GM | `/` (Human GM) → เข้าห้องเล่น | PlayRoom.tsx + GmConsole.tsx | gallery frame ห้องเล่น session GM / แอปจริงใน mock: GM เข้าห้องเล่น | [play-gm](img/play-gm-desktop.webp) [view](img/play-gm-view-desktop.webp) | UI v3 | ห้องเล่นของ GM ที่มี GM console ฝังอยู่ |
| admin · admin: เข้าสู่ระบบ | `/admin` | AdminDashboard.tsx (AdminLogin) | ฟอร์ม admin code / ส่งช่องว่าง / gallery frame ai-usage (ยังไม่มี token = หน้า login) / forbidden (token หมดอายุ) | [admin-login](img/admin-login-desktop.webp) [error](img/admin-login-error-desktop.webp) [admin-usage-normal](img/admin-usage-normal-desktop.webp) | หน้าเก่า | ไม่ได้พิมพ์ admin code จริง: ภาพ error มาจากการกดส่งช่องว่างใน mock |
| admin · admin: การใช้ AI | `/admin` แท็บ การใช้ AI | AdminDashboard.tsx (Dashboard) | ภาพรวมทุกเกม / รายละเอียดเกม / ยังไม่มีการเรียก AI / poll error | [admin-usage](img/admin-usage-desktop.webp) [game-detail](img/admin-usage-game-detail-desktop.webp) | หน้าเก่า | token ใน mock = ค่าสมมติใน sessionStorage |
| admin · admin: Learning library | `/admin` แท็บ Learning library › ความรู้ที่เก็บไว้ | LearningLibrary.tsx | รายการความรู้ (ในหน้า admin) / gallery frame ปกติ / ว่าง / กำลังโหลด / โหลดไม่ได้ / ยืนยันลบรายการ (modal) / ยืนยันลบทั้งเกม (modal) / ลบไม่สำเร็จ | [entries](img/admin-library-entries-desktop.webp) [normal](img/admin-library-normal-desktop.webp) [library-empty](img/admin-library-library-empty-desktop.webp) [library-loading](img/admin-library-library-loading-desktop.webp) [library-error](img/admin-library-library-error-desktop.webp) [confirm-entry](img/admin-library-confirm-entry-desktop.webp) [confirm-game](img/admin-library-confirm-game-desktop.webp) | UI v3 | Skeleton / ErrorState / EmptyState / ConfirmDialog |
| admin · admin: คลังบทพูด NPC | `/admin` แท็บ Learning library › คลังบทพูดต่อ NPC | NpcLibrary.tsx | รายการ / ยืนยันลบ (modal) / โหลดอยู่ / ว่าง / โหลดไม่ได้ | [admin-library-npc](img/admin-library-npc-desktop.webp) [confirm](img/admin-library-npc-confirm-desktop.webp) | UI v3 | ไม่มีใน gallery: ถ่ายจาก `/admin` ใน mock |
| admin · admin: ข้อมูลเกม | `/admin` แท็บ ข้อมูลเกม | GameDataEditor.tsx (+ GameDataForm.tsx) | รายการชุดข้อมูล / gallery frame / ฟอร์มแก้ชุดข้อมูล / แก้เป็น JSON ดิบ / นำเข้าจากไฟล์ (preview) / fallback alert / error | [admin-data](img/admin-data-desktop.webp) [normal](img/admin-data-normal-desktop.webp) [editor](img/admin-data-editor-desktop.webp) [raw-json](img/admin-data-raw-json-desktop.webp) | หน้าเก่า |  |
| admin · admin: ข้อความที่ถูก 👎 | `/admin` แท็บ ข้อความที่ถูก 👎 | VoteReview.tsx + StylePanel.tsx + StyleEval.tsx | รายการข้อความ 👎 / gallery frame VoteReview / ฟอร์มแก้เป็น / StylePanel (ตั้งค่า + ธงสำนวน) / StyleEval (เทียบรอบ) / ว่าง / โหลดไม่ได้ / ยังไม่มีรอบ eval | [admin-votes](img/admin-votes-desktop.webp) [normal](img/admin-votes-normal-desktop.webp) [edit](img/admin-votes-edit-desktop.webp) [style-panel](img/admin-votes-style-panel-desktop.webp) [style-eval](img/admin-votes-style-eval-desktop.webp) | UI v3 (VoteReview) / หน้าเก่า (StylePanel, StyleEval) | สามส่วนอยู่ในแท็บเดียวกัน |
| admin · admin: ทบทวนสำนวน | `/admin` แท็บ ทบทวนสำนวน | StyleReview.tsx | ข้อเสนอที่รออนุมัติ / กำลังรัน / ว่าง / error / JSON ผิด | [review](img/admin-style-review-desktop.webp) | หน้าเก่า |  |
| admin · dev: gallery / chat colours | `/dev/gallery`, `/dev/chat-colours` (dev + VITE_MOCK=1 เท่านั้น) | dev/Gallery.tsx, dev/ChatColours.tsx | หน้ารวม gallery / ตารางสีแชต | [gallery-index](img/dev-gallery-index-desktop.webp) [chat-colours](img/dev-chat-colours-desktop.webp) | เครื่องมือ dev (ไม่นับ) | ไม่อยู่ใน production bundle |

### หน้าที่จะมา (ยังไม่มีภาพ)

| หน้า | หมายเหตุ |
|---|---|
| my-style | หน้า "สำนวนของฉัน" อยู่ในสัญญา GEN-099 แต่ยังไม่มีหน้า (gallery แสดงเป็นช่องว่าง) |
| ISK-002 | ยังไม่ merge ตอนเริ่มงาน: จดเป็นหน้าที่จะมา |
| ISK-007 | ยังไม่ merge ตอนเริ่มงาน: จดเป็นหน้าที่จะมา |

# สถานะต่อหน้า

## เข้าเกม


### หน้าแรก (`home`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| ยังไม่เข้าเกม (ฟอร์ม join) | gallery scenario `guest` | [home-guest-desktop.webp](img/home-guest-desktop.webp) 45 KB | [home-guest-mobile.webp](img/home-guest-mobile.webp) 30 KB |
| เข้าเกมแล้ว เกมเริ่มแล้ว | gallery scenario `normal` | [home-normal-desktop.webp](img/home-normal-desktop.webp) 45 KB | [home-normal-mobile.webp](img/home-normal-mobile.webp) 30 KB |
| เข้าเกมแล้ว ห้องรอ | gallery scenario `lobby` | [home-lobby-desktop.webp](img/home-lobby-desktop.webp) 45 KB | [home-lobby-mobile.webp](img/home-lobby-mobile.webp) 30 KB |
| เข้าเกมแล้ว เกมจบ | gallery scenario `ended` | [home-ended-desktop.webp](img/home-ended-desktop.webp) 45 KB | [home-ended-mobile.webp](img/home-ended-mobile.webp) 30 KB |
| สลับไปฟอร์มสร้างเกม | `/?scenario=guest` → สร้างเกมใหม่ | [home-guest-create-desktop.webp](img/home-guest-create-desktop.webp) 19 KB | [home-guest-create-mobile.webp](img/home-guest-create-mobile.webp) 19 KB |
| checking / restoring (กำลังเข้าเกม…) | ไม่มีภาพ: mock ตอบทุก request ใน 120 ms สถานะนี้แค่กะพริบ และไม่มี scenario ที่ค้างไว้ (ต้องเพิ่ม scenario ใน mock = แก้โค้ด) | — | — |
| server ต่อไม่ได้ | ไม่มีภาพ: ไม่มี scenario ที่ /health ล้ม (ต้องแก้ mock) | — | — |

### เข้าร่วมเกม (`join`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| ว่าง ปุ่มส่งยังกดไม่ได้ | gallery scenario `guest` | [join-guest-desktop.webp](img/join-guest-desktop.webp) 45 KB | [join-guest-mobile.webp](img/join-guest-mobile.webp) 36 KB |
| เปิดในเกม normal | gallery scenario `normal` | [join-normal-desktop.webp](img/join-normal-desktop.webp) 45 KB | [join-normal-mobile.webp](img/join-normal-mobile.webp) 36 KB |
| ช่องว่างแล้วออกจากช่อง (field error) | focus/blur ทุกช่อง | [join-field-error-desktop.webp](img/join-field-error-desktop.webp) 45 KB | [join-field-error-mobile.webp](img/join-field-error-mobile.webp) 36 KB |
| กำลังเข้าร่วม… | ไม่มีภาพ: mock ตอบทุก request ใน 120 ms สถานะนี้แค่กะพริบ และไม่มี scenario ที่ค้างไว้ (ต้องเพิ่ม scenario ใน mock = แก้โค้ด) | — | — |
| server ตอบ error ของฟอร์ม | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### สร้างเกม (`create-game`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| ค่าเริ่มต้น | gallery scenario `guest` | [create-game-guest-desktop.webp](img/create-game-guest-desktop.webp) 19 KB | [create-game-guest-mobile.webp](img/create-game-guest-mobile.webp) 18 KB |
| เปิดในเกม normal | gallery scenario `normal` | [create-game-normal-desktop.webp](img/create-game-normal-desktop.webp) 19 KB | [create-game-normal-mobile.webp](img/create-game-normal-mobile.webp) 18 KB |
| field error | focus/blur ช่องข้อความ | [create-game-field-error-desktop.webp](img/create-game-field-error-desktop.webp) 19 KB | [create-game-field-error-mobile.webp](img/create-game-field-error-mobile.webp) 19 KB |
| เลือกเล่นคนเดียว (ซ่อนส่วน GM) | คลิก เล่นคนเดียว | [create-game-single-desktop.webp](img/create-game-single-desktop.webp) 17 KB | [create-game-single-mobile.webp](img/create-game-single-mobile.webp) 18 KB |
| ดูเกมที่ใช้ได้ / เปิดความทรงจำ | ไม่มีภาพ: ต้องพิมพ์ player code แล้วกดดูเกม รอบนี้ไม่ได้ทำภาพ (ทำได้ใน mock รอบหน้า) | — | — |
| ไม่มีเกมให้ใช้ / โหลดแหล่งความทรงจำไม่ได้ / server error | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### รายการเกม (`game-list`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| มีเกมในรายการ | `/?scenario=normal` → รายการเกม | [home-history-open-desktop.webp](img/home-history-open-desktop.webp) 25 KB | [home-history-open-mobile.webp](img/home-history-open-mobile.webp) 22 KB |
| ไม่มีเกม (browser ใหม่) | `/?scenario=guest` → รายการเกม | [home-history-empty-desktop.webp](img/home-history-empty-desktop.webp) 48 KB | [home-history-empty-mobile.webp](img/home-history-empty-mobile.webp) 30 KB |
| โหลดอยู่ | ไม่มีภาพ: mock ตอบทุก request ใน 120 ms สถานะนี้แค่กะพริบ และไม่มี scenario ที่ค้างไว้ (ต้องเพิ่ม scenario ใน mock = แก้โค้ด) | — | — |
| เกมหนึ่งติดต่อไม่ได้ | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### ห้องรอ (`lobby`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| เจ้าของเกม ยังเริ่มไม่ได้ | gallery scenario `lobby` | [lobby-lobby-desktop.webp](img/lobby-lobby-desktop.webp) 29 KB | [lobby-lobby-mobile.webp](img/lobby-lobby-mobile.webp) 24 KB |
| ยังไม่มีตัวละคร | gallery scenario `no-character` | [lobby-no-character-desktop.webp](img/lobby-no-character-desktop.webp) 29 KB | [lobby-no-character-mobile.webp](img/lobby-no-character-mobile.webp) 24 KB |
| มีคนเข้าเพิ่ม (ภาพที่ 3 วิ อาจยังไม่เห็นคนใหม่ซึ่งมาที่ 4 วิ) | gallery scenario `lobby-join` | [lobby-lobby-join-desktop.webp](img/lobby-lobby-join-desktop.webp) 29 KB | [lobby-lobby-join-mobile.webp](img/lobby-lobby-join-mobile.webp) 24 KB |
| เกมเริ่มระหว่างสร้างตัวละคร | gallery scenario `start-while-creating` | [lobby-start-while-creating-desktop.webp](img/lobby-start-while-creating-desktop.webp) 29 KB | [lobby-start-while-creating-mobile.webp](img/lobby-start-while-creating-mobile.webp) 24 KB |
| เกมเริ่มแล้ว (เข้าห้องเล่น) | gallery scenario `normal` | [lobby-normal-desktop.webp](img/lobby-normal-desktop.webp) 27 KB | [lobby-normal-mobile.webp](img/lobby-normal-mobile.webp) 25 KB |
| คัดลอกโค้ดเกม (toast) | ไม่มีภาพ: คลิก คัดลอก ใน Chrome headless แล้ว toast ไม่ขึ้นในภาพ (clipboard ของ headless ไม่มีสิทธิ์) ต้องถ่ายใน browser ปกติ | — | — |
| ยืนยันลบเกม (modal) | คลิก ลบเกม | [lobby-confirm-delete-desktop.webp](img/lobby-confirm-delete-desktop.webp) 29 KB | [lobby-confirm-delete-mobile.webp](img/lobby-confirm-delete-mobile.webp) 24 KB |
| skeleton ตอนโหลด | ไม่มีภาพ: mock ตอบทุก request ใน 120 ms สถานะนี้แค่กะพริบ และไม่มี scenario ที่ค้างไว้ (ต้องเพิ่ม scenario ใน mock = แก้โค้ด) | — | — |
| โหลดไม่ได้ / action error | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### สร้างตัวละคร (`character`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| ขั้น 1 ตัวตน (ว่าง) | gallery scenario `no-character` | [character-no-character-desktop.webp](img/character-no-character-desktop.webp) 15 KB | [character-no-character-mobile.webp](img/character-no-character-mobile.webp) 12 KB |
| เกมเริ่มแล้ว แก้ตัวละครไม่ได้ (ล็อก) | gallery scenario `normal` | [character-normal-desktop.webp](img/character-normal-desktop.webp) 7 KB | [character-normal-mobile.webp](img/character-normal-mobile.webp) 6 KB |
| ขั้น 2 ของติดตัว ก่อนให้ AI วิเคราะห์ (ปุ่มถัดไปปิด + เหตุผลใต้ปุ่ม) | gallery scenario `loot-loading` | [character-loot-loading-desktop.webp](img/character-loot-loading-desktop.webp) 22 KB | [character-loot-loading-mobile.webp](img/character-loot-loading-mobile.webp) 18 KB |
| ของติดตัว (scenario AI ล้ม ก่อนกด) | gallery scenario `loot-error` | [character-loot-error-desktop.webp](img/character-loot-error-desktop.webp) 22 KB | [character-loot-error-mobile.webp](img/character-loot-error-mobile.webp) 18 KB |
| AI กำลังวิเคราะห์ | loot-loading → ให้ AI วิเคราะห์บุคลิก | [character-loot-analysing-desktop.webp](img/character-loot-analysing-desktop.webp) 24 KB | [character-loot-analysing-mobile.webp](img/character-loot-analysing-mobile.webp) 20 KB |
| AI ล้ม + ปุ่มลองใหม่ | loot-error → ให้ AI วิเคราะห์บุคลิก | [character-loot-error-retry-desktop.webp](img/character-loot-error-retry-desktop.webp) 24 KB | [character-loot-error-retry-mobile.webp](img/character-loot-error-retry-mobile.webp) 20 KB |
| เปิดสรุป (aside, มีเฉพาะมือถือ) | loot-loading → ดูสรุป | ไม่มี (สถานะนี้มีเฉพาะมือถือ) | [character-summary-open-mobile.webp](img/character-summary-open-mobile.webp) 19 KB |
| ข้อเสนอของติดตัวจาก AI / เลือกแล้ว / validation ของติดตัว / ขั้น 3 ตรวจทาน | ไม่มีภาพ: ต้องได้คำตอบ loot จาก AI ก่อน: scenario ที่มีอยู่ค้าง (loot-loading) หรือล้ม (loot-error) และ normal ล็อกแล้ว จึงไปต่อใน mock ไม่ได้ (ต้องเพิ่ม scenario) | — | — |
| ต้องเลือกใหม่ / โหลดไม่ได้ | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### การ์ดจุดเกิด (`origin-card`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| จุดเกิดปกติ | gallery scenario `normal` | [origin-card-normal-desktop.webp](img/origin-card-normal-desktop.webp) 19 KB | [origin-card-normal-mobile.webp](img/origin-card-normal-mobile.webp) 17 KB |
| จุดเกิดหายาก เรื่องยังเขียนไม่เสร็จ | gallery scenario `origin-rare` | [origin-card-origin-rare-desktop.webp](img/origin-card-origin-rare-desktop.webp) 21 KB | [origin-card-origin-rare-mobile.webp](img/origin-card-origin-rare-mobile.webp) 19 KB |
| โหลดอยู่ | ไม่มีภาพ: mock ตอบทุก request ใน 120 ms สถานะนี้แค่กะพริบ และไม่มี scenario ที่ค้างไว้ (ต้องเพิ่ม scenario ใน mock = แก้โค้ด) | — | — |

## ในเกม


### ห้องเล่น (Play) (`play`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| ปกติ เทิร์นเปิด | gallery scenario `normal` | [play-normal-desktop.webp](img/play-normal-desktop.webp) 84 KB | [play-normal-mobile.webp](img/play-normal-mobile.webp) 29 KB |
| ส่งแล้ว รอคนอื่น | gallery scenario `waiting` | [play-waiting-desktop.webp](img/play-waiting-desktop.webp) 87 KB | [play-waiting-mobile.webp](img/play-waiting-mobile.webp) 32 KB |
| แก้ action ที่ส่งแล้ว | waiting → แก้ไข | [play-edit-sent-desktop.webp](img/play-edit-sent-desktop.webp) 85 KB | [play-edit-sent-mobile.webp](img/play-edit-sent-mobile.webp) 31 KB |
| กดส่งตอนช่องว่าง | คลิก ส่ง | [play-send-validation-desktop.webp](img/play-send-validation-desktop.webp) 82 KB | [play-send-validation-mobile.webp](img/play-send-validation-mobile.webp) 30 KB |
| ติ๊ก ลับ | คลิก ลับ | [play-secret-on-desktop.webp](img/play-secret-on-desktop.webp) 85 KB | [play-secret-on-mobile.webp](img/play-secret-on-mobile.webp) 30 KB |
| quota ลับหมด | gallery scenario `secret-used` | [play-secret-used-desktop.webp](img/play-secret-used-desktop.webp) 84 KB | [play-secret-used-mobile.webp](img/play-secret-used-mobile.webp) 30 KB |
| โหวต AI GM (👍/👎 + เหตุผล) | gallery scenario `vote` | [play-vote-desktop.webp](img/play-vote-desktop.webp) 84 KB | [play-vote-mobile.webp](img/play-vote-mobile.webp) 29 KB |
| socket หลุดแล้วต่อใหม่ | gallery scenario `reconnect` | [play-reconnect-desktop.webp](img/play-reconnect-desktop.webp) 83 KB | [play-reconnect-mobile.webp](img/play-reconnect-mobile.webp) 30 KB |
| เปลี่ยนช่วงเวลา / อากาศ | gallery scenario `period-change` | [play-period-change-desktop.webp](img/play-period-change-desktop.webp) 84 KB | [play-period-change-mobile.webp](img/play-period-change-mobile.webp) 30 KB |
| NPC พูดมาทีหลัง | gallery scenario `late-npc` | [play-late-npc-desktop.webp](img/play-late-npc-desktop.webp) 75 KB | [play-late-npc-mobile.webp](img/play-late-npc-mobile.webp) 27 KB |
| สีแชต (badge, โหวต, ผู้เล่นอื่น) | gallery scenario `chat-colours` | [play-chat-colours-desktop.webp](img/play-chat-colours-desktop.webp) 84 KB | [play-chat-colours-mobile.webp](img/play-chat-colours-mobile.webp) 29 KB |
| เล่นคนเดียว | gallery scenario `single` | [play-single-desktop.webp](img/play-single-desktop.webp) 83 KB | [play-single-mobile.webp](img/play-single-mobile.webp) 29 KB |
| โดนผลจากคนอื่น (hit pin) | gallery scenario `hit` | [play-hit-desktop.webp](img/play-hit-desktop.webp) 75 KB | [play-hit-mobile.webp](img/play-hit-mobile.webp) 28 KB |
| lock: หมดแรง | gallery scenario `exhausted` | [play-exhausted-desktop.webp](img/play-exhausted-desktop.webp) 81 KB | [play-exhausted-mobile.webp](img/play-exhausted-mobile.webp) 32 KB |
| lock: สลบ | gallery scenario `unconscious` | [play-unconscious-desktop.webp](img/play-unconscious-desktop.webp) 83 KB | [play-unconscious-mobile.webp](img/play-unconscious-mobile.webp) 32 KB |
| lock: กำลังสรุปผล + GM narrating | gallery scenario `resolving` | [play-resolving-desktop.webp](img/play-resolving-desktop.webp) 82 KB | [play-resolving-mobile.webp](img/play-resolving-mobile.webp) 31 KB |
| lock: เดินทางข้ามโซน | gallery scenario `traveling` | [play-traveling-desktop.webp](img/play-traveling-desktop.webp) 82 KB | [play-traveling-mobile.webp](img/play-traveling-mobile.webp) 31 KB |
| lock: พักฟื้น | gallery scenario `recovering` | [play-recovering-desktop.webp](img/play-recovering-desktop.webp) 82 KB | [play-recovering-mobile.webp](img/play-recovering-mobile.webp) 31 KB |
| Astral Spirit (ลางสังหรณ์) | gallery scenario `astral` | [play-astral-desktop.webp](img/play-astral-desktop.webp) 56 KB | [play-astral-mobile.webp](img/play-astral-mobile.webp) 27 KB |
| AI GM ติดขัด + ลองใหม่ | gallery scenario `stuck` | [play-stuck-desktop.webp](img/play-stuck-desktop.webp) 79 KB | [play-stuck-mobile.webp](img/play-stuck-mobile.webp) 29 KB |
| AI GM หยุดเพราะงบ | gallery scenario `budget-reached` | [play-budget-reached-desktop.webp](img/play-budget-reached-desktop.webp) 83 KB | [play-budget-reached-mobile.webp](img/play-budget-reached-mobile.webp) 33 KB |
| lock: เกมจบ | gallery scenario `ended` | [play-ended-desktop.webp](img/play-ended-desktop.webp) 81 KB | [play-ended-mobile.webp](img/play-ended-mobile.webp) 31 KB |
| เมนูเปิด | คลิก เมนู | [play-menu-open-desktop.webp](img/play-menu-open-desktop.webp) 58 KB | [play-menu-open-mobile.webp](img/play-menu-open-mobile.webp) 22 KB |
| ประวัติ (บันทึกเกม) | desktop: ประวัติ / มือถือ: เมนู → ประวัติ | [play-history-open-desktop.webp](img/play-history-open-desktop.webp) 76 KB | [play-history-open-mobile.webp](img/play-history-open-mobile.webp) 50 KB |
| แท็บ/แผ่น ตัวฉัน | คลิก ตัวฉัน | [play-tab-self-desktop.webp](img/play-tab-self-desktop.webp) 69 KB | [play-tab-self-mobile.webp](img/play-tab-self-mobile.webp) 16 KB |
| แท็บ/แผ่น กระเป๋า | คลิก กระเป๋า | [play-tab-bag-desktop.webp](img/play-tab-bag-desktop.webp) 62 KB | [play-tab-bag-mobile.webp](img/play-tab-bag-mobile.webp) 9 KB |
| แท็บ/แผ่น คนรอบตัว | คลิก คนรอบตัว | [play-tab-people-desktop.webp](img/play-tab-people-desktop.webp) 68 KB | [play-tab-people-mobile.webp](img/play-tab-people-mobile.webp) 16 KB |
| แผ่น ฉาก (มือถือเท่านั้น) | มือถือ: คลิก ฉาก | ไม่มี (สถานะนี้มีเฉพาะมือถือ) | [play-sheet-place-mobile.webp](img/play-sheet-place-mobile.webp) 41 KB |
| action อื่นๆ (มือถือเท่านั้น) | มือถือ: คลิก อื่นๆ | ไม่มี (สถานะนี้มีเฉพาะมือถือ) | [play-quick-more-mobile.webp](img/play-quick-more-mobile.webp) 27 KB |
| เลือกที่เดินทาง | desktop: สถานที่ → เดินทาง | [play-travel-desktop.webp](img/play-travel-desktop.webp) 70 KB | ไม่มีภาพ: มือถือ: ฉาก → เดินทาง แล้วภาพยังเป็นแผ่นฉากเดิม (ไม่เห็นหน้าเลือกที่) ควรตรวจในเครื่องจริงว่าเป็นบั๊กหรือแผ่นบังอยู่ |
| คุยกับ NPC | desktop: ปุ่ม คุยกับ … | [play-npc-chat-desktop.webp](img/play-npc-chat-desktop.webp) 64 KB | ไม่มีภาพ: มือถือ: ฉาก → คุย แล้วภาพยังเป็นแผ่นฉากเดิม (เหมือน เดินทาง) ควรตรวจในเครื่องจริง |
| Whisper (เลื่อนลงในแผงคนรอบตัว) | คนรอบตัว → Whisper | [play-whisper-desktop.webp](img/play-whisper-desktop.webp) 65 KB | [play-whisper-mobile.webp](img/play-whisper-mobile.webp) 15 KB |
| skeleton ตอนต่อ socket | ไม่มีภาพ: mock ตอบทุก request ใน 120 ms สถานะนี้แค่กะพริบ และไม่มี scenario ที่ค้างไว้ (ต้องเพิ่ม scenario ใน mock = แก้โค้ด) | — | — |
| fatal (ห้องปิด / session หลุด) | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |
| เดินทางล้ม / quota คุย NPC หมด / คุยล้ม | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

## จบ


### สรุปเกม + ให้คะแนน (`ending`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| เปิดความลับ + ฟอร์มคะแนน | gallery scenario `ended` | [ending-ended-desktop.webp](img/ending-ended-desktop.webp) 30 KB | [ending-ended-mobile.webp](img/ending-ended-mobile.webp) 25 KB |
| ความลับหลายวัน (ตัวกรองวัน) | gallery scenario `ended-days` | [ending-ended-days-desktop.webp](img/ending-ended-days-desktop.webp) 31 KB | [ending-ended-days-mobile.webp](img/ending-ended-days-mobile.webp) 24 KB |
| โหวต 👎 การตัดสิน | gallery scenario `ended-down` | [ending-ended-down-desktop.webp](img/ending-ended-down-desktop.webp) 30 KB | [ending-ended-down-mobile.webp](img/ending-ended-down-mobile.webp) 24 KB |
| มุม Human GM (ไม่มีปุ่มโหวต) | gallery scenario `ended-gm` | [ending-ended-gm-desktop.webp](img/ending-ended-gm-desktop.webp) 29 KB | [ending-ended-gm-mobile.webp](img/ending-ended-gm-mobile.webp) 24 KB |
| สกัดความรู้ไม่สำเร็จ + ลองใหม่ | gallery scenario `ended-learning-failed` | [ending-ended-learning-failed-desktop.webp](img/ending-ended-learning-failed-desktop.webp) 30 KB | [ending-ended-learning-failed-mobile.webp](img/ending-ended-learning-failed-mobile.webp) 25 KB |
| บันทึกเกมที่ยังไม่จบ | gallery scenario `normal` | [ending-normal-desktop.webp](img/ending-normal-desktop.webp) 55 KB | [ending-normal-mobile.webp](img/ending-normal-mobile.webp) 40 KB |
| บันทึกเกมที่ยังไม่จบ (ผ่านรายการเกม) | `/?scenario=normal` → รายการเกม → ดูสรุป | [ending-log-not-ended-desktop.webp](img/ending-log-not-ended-desktop.webp) 49 KB | [ending-log-not-ended-mobile.webp](img/ending-log-not-ended-mobile.webp) 32 KB |
| ส่วนให้คะแนน ยังไม่ส่ง | gallery scenario `ended` | [ending-rating-ended-desktop.webp](img/ending-rating-ended-desktop.webp) 20 KB | [ending-rating-ended-mobile.webp](img/ending-rating-ended-mobile.webp) 19 KB |
| ให้คะแนนแล้ว ผ่านเกณฑ์ | gallery scenario `ended-rated` | [ending-rating-ended-rated-desktop.webp](img/ending-rating-ended-rated-desktop.webp) 22 KB | [ending-rating-ended-rated-mobile.webp](img/ending-rating-ended-rated-mobile.webp) 20 KB |
| คะแนนไม่ผ่านเกณฑ์ | gallery scenario `ended-low` | [ending-rating-ended-low-desktop.webp](img/ending-rating-ended-low-desktop.webp) 23 KB | [ending-rating-ended-low-mobile.webp](img/ending-rating-ended-low-mobile.webp) 21 KB |
| ส่วนให้คะแนน + โหวต 👎 | gallery scenario `ended-down` | [ending-rating-ended-down-desktop.webp](img/ending-rating-ended-down-desktop.webp) 23 KB | [ending-rating-ended-down-mobile.webp](img/ending-rating-ended-down-mobile.webp) 20 KB |
| ส่วนให้คะแนน มุม GM | gallery scenario `ended-gm` | [ending-rating-ended-gm-desktop.webp](img/ending-rating-ended-gm-desktop.webp) 22 KB | [ending-rating-ended-gm-mobile.webp](img/ending-rating-ended-gm-mobile.webp) 20 KB |
| ส่วนให้คะแนน เกม normal | gallery scenario `normal` | [ending-rating-normal-desktop.webp](img/ending-rating-normal-desktop.webp) 55 KB | [ending-rating-normal-mobile.webp](img/ending-rating-normal-mobile.webp) 40 KB |
| กดส่งโดยไม่เลือกคะแนน | ended → ส่งคะแนน | [ending-rating-pick-error-desktop.webp](img/ending-rating-pick-error-desktop.webp) 21 KB | [ending-rating-pick-error-mobile.webp](img/ending-rating-pick-error-mobile.webp) 19 KB |
| ส่งคะแนนแล้ว / แก้คะแนน | ไม่มีภาพ: ต้องเลือกคะแนนในฟอร์มก่อนส่ง รอบนี้ไม่ได้ทำภาพ (ทำได้ใน mock) | — | — |
| โหลดคะแนน / สรุปไม่ได้ | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

## GM


### GM console (`gm-console`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| เทิร์นรออนุมัติ | gallery scenario `gm` | [gm-console-gm-desktop.webp](img/gm-console-gm-desktop.webp) 61 KB | [gm-console-gm-mobile.webp](img/gm-console-gm-mobile.webp) 34 KB |
| ฉากจบรออนุมัติ | gallery scenario `gm-finale` | [gm-console-gm-finale-desktop.webp](img/gm-console-gm-finale-desktop.webp) 58 KB | [gm-console-gm-finale-mobile.webp](img/gm-console-gm-finale-mobile.webp) 33 KB |
| ถึงเพดานงบ AI | gallery scenario `gm-budget` | [gm-console-gm-budget-desktop.webp](img/gm-console-gm-budget-desktop.webp) 55 KB | [gm-console-gm-budget-mobile.webp](img/gm-console-gm-budget-mobile.webp) 30 KB |
| เปิดด้วย session ผู้เล่น | gallery scenario `normal` | [gm-console-normal-desktop.webp](img/gm-console-normal-desktop.webp) 62 KB | [gm-console-normal-mobile.webp](img/gm-console-normal-mobile.webp) 32 KB |
| ฟอร์มปรับค่า / แทรกเหตุการณ์ error | ไม่มีภาพ: กด ปรับค่า ตอนช่องว่างแล้วภาพไม่เปลี่ยน (ไม่ยืนยันว่ามี error แสดง) ส่วนฟอร์มเห็นได้ในภาพ gm-console-gm ด้านล่าง | — | — |
| โหลดอยู่ / โหลดไม่ได้ | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### Scenario editor (`scenario-editor`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| อ่านอย่างเดียว แท็บเหตุการณ์ 12 วัน | gallery scenario `gm` | [scenario-editor-gm-desktop.webp](img/scenario-editor-gm-desktop.webp) 18 KB | [scenario-editor-gm-mobile.webp](img/scenario-editor-gm-mobile.webp) 17 KB |
| เปิดด้วย session ผู้เล่น | gallery scenario `normal` | [scenario-editor-normal-desktop.webp](img/scenario-editor-normal-desktop.webp) 18 KB | [scenario-editor-normal-mobile.webp](img/scenario-editor-normal-mobile.webp) 17 KB |
| แท็บ NPC | คลิก NPC | [scenario-editor-tab-npc-desktop.webp](img/scenario-editor-tab-npc-desktop.webp) 17 KB | [scenario-editor-tab-npc-mobile.webp](img/scenario-editor-tab-npc-mobile.webp) 17 KB |
| แท็บ ตำนานลับ | คลิก ตำนานลับ | [scenario-editor-tab-lore-desktop.webp](img/scenario-editor-tab-lore-desktop.webp) 20 KB | [scenario-editor-tab-lore-mobile.webp](img/scenario-editor-tab-lore-mobile.webp) 19 KB |
| แก้ได้ / validation error / บันทึก / reset | ไม่มีภาพ: fixture ทุกตัว canEditScenario: false | — | — |

### ห้องเล่นมุม GM (`play-gm`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| gallery frame ห้องเล่น session GM | gallery scenario `gm` | [play-gm-desktop.webp](img/play-gm-desktop.webp) 66 KB | [play-gm-mobile.webp](img/play-gm-mobile.webp) 38 KB |
| แอปจริงใน mock: GM เข้าห้องเล่น | `/?scenario=gm` → เข้าห้องเล่น | [play-gm-view-desktop.webp](img/play-gm-view-desktop.webp) 68 KB | [play-gm-view-mobile.webp](img/play-gm-view-mobile.webp) 39 KB |

## admin


### admin: เข้าสู่ระบบ (`admin-login`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| ฟอร์ม admin code | `/admin?scenario=normal` ไม่มี token | [admin-login-desktop.webp](img/admin-login-desktop.webp) 9 KB | [admin-login-mobile.webp](img/admin-login-mobile.webp) 8 KB |
| ส่งช่องว่าง | คลิก เข้า dashboard | [admin-login-error-desktop.webp](img/admin-login-error-desktop.webp) 11 KB | [admin-login-error-mobile.webp](img/admin-login-error-mobile.webp) 9 KB |
| gallery frame ai-usage (ยังไม่มี token = หน้า login) | gallery scenario `normal` | [admin-usage-normal-desktop.webp](img/admin-usage-normal-desktop.webp) 9 KB | [admin-usage-normal-mobile.webp](img/admin-usage-normal-mobile.webp) 8 KB |
| forbidden (token หมดอายุ) | ไม่มีภาพ: mock ไม่เคยตอบ 403 | — | — |

### admin: การใช้ AI (`admin-usage`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| ภาพรวมทุกเกม | sessionStorage token สมมติ | [admin-usage-desktop.webp](img/admin-usage-desktop.webp) 26 KB | [admin-usage-mobile.webp](img/admin-usage-mobile.webp) 19 KB |
| รายละเอียดเกม | คลิกชื่อเกม | [admin-usage-game-detail-desktop.webp](img/admin-usage-game-detail-desktop.webp) 31 KB | [admin-usage-game-detail-mobile.webp](img/admin-usage-game-detail-mobile.webp) 16 KB |
| ยังไม่มีการเรียก AI / poll error | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### admin: Learning library (`admin-library`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| รายการความรู้ (ในหน้า admin) | คลิก Learning library | [admin-library-entries-desktop.webp](img/admin-library-entries-desktop.webp) 45 KB | [admin-library-entries-mobile.webp](img/admin-library-entries-mobile.webp) 24 KB |
| gallery frame ปกติ | gallery scenario `normal` | [admin-library-normal-desktop.webp](img/admin-library-normal-desktop.webp) 38 KB | [admin-library-normal-mobile.webp](img/admin-library-normal-mobile.webp) 22 KB |
| ว่าง | gallery scenario `library-empty` | [admin-library-library-empty-desktop.webp](img/admin-library-library-empty-desktop.webp) 11 KB | [admin-library-library-empty-mobile.webp](img/admin-library-library-empty-mobile.webp) 7 KB |
| กำลังโหลด | gallery scenario `library-loading` | [admin-library-library-loading-desktop.webp](img/admin-library-library-loading-desktop.webp) 4 KB | [admin-library-library-loading-mobile.webp](img/admin-library-library-loading-mobile.webp) 2 KB |
| โหลดไม่ได้ | gallery scenario `library-error` | [admin-library-library-error-desktop.webp](img/admin-library-library-error-desktop.webp) 6 KB | [admin-library-library-error-mobile.webp](img/admin-library-library-error-mobile.webp) 5 KB |
| ยืนยันลบรายการ (modal) | คลิก ลบ | [admin-library-confirm-entry-desktop.webp](img/admin-library-confirm-entry-desktop.webp) 21 KB | [admin-library-confirm-entry-mobile.webp](img/admin-library-confirm-entry-mobile.webp) 13 KB |
| ยืนยันลบทั้งเกม (modal) | คลิก ลบทั้งเกมนี้ | [admin-library-confirm-game-desktop.webp](img/admin-library-confirm-game-desktop.webp) 23 KB | [admin-library-confirm-game-mobile.webp](img/admin-library-confirm-game-mobile.webp) 15 KB |
| ลบไม่สำเร็จ | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### admin: คลังบทพูด NPC (`admin-library-npc`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| รายการ | คลิก คลังบทพูดต่อ NPC | [admin-library-npc-desktop.webp](img/admin-library-npc-desktop.webp) 30 KB | [admin-library-npc-mobile.webp](img/admin-library-npc-mobile.webp) 21 KB |
| ยืนยันลบ (modal) | คลิก ลบ | [admin-library-npc-confirm-desktop.webp](img/admin-library-npc-confirm-desktop.webp) 17 KB | [admin-library-npc-confirm-mobile.webp](img/admin-library-npc-confirm-mobile.webp) 13 KB |
| โหลดอยู่ / ว่าง / โหลดไม่ได้ | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### admin: ข้อมูลเกม (`admin-data`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| รายการชุดข้อมูล | คลิก ข้อมูลเกม | [admin-data-desktop.webp](img/admin-data-desktop.webp) 24 KB | [admin-data-mobile.webp](img/admin-data-mobile.webp) 19 KB |
| gallery frame | gallery scenario `normal` | [admin-data-normal-desktop.webp](img/admin-data-normal-desktop.webp) 16 KB | [admin-data-normal-mobile.webp](img/admin-data-normal-mobile.webp) 14 KB |
| ฟอร์มแก้ชุดข้อมูล | คลิกชุดข้อมูล | [admin-data-editor-desktop.webp](img/admin-data-editor-desktop.webp) 31 KB | [admin-data-editor-mobile.webp](img/admin-data-editor-mobile.webp) 24 KB |
| แก้เป็น JSON ดิบ | คลิก แก้เป็น JSON ดิบ | [admin-data-raw-json-desktop.webp](img/admin-data-raw-json-desktop.webp) 16 KB | [admin-data-raw-json-mobile.webp](img/admin-data-raw-json-mobile.webp) 12 KB |
| นำเข้าจากไฟล์ (preview) | ไม่มีภาพ: ต้องเลือกไฟล์ในเครื่องผ่าน file picker ทำใน headless ไม่ได้โดยไม่แก้โค้ด | — | — |
| fallback alert / error | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### admin: ข้อความที่ถูก 👎 (`admin-votes`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| รายการข้อความ 👎 | คลิก ข้อความที่ถูก 👎 | [admin-votes-desktop.webp](img/admin-votes-desktop.webp) 30 KB | [admin-votes-mobile.webp](img/admin-votes-mobile.webp) 24 KB |
| gallery frame VoteReview | gallery scenario `normal` | [admin-votes-normal-desktop.webp](img/admin-votes-normal-desktop.webp) 21 KB | [admin-votes-normal-mobile.webp](img/admin-votes-normal-mobile.webp) 20 KB |
| ฟอร์มแก้เป็น | คลิก แก้เป็น | [admin-votes-edit-desktop.webp](img/admin-votes-edit-desktop.webp) 37 KB | [admin-votes-edit-mobile.webp](img/admin-votes-edit-mobile.webp) 27 KB |
| StylePanel (ตั้งค่า + ธงสำนวน) | เลื่อนลง | [admin-votes-style-panel-desktop.webp](img/admin-votes-style-panel-desktop.webp) 36 KB | [admin-votes-style-panel-mobile.webp](img/admin-votes-style-panel-mobile.webp) 27 KB |
| StyleEval (เทียบรอบ) | เลื่อนไปที่ ดีขึ้น/เท่าเดิม/แย่ลง | [admin-votes-style-eval-desktop.webp](img/admin-votes-style-eval-desktop.webp) 36 KB | [admin-votes-style-eval-mobile.webp](img/admin-votes-style-eval-mobile.webp) 23 KB |
| ว่าง / โหลดไม่ได้ / ยังไม่มีรอบ eval | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### admin: ทบทวนสำนวน (`admin-style`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| ข้อเสนอที่รออนุมัติ | คลิก ทบทวนสำนวน | [admin-style-review-desktop.webp](img/admin-style-review-desktop.webp) 23 KB | [admin-style-review-mobile.webp](img/admin-style-review-mobile.webp) 19 KB |
| กำลังรัน / ว่าง / error / JSON ผิด | ไม่มีภาพ: ไม่มี scenario / fixture ที่ให้ผลนี้ใน mock (ต้องเพิ่ม scenario = แก้โค้ด) | — | — |

### dev: gallery / chat colours (`dev`)

| สถานะ | ได้มาอย่างไร | desktop 1366×768 | มือถือ 390×844 |
|---|---|---|---|
| หน้ารวม gallery | `/dev/gallery` | [dev-gallery-index-desktop.webp](img/dev-gallery-index-desktop.webp) 91 KB | [dev-gallery-index-mobile.webp](img/dev-gallery-index-mobile.webp) 44 KB |
| ตารางสีแชต | `/dev/chat-colours` | [dev-chat-colours-desktop.webp](img/dev-chat-colours-desktop.webp) 30 KB | [dev-chat-colours-mobile.webp](img/dev-chat-colours-mobile.webp) 26 KB |
