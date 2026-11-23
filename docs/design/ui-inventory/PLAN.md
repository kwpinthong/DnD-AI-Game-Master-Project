# แผนออกแบบ UI ใหม่ทุกหน้า (ISK-004)

สรุปช่องว่างจาก [inventory ISK-003](README.md) (ภาพที่ `develop` 71d86d2) เทียบกับ UI v3 ([`docs/design/ui-v3-chat/README.md`](../ui-v3-chat/README.md) + [`apps/web/src/tokens.css`](../../../apps/web/src/tokens.css)) แล้วจัดเป็นชุดออกแบบ บอกขนาด และเสนอ 3 แผนลำดับให้ Nok เลือก
**สถานะ: รอ Nok เลือกแผน** (Questions row ของ ISK-004) / งานนี้ไม่มี mockup ใหม่ (batch ถัดไป) และไม่แก้โค้ด

บอร์ดสรุปใน canvas: `UI_Plan_ISK004` (แถวใต้บอร์ด ui-inventory 1–5) บน [Layout ใหม่ทั้งเว็บ](https://claude.ai/artifact/CDnwSr2hTFpaTKKPfWVE3U)

## สรุปสั้น

- **สีผ่านแล้วทุกหน้า:** ไฟล์ `.tsx` / `.css` ใน `apps/web/src` ไม่มีสี hex เขียนตรงเลย ทุกหน้าใช้ token อยู่แล้ว ช่องว่างจริงคือ **layout, component และ asset ของ v3** ไม่ใช่สี
- **มีหน้าเดียวที่หน้าตาเป็น v3 เต็มตัว คือห้องเล่น (Play):** มีกรอบภาพวาด (`frames/*`), พื้นดาว (`texture-stars`), avatar-ring, ไอคอน, หัวข้อ Trirong ส่วนหน้าที่ inventory นับเป็น "UI v3" อื่นๆ ใช้แค่ component ใน `ui/` (Panel / Button / Field) ยังไม่มี asset ภาพวาดเลย คนเล่นจะรู้สึกเหมือนเปลี่ยนเว็บเมื่อเข้าห้องเล่น
- **หน้าเก่า 8 หน้า:** หน้าแรก, รายการเกม, Scenario editor, admin login, admin การใช้ AI (+ แถบแท็บ admin), ข้อมูลเกม, StylePanel/StyleEval, ทบทวนสำนวน
- **สถานะที่ไม่มีภาพ 32 แถว:** เกือบทั้งหมดเพราะ mock ไม่มี scenario (loading ค้าง / error) จุดบอดใหญ่สุดคือ **สร้างตัวละครขั้นของติดตัวจาก AI ถึงขั้น 3 ตรวจทาน** (ยังไม่มีใครเห็นภาพของ 6 สถานะ) ทุกแผนจึงต้องเริ่มแต่ละชุดด้วยการเพิ่ม mock scenario (เป็นงาน Code) ก่อนออกแบบ
- **ของใหม่หลัง inventory (ใน `develop` 678531c แต่ไม่มีภาพ):** หน้า สไตล์ของฉัน (`MyStyle.tsx`, GEN-200), ติ๊ก "ไม่ต้องเก็บสไตล์ของฉัน" ในฟอร์มสร้างเกม (GEN-201), สวิตช์อนุมัติบทพูด NPC อัตโนมัติใน GM console (GEN-198), ฟอร์ม Voice ในข้อมูลเกม (`VoiceForm.tsx`, GEN-192), ตารางคำตอบ AI ที่ถูกตีกลับในการใช้ AI (GEN-199), ตัวนับ 200 ตัวในช่องพิมพ์ action (ISK-012)

## นิยามขนาด

| ขนาด | ความหมาย |
|---|---|
| S | ปรับสี / spacing ตาม token (+ ใส่ asset v3 ที่มีอยู่ เช่น กรอบ / ornament) ไม่เปลี่ยน layout |
| M | จัด layout ใหม่ โดยใช้ component เดิมใน `apps/web/src/ui` หรือ `play/chat` |
| L | ต้องมี component ใหม่ หรือ flow ใหม่ |

## 1. ตาราง gap (หน้าเดิม)

คอลัมน์ "ไม่สอดคล้อง v3" = สิ่งที่เห็นในภาพเทียบกับ v3 / "สถานะที่ขาด" = แถวที่ไม่มีภาพใน inventory (+ ของใหม่หลัง inventory)

| # | ชุด | หน้า (component) | ภาพ | v3 / เก่า | ไม่สอดคล้อง v3 | สถานะที่ขาด | ขนาด |
|---|---|---|---|---|---|---|---|
| 1 | เข้าเกม | หน้าแรก (`App.tsx`) | [guest](img/home-guest-desktop.webp) · [normal](img/home-normal-desktop.webp) · [lobby](img/home-lobby-desktop.webp) · [มือถือ](img/home-normal-mobile.webp) | เก่า | หัว h1 + ข้อความ dev "Server: ต่อได้ (database connected)" โชว์ให้ผู้เล่น, ปุ่ม รายการเกม / ออกจากเกม เรียงซ้ายไม่มีแถบนำทาง, ไม่ใช้ `home-keyart.webp` (v3 README: หน้าแรกเป็นภาพเต็มหน้า), ห้องรอวางลอยกลางจอใต้ปุ่ม | checking / restoring, server ต่อไม่ได้ | **L** (header / app shell + hero keyart ใหม่; ทิศทางหน้าแรก A/B/C บน canvas ยังไม่ได้เลือก) |
| 2 | เข้าเกม | เข้าร่วมเกม (`JoinForm.tsx`) | [guest](img/join-guest-desktop.webp) · [มือถือ](img/join-guest-mobile.webp) | v3 | Panel ธรรมดา ไม่มีกรอบ / ornament / พื้นภาพ | field error, กำลังเข้าร่วม, server error | S |
| 3 | เข้าเกม | สร้างเกม (`CreateGameForm.tsx` + TonePicker + NpcDialoguePicker) | [guest](img/create-game-guest-desktop.webp) · [single](img/create-game-single-desktop.webp) | v3 (บางส่วน) | TonePicker / NpcDialoguePicker เป็น radio ธรรมดาใน fieldset (ไม่ใช่การ์ดตัวเลือก), ฟอร์มยาว 1800+ px ไม่แบ่งส่วน | field error, ดูเกมที่ใช้ได้ / เปิดความทรงจำ, ไม่มีเกมให้ใช้, โหลดความทรงจำไม่ได้, server error, **ติ๊กไม่เก็บสไตล์ (GEN-201, ใหม่)** | M |
| 4 | เข้าเกม | รายการเกม (`GameHistory.tsx`) | [open](img/home-history-open-desktop.webp) · [empty](img/home-history-empty-desktop.webp) | เก่า | รายการเป็น `<li>` ข้อความยาวบรรทัดเดียว + ปุ่ม ดูสรุป, ฝังอยู่ในหน้าแรกเหนือห้องรอ, ไม่มีการ์ดเกม / ป้ายสถานะ | โหลดอยู่, เกมหนึ่งติดต่อไม่ได้ | M |
| 5 | เข้าเกม | ห้องรอ (`Lobby.tsx`) | [lobby](img/lobby-lobby-desktop.webp) · [no-character](img/lobby-no-character-desktop.webp) · [normal](img/lobby-normal-desktop.webp) · [confirm-delete](img/lobby-confirm-delete-desktop.webp) | v3 | ค่าที่ล็อกแล้ว (บทพูด NPC / โทน) ยังแสดงเป็น radio ทั้งชุด, ปุ่ม รีเฟรช / ลบเกม ซ้อนกันไม่มีระยะ, รายชื่อผู้เล่นไม่มี avatar | toast คัดลอกโค้ด, skeleton, โหลดไม่ได้, action error | M |
| 6 | เข้าเกม | สร้างตัวละคร (`CharacterScreen.tsx` + `LootStep.tsx`) | [ขั้น 1](img/character-no-character-desktop.webp) · [ล็อก](img/character-normal-desktop.webp) · [loot](img/character-loot-loading-desktop.webp) · [analysing](img/character-loot-analysing-desktop.webp) · [error-retry](img/character-loot-error-retry-desktop.webp) · [summary มือถือ](img/character-summary-open-mobile.webp) | v3 | ลักษณะภายนอกเป็น textarea ว่าง (ISK-007 จะเปลี่ยนเป็น avatar + ชิป), ปุ่มถัดไปเป็นกรอบเส้นประ, แผงสรุปขวาเป็นข้อความ "-" | **ข้อเสนอของติดตัวจาก AI, เลือกแล้ว, validation ของติดตัว, ขั้น 3 ตรวจทาน**, ต้องเลือกใหม่, โหลดไม่ได้ | M (ส่วน L อยู่ในแถว ISK-007 ด้านล่าง) |
| 7 | เข้าเกม | การ์ดจุดเกิด (`OriginCard.tsx`) | [normal](img/origin-card-normal-desktop.webp) · [rare](img/origin-card-origin-rare-desktop.webp) | v3 | การ์ดสีครีม (`--card-bg`) เข้ากับ v3 แล้ว ขาดแค่กรอบ / ornament | โหลดอยู่ | S |
| 8 | เข้าเกม | สไตล์ของฉัน (`MyStyle.tsx`, GEN-200) | ไม่มีภาพ (merge หลัง inventory) | v3 (ใช้ Panel / Field / Button / EmptyState) | ยังไม่ได้ดู ต้องถ่ายภาพก่อน | ทุกสถานะ | S |
| 9 | ในเกม | ห้องเล่น Play (`PlayRoom.tsx` + `play/chat/*`) | [normal](img/play-normal-desktop.webp) · [vote](img/play-vote-desktop.webp) · [stuck](img/play-stuck-desktop.webp) · [มือถือ](img/play-normal-mobile.webp) · [sheet-place](img/play-sheet-place-mobile.webp) (ภาพอื่นทุกสถานะอยู่ใน README) | v3 (ต้นแบบ) | ตรง v3 เกือบทั้งหมด / ชิปเหตุผลโหวต 👎 เป็นปุ่มกรอบใหญ่กลาง feed, บรรทัดสถานะใต้ช่องพิมพ์เป็นข้อความเปล่า / **มือถือ: กด เดินทาง / คุย ในแผ่นฉากแล้วภาพไม่เปลี่ยน** (inventory สงสัยว่าเป็นบั๊ก ต้องตรวจในเครื่องจริง) | skeleton ต่อ socket, fatal, เดินทางล้ม, quota คุย NPC หมด, คุยล้ม, เลือกที่เดินทาง + คุย NPC บนมือถือ, **ตัวนับ 200 ตัว (ISK-012, ใหม่)** | M |
| 10 | GM | ห้องเล่นมุม GM (`PlayRoom.tsx` + `GmConsole.tsx`) | [play-gm](img/play-gm-desktop.webp) · [view](img/play-gm-view-desktop.webp) | v3 | ตาม Play | — | S |
| 11 | จบเกม | สรุปเกม + ให้คะแนน (`Ending.tsx`, GameSummaryPage, GameLog) | [ended](img/ending-ended-desktop.webp) · [days](img/ending-ended-days-desktop.webp) · [rating](img/ending-rating-ended-desktop.webp) · [log-not-ended](img/ending-log-not-ended-desktop.webp) | v3 | ไม่มีพื้นดาว / กรอบ / ornament ของ v3 (ฉากจบควรเป็นจุดพีค), ป้าย "ยังไม่มีคะแนน" หน้าตาเหมือนปุ่ม, "ดู log เต็ม" เป็นลิงก์เปล่า | ส่งคะแนนแล้ว, แก้คะแนน, โหลดคะแนน, สรุปไม่ได้ | S |
| 12 | GM | GM console (`GmConsole.tsx`) | [gm](img/gm-console-gm-desktop.webp) · [finale](img/gm-console-gm-finale-desktop.webp) · [budget](img/gm-console-gm-budget-desktop.webp) · [มือถือ](img/gm-console-gm-mobile.webp) | v3 (บางส่วน) | แผงเป็น markup ของตัวเอง ไม่ใช่ Panel, ฟอร์มปรับค่า + แทรกเหตุการณ์เปิดค้างตลอด, มือถือยาว 3100 px | ฟอร์ม error, โหลดอยู่, โหลดไม่ได้, **สวิตช์อนุมัติบทพูดอัตโนมัติ (GEN-198, ใหม่)** | M |
| 13 | GM | Scenario editor (`ScenarioEditor.tsx`) | [gm](img/scenario-editor-gm-desktop.webp) · [tab-npc](img/scenario-editor-tab-npc-desktop.webp) · [tab-lore](img/scenario-editor-tab-lore-desktop.webp) | เก่า | fieldset / input / select ดิบ ไม่ใช้ Field, แท็บเป็นปุ่มเรียงกัน, ฟอร์มชิดซ้ายเต็มจอ, ยาวถึง 6000 px | แก้ได้, validation error, บันทึก, reset (fixture ทุกตัว canEditScenario: false) | M |
| 14 | admin | admin: เข้าสู่ระบบ (`AdminDashboard.tsx` AdminLogin) | [login](img/admin-login-desktop.webp) · [error](img/admin-login-error-desktop.webp) | เก่า | ฟอร์มเปล่าชิดซ้ายบน ไม่มี Panel | forbidden (token หมดอายุ) | M |
| 15 | admin | admin: แถบแท็บ + การใช้ AI (`AdminDashboard.tsx` Dashboard) | [usage](img/admin-usage-desktop.webp) · [game-detail](img/admin-usage-game-detail-desktop.webp) · [มือถือ](img/admin-usage-mobile.webp) | เก่า | แท็บเป็นปุ่มกรอบเรียงกัน + "ออกจาก dashboard" อยู่ใต้เส้น, ตาราง `<table>` ดิบ ไม่มีแบบการ์ดบนมือถือ | ยังไม่มีการเรียก AI, poll error, **ตาราง AI ตอบที่ถูกตีกลับ (GEN-199, ใหม่)** | L (admin shell + ตาราง / การ์ดแบบ responsive ใช้ร่วมกับแท็บเกมของ ISK-002) |
| 16 | admin | admin: Learning library (`LearningLibrary.tsx`) | [entries](img/admin-library-entries-desktop.webp) · [empty](img/admin-library-library-empty-desktop.webp) · [confirm](img/admin-library-confirm-entry-desktop.webp) | v3 | ใช้ Skeleton / ErrorState / EmptyState / ConfirmDialog แล้ว ขาดแค่ให้เข้ากับ admin shell ใหม่ | ลบไม่สำเร็จ | S |
| 17 | admin | admin: คลังบทพูด NPC (`NpcLibrary.tsx`) | [list](img/admin-library-npc-desktop.webp) · [confirm](img/admin-library-npc-confirm-desktop.webp) | v3 | เหมือนแถว 16 | โหลดอยู่, ว่าง, โหลดไม่ได้ | S |
| 18 | admin | admin: ข้อมูลเกม (`GameDataEditor.tsx` + `GameDataForm.tsx` + `VoiceForm.tsx`) | [list](img/admin-data-desktop.webp) · [editor](img/admin-data-editor-desktop.webp) · [raw-json](img/admin-data-raw-json-desktop.webp) | เก่า | ฟอร์มดิบไม่ใช้ Field / Panel, JSON ดิบยาว 2000 px | นำเข้าจากไฟล์ (preview), fallback alert, error, **ฟอร์ม Voice (GEN-192, ใหม่)** | M |
| 19 | admin | admin: ข้อความที่ถูก 👎 (`VoteReview.tsx` + `StylePanel.tsx` + `StyleEval.tsx`) | [list](img/admin-votes-desktop.webp) · [edit](img/admin-votes-edit-desktop.webp) · [style-panel](img/admin-votes-style-panel-desktop.webp) · [style-eval](img/admin-votes-style-eval-desktop.webp) | v3 (VoteReview) / เก่า (Style*) | สามส่วนหน้าตาไม่เหมือนกันในแท็บเดียว | ว่าง, โหลดไม่ได้, ยังไม่มีรอบ eval | M |
| 20 | admin | admin: ทบทวนสำนวน (`StyleReview.tsx`) | [review](img/admin-style-review-desktop.webp) | เก่า | รายการข้อเสนอเป็น markup ดิบ ยาว 2300 px | กำลังรัน, ว่าง, error, JSON ผิด | M |
| 21 | admin | dev: gallery / chat colours (`dev/*`) | [gallery](img/dev-gallery-index-desktop.webp) · [chat-colours](img/dev-chat-colours-desktop.webp) | เครื่องมือ dev | ไม่อยู่ใน production bundle ไม่ต้องออกแบบใหม่ ใส่หน้าใหม่ตามที่แต่ละ task เพิ่ม | — | S (เฉพาะเพิ่ม screen ใหม่) |

## 2. หน้าที่จะมา (ยังไม่ merge, Q-385 A: เติมภาพเมื่อ merge)

ข้อความจาก Requirement ของแถว Tasks

| # | ชุด | มาจาก | หน้า / ส่วน | Requirement (ย่อ) | ภาพ | ขนาด |
|---|---|---|---|---|---|---|
| N1 | admin | ISK-002 | แท็บ เกม + กล่องปิดเกม (`AdminDashboard.tsx`, `admin-api.ts`) | ตาราง ชื่อ / สถานะเป็นคำ (รอเริ่ม, กำลังเตรียมตัว, กำลังเล่น, จบแล้ว, ปิดโดยผู้ดูแล) / วันในเกม / ผู้เล่น / เล่นล่าสุด / ค่า AI, ปุ่ม [ปิดเกม] เฉพาะยังไม่จบ; กล่องยืนยันพิมพ์ชื่อเกม (trim + NFC) เหตุผล x/200 spinner ส่งครั้งเดียว 401 → หน้าใส่รหัส; 390 px ตารางเป็นการ์ด | coming | L (ตาราง → การ์ด ใช้ร่วมกับแถว 15) |
| N2 | ในเกม | ISK-002 | modal "เกมถูกปิดโดยผู้ดูแล" ทุกหน้าในเกม (Lobby, สร้างตัวละคร, Loot, จุดเกิด, Play) | ได้ `game_closed` หรือโหลดหน้าแล้วเกม closed → modal ปิดไม่ได้ + เหตุผล (ไม่มี = ไม่มีบรรทัด) ปุ่ม [ไปหน้าสรุป] (hasSummary) หรือ [กลับหน้าแรก] | coming | M (ต่อจาก ConfirmDialog) |
| N3 | จบเกม | ISK-002 | ป้าย "ปิดก่อนกำหนด" ในหน้าจบเกม + "ปิดโดยผู้ดูแล" ในรายการเกม | หน้าจบ closedEarly: ป้าย + เหตุผลแทนบล็อกฉากจบ (ไม่มีบล็อกว่าง), หน้าประวัติแสดง ปิดโดยผู้ดูแล | coming | S |
| N4 | เข้าเกม | ISK-007 | เลือก avatar + ชิปลักษณะ (`CharacterScreen.tsx`) | grid 12 avatar จาก `avatar-presets.json` ในกรอบ avatar-ring player, เลือกแล้วเติมชิป 6 หมวด (aria-pressed) + extra ≤ 80 ตัว, preview ประโยคสด, [สุ่ม], แจ้งหมวดที่ขาด, draft ใน sessionStorage, ใช้แป้นพิมพ์ได้, 390 px avatar 4 คอลัมน์ | coming | L |
| N5 | ในเกม | ISK-007 | avatar ในแชต / HUD / Lobby | แสดง avatar ของเรา + คนอื่น (ทุกคนเห็น) ไม่มี avatarId หรือภาพเสีย = ตัวอักษรแรก | coming | M (ใช้ avatar-ring เดิม) |

## 3. ชุดออกแบบ

ทุกหน้าอยู่ใน 1 ชุดพอดี (แถว 1–21 + N1–N5)

| ชุด | หน้า | S | M | L | ภาพบนบอร์ด canvas |
|---|---|---|---|---|---|
| เข้าเกม | 1 หน้าแรก, 2 เข้าร่วม, 3 สร้างเกม, 4 รายการเกม, 5 ห้องรอ, 6 สร้างตัวละคร, 7 จุดเกิด, 8 สไตล์ของฉัน, N4 avatar + ชิป | 3 | 4 | 2 | ui-inventory 1 |
| ในเกม | 9 ห้องเล่น, N2 modal เกมถูกปิด, N5 avatar ในแชต | 0 | 3 | 0 | ui-inventory 2 |
| จบเกม | 11 สรุปเกม + คะแนน, N3 ป้ายปิดก่อนกำหนด | 2 | 0 | 0 | ui-inventory 3 |
| GM | 10 ห้องเล่นมุม GM, 12 GM console, 13 Scenario editor | 1 | 2 | 0 | ui-inventory 4 |
| admin | 14 login, 15 shell + การใช้ AI, 16 Learning library, 17 คลัง NPC, 18 ข้อมูลเกม, 19 ข้อความ 👎, 20 ทบทวนสำนวน, 21 dev, N1 แท็บเกม | 3 | 4 | 2 | ui-inventory 5 |
| **รวม 26** | | **9** | **13** | **4** | |

component ใหม่ที่ L ต้องใช้ (ยังไม่มีใน `apps/web/src/ui`): app shell / header ที่มีแถบนำทาง + hero keyart (แถว 1), ตาราง → การ์ดแบบ responsive + แถบแท็บ admin (แถว 15, N1), grid avatar + กลุ่มชิปเลือกได้ (N4)

## 4. แผนลำดับ (เลือก 1)

ทุกแผน: แต่ละชุดเริ่มด้วยงาน Code เพิ่ม mock scenario ให้สถานะที่ขาดของชุดนั้น แล้วถ่ายภาพเพิ่มใน inventory → mockup (canvas) → Nok เลือก → task Code แบบ Test-first

### แผน A · ตามทางเดินผู้เล่น
1. เข้าเกม (หน้าแรก L + app shell, รายการเกม, สร้างเกม, ห้องรอ, สร้างตัวละคร รวม N4 เมื่อ ISK-007 merge)
2. ในเกม + จบเกม (state ที่ขาดของ Play, บั๊กมือถือ, N2 N3 N5)
3. GM
4. admin (shell + ตาราง/การ์ด, N1)

### แผน B · ฐานก่อน (component + mock ทั้งเว็บ)
1. mock scenario ให้ครบ 32 สถานะที่ขาด + ของใหม่ 6 อย่าง แล้วถ่ายภาพใหม่ทั้งชุด
2. component กลางใหม่ทั้งหมดก่อน: app shell + hero, แถบแท็บ, ตาราง → การ์ด, การ์ดตัวเลือก (แทน radio), ป้ายสถานะ, grid avatar + ชิป
3. ไล่ทำทุกหน้า S ในรอบเดียว → M → L

### แผน C · ต่อจากงานที่กำลังมา (ISK-002 / ISK-007)
1. หน้าที่ ISK-002 / ISK-007 แตะอยู่แล้ว ออกแบบพร้อมตอน merge: สร้างตัวละคร (6 + N4), ห้องรอ (5), avatar ในแชต / HUD (N5), modal เกมถูกปิด (N2), จบเกม + ป้าย (11 + N3), รายการเกม (4), admin shell + แท็บเกม (15 + N1)
2. ด่านแรกของผู้เล่นใหม่: หน้าแรก (1), เข้าร่วม (2), สร้างเกม (3), จุดเกิด (7), สไตล์ของฉัน (8)
3. ที่เหลือ: ห้องเล่น state ที่ขาด (9), GM (10, 12, 13), admin อื่น (14, 16–21)

### ตารางเทียบ

| | A ตามทางเดินผู้เล่น | B ฐานก่อน | C ต่อจาก ISK-002 / 007 |
|---|---|---|---|
| ผลต่อผู้เล่น | เห็นเร็วที่สุด: หน้าแรก + สร้างตัวละครเปลี่ยนในชุดแรก | ช้าที่สุด: ชุดแรกไม่มีหน้าที่เปลี่ยน แต่ทุกหน้าจะเหมือนกันทีเดียว | เร็ว: สร้างตัวละคร / ห้องรอ / แชต / จบเกม เปลี่ยนในชุดแรก หน้าแรกเป็นชุดที่ 2 |
| ขนาดงานรวม | กลาง: app shell ทำในชุด 1 แต่หน้าที่ ISK-002 / 007 แก้แล้วอาจต้องกลับมาแก้ซ้ำ (Lobby, Ending, GameHistory, AdminDashboard) | เล็กสุดตอนทำหน้า แต่ชุดแรกใหญ่ (32 mock + 6 component) | เล็กสุดโดยรวม: หน้าที่ ISK-002 / 007 แตะ ถูกแตะครั้งเดียว |
| ความเสี่ยง | ต้องเลือกทิศทางหน้าแรก (A/B/C บน canvas) ก่อนเริ่ม; ชนไฟล์กับ ISK-002 / 007 ถ้าทำขนาน | component ที่ทำล่วงหน้าอาจไม่ตรงกับที่หน้าใช้จริง (สร้างไว้เผื่อ); Nok ไม่เห็นผลนานที่สุด | ผูกกับเวลา merge ของ ISK-002 / 007 (ถ้าช้า ชุด 1 รอ); หน้าแรกซึ่งเก่าที่สุดค้างนานกว่าแผน A |

**แนะนำ: แผน C** เพราะ ISK-002 และ ISK-007 อนุมัติแล้วและแก้ไฟล์ของหน้าในชุดแรกอยู่แล้วเกือบทุกไฟล์ (CharacterScreen, Lobby, Ending, GameHistory, AdminDashboard, PlayRoom, Bubbles, Hud) ออกแบบตอนนั้นทำให้ทุกหน้าถูกแตะครั้งเดียว, ปิดจุดบอดใหญ่สุด (ขั้นของติดตัว + ตรวจทาน) ในชุดแรก และได้ admin shell (L) ไปพร้อมแท็บเกม ข้อเสียคือหน้าแรกรอชุดที่ 2 ถ้า Nok อยากให้เพื่อนเห็นหน้าแรกใหม่ก่อน ให้เลือกแผน A
**Nok เป็นคนเลือก** (Questions row ของ ISK-004)

## ข้อสังเกตที่ไม่อยู่ใน scope นี้

- ห้องเล่นมือถือ: เดินทาง / คุย ในแผ่นฉากแล้วภาพไม่เปลี่ยน (จาก inventory) อาจเป็นบั๊ก ควรตรวจในเครื่องจริงก่อนชุดในเกม
- หน้าแรกแสดง "Server: ต่อได้ (database connected)" ให้ผู้เล่นเห็น (ข้อความ dev) ทุกแผนเอาออกตอนทำแถว 1
