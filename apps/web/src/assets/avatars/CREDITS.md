# Credits: avatars (ISK-005)

ภาพ avatar ให้ผู้เล่นเลือก 12 แบบ ข้อมูลของแต่ละภาพ (alt, sex, skinTone, ageBand, ชิปเริ่มต้น) อยู่ใน `packages/protocol/src/avatar-presets.json`

- **Model:** Scenario `model_openai-gpt-image-2-5-sunburst` (GPT Image 2.5 Sunburst), team `team_PCRgKduyEb3Qt8DhCFtZtJNg`, project `proj_L28ZbUMBBAZvG6m9ejEz8LNQ`
- **วันที่:** 2026-11-23 (Claude สร้างตามงาน ISK-005 ที่ Nok อนุมัติงบ)
- **ขนาดที่สร้าง:** 1024×1024 PNG พื้นทึบ (`background: opaque`) ต้นฉบับอยู่ใน `assets/avatars-src/` (gitignore)
- **ไฟล์ในโปรเจกต์:** `avatar-NN.webp` 256px และ `avatar-NN@2x.webp` 512px (ffmpeg libwebp `-q:v 85`, lanczos)
- **CU ที่ใช้:** 12 ภาพ × 12 CU = **144 CU** (ไม่มีรอบแก้; งบ ≤ 25 ภาพ)
- **ลิขสิทธิ์:** ทุกภาพเป็นตัวละครที่คิดขึ้นใหม่ prompt สั่ง "original character (not based on any existing character or real person)" ไม่ได้อ้างชื่อตัวละคร ศิลปิน หรือคนจริง และไม่มีภาพอ้างอิง ตรวจเงื่อนไขการใช้เชิงพาณิชย์ของแพ็กเกจ Scenario ก่อนเผยแพร่

## Prompt หลัก (ใช้ร่วมทุกภาพ)

> Character avatar portrait for a fantasy isekai RPG, original character (not based on any existing character or real person). Style: polished anime-inspired painterly fantasy illustration, soft cel shading, clean linework, warm golden rim light, rich saturated colors, same art style as a bright high-fantasy anime game key art. Composition: square image, head-and-shoulders bust, facing the viewer at a slight three-quarter angle, face exactly centered. The whole head including hair must sit well inside the central 60% of the frame, with wide empty margins on all sides; top of the hair far below the top edge, shoulders cropped by the bottom edge. Background: perfectly flat, uniform solid dark navy blue color #13203A filling the entire background, no gradient, no texture, no vignette, no frame, no border, no text, no logo. Subject: …

## รายภาพ

| ไฟล์ | Scenario asset | Subject (ต่อท้าย prompt หลัก) |
|---|---|---|
| avatar-01 | asset_SAQYim2uhfKBzUk9EBX3DHuV | teenage boy ~16, light skin, short messy brown hair, blue eyes, small, traveler's green hooded cloak — apprentice adventurer |
| avatar-02 | asset_R9EF1Cii3CAG5LmiAJ2xVhxQ | teenage girl ~16, deep dark skin, long black braid, golden eyes, petite, blue apprentice mage robe — apprentice mage |
| avatar-03 | asset_cRdAmHwdmLd4TcXGtMXb8sqi | man ~30, olive-tan skin, black low ponytail, brown eyes, tall, leather ranger jerkin, cheek scar — forest ranger |
| avatar-04 | asset_7Vpvohb5AUKMbgTGJ2WJSbqN | woman ~28, light skin, long blond hair, green eyes, white-gold priestess vestments with veil — temple priestess |
| avatar-05 | asset_PTBhgSA8iBSRVcfxZ6v1hhnp | man ~32, deep dark skin, shaved head, brown eyes, muscular, leather mercenary armor, neck tattoo — mercenary |
| avatar-06 | asset_APRgwHQL98dEnVh4vtS71vKD | woman ~25, tan skin, wavy red hair, green eyes, small, leather rogue vest, eyepatch — thief |
| avatar-07 | asset_fj6xk2PXUbLmgJPWuss1Ayh4 | man ~50, light skin, short silver hair + beard, blue eyes, purple scholar-mage robe, round glasses — alchemist scholar |
| avatar-08 | asset_tkjnR4G2dhZt6fvHjrK5KKAB | woman ~48, deep dark skin, braided crown, brown eyes, stout, burgundy-gold noble merchant coat — merchant guild master |
| avatar-09 | asset_AQyEiMHXETXYM4HdJqiXjVS9 | man ~50, tan-brown skin, short black hair + beard, brown eyes, stout, work shirt + blacksmith apron, burn scar — blacksmith |
| avatar-10 | asset_PxTHZvJ6rX3rJ1ibrVTY3v8V | woman ~27, dark skin, long wavy black hair, heterochromia (blue / gold), bard traveler outfit, gold cheek tattoo — bard |
| avatar-11 | asset_rVCtY1dS9fiAjgxnfSyta3qp | boy ~15, light-brown skin, short black hair, brown eyes, small, pale blue-white acolyte robe — temple acolyte |
| avatar-12 | asset_p6mgsLx5WHm1XuJtrAAq7PWt | woman ~50, light skin, white high ponytail, blue eyes, tall, crimson-gold noble court coat — noble diplomat |

## การตรวจ

- พื้นหลังมุมภาพวัดได้ #12–16 / #1F–22 / #34–3C (ห่าง #13203A ไม่เกิน ±6 ต่อช่องสี) ไม่โปร่งใส
- หน้าทุกภาพอยู่ในวงกลางเส้นผ่านศูนย์กลาง 70% ของภาพ (ปลายผม / ผ้าคลุมของ 04, 12 เลยวงเล็กน้อย หน้าไม่ถูกตัด)
