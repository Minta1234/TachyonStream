# TachyonStream (ภาษาไทย)

<p align="center">
<a href="../README.md">คู่มือหลัก</a> | <a href="./README_JA.md">🇯🇵 日本語</a> | <a href="./README_TH.md">🇹🇭 ภาษาไทย</a>
</p>

---

## คีย์ลัด (Keyboard shortcuts)

เลือกหนังให้เครื่องเล่นมีแหล่งวิดีโอก่อนใช้คีย์ลัดควบคุมการเล่น:

- **Space / K:** เล่นหรือหยุดชั่วคราว
- **← / J:** ย้อนกลับ 10 วินาที
- **→ / L:** เดินหน้า 10 วินาที
- **↑ / ↓:** เพิ่มหรือลดเสียงครั้งละ 5% และยกเลิกการปิดเสียง
- **M:** ปิดหรือเปิดเสียง
- **F:** เข้า/ออกโหมดเต็มจอ
- **Esc:** ปิดกล่องโต้ตอบ หรือกลับ Library จาก Cinema/Upload เมื่อไม่ได้โฟกัสช่องกรอกหรือรายการเลือก ขณะเต็มจอให้เบราว์เซอร์จัดการ Esc เพื่อออกเต็มจอก่อน
- **?:** แสดงรายการคีย์ลัด หรือกดปุ่ม `?` บนแถบเมนู

ปุ่มตัวอักษรอ้างอิงตำแหน่งแป้นภาษาอังกฤษ คีย์ลัดเครื่องเล่นไม่แทรกการพิมพ์ในช่องค้นหา ฟอร์ม รายการเลือก หรือปุ่มที่กำลังโฟกัส ไม่ทำงานในหน้า Upload หรือระหว่างเปิดกล่องโต้ตอบ และไม่แทนที่คีย์ลัด Ctrl/Alt/Command ของเบราว์เซอร์

การเล่น หยุด และเลื่อนเวลายังคงซิงก์กับห้องตามปุ่มควบคุมเดิม ส่วนเสียงและโหมดเต็มจอมีผลเฉพาะหน้าที่ใช้งาน


## 🤖 วิธีใช้งาน Watch Together ผ่าน Discord Bot

1. **สั่งรันบอท:**
   ```bash
   npm run bot
   ```
2. **ใน Discord:**
   * เข้าห้องคุยเสียง (Voice Channel)
   * พิมพ์คำสั่ง slash command: `/watch`
   * บอทจะสร้างปุ่มกดเข้าสู่ **Discord Activity** ให้เพื่อน ๆ ในห้องกดเข้าดูวิดีโอพร้อมกันได้ทันที

---

## 🌐 การตั้งค่า Cloudflare Tunnel (สำหรับการเชื่อมต่อภายนอกและ HTTPS)

Discord Activity ทำงานอยู่ภายใน iframe บน CDN ของ Discord (`*.discordsays.com`) ซึ่งจำเป็นต้องเชื่อมต่อผ่าน **HTTPS** สาธารณะที่ปลอดภัย Cloudflare Tunnel ช่วยให้คุณเปิดเซิร์ฟเวอร์ TachyonStream สู่โลกภายนอกได้โดยไม่ต้องเปิดพอร์ตที่ Router (Port Forwarding) และไม่ต้องเปิดเผย IP จริงของบ้าน

### 1. ติดตั้ง `cloudflared`
- **Windows:**
  ```powershell
  winget install --id Cloudflare.cloudflared
  ```
  *(หรือดาวน์โหลด `cloudflared.exe` จาก [Cloudflare Releases](https://github.com/cloudflare/cloudflared/releases) แล้วนำไปวางใน PATH ของระบบ)*
- **Linux:**
  ```bash
  sudo apt install cloudflared
  ```

### 2. สร้าง Tunnel บน Cloudflare Zero Trust
1. เข้าไปที่ [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) > **Networks** > **Tunnels**
2. คลิก **Add a tunnel** > เลือก **Cloudflare Tunnel (cloudflared)**
3. ตั้งชื่อ Tunnel (เช่น `tachyonstream`) แล้วบันทึก
4. คัดลอก **Tunnel Token** (ข้อความ base64 ที่ขึ้นต้นด้วย `ey...`)

### 3. ตั้งค่า Public Hostname
ในหน้าการตั้งค่า Tunnel:
1. ไปที่แท็บ **Public Hostnames** แล้วคลิก **Add a public hostname**
2. กำหนดค่าดังนี้:
   - **Subdomain:** เช่น `stream`
   - **Domain:** โดเมนของคุณ เช่น `yourdomain.com` (รวมเป็น: `stream.yourdomain.com`)
   - **Service Type:** `HTTP`
   - **URL:** `localhost:9815`
3. บันทึก Hostname

### 4. ใช้งานร่วมกับ TachyonStream
กำหนดค่า `TUNNEL_TOKEN` ใน environment:
```powershell
$env:TUNNEL_TOKEN="your_tunnel_token_here"
```
หรือรันผ่าน `start.bat` — ระบบ `launch.ps1` จะตรวจพบ `TUNNEL_TOKEN` อัตโนมัติ และสั่งเปิด `cloudflared tunnel run` ในพื้นหลังพร้อมบันทึกลง `tunnel.log` ทันที

---

## 🎮 การตั้งค่าบน Discord Developer Portal (Activity & Bot)

### 1. สร้าง Application
1. เข้าสู่ [Discord Developer Portal](https://discord.com/developers/applications)
2. คลิก **New Application** และตั้งชื่อ (เช่น `Tachyon Stream`)

### 2. ตั้งค่า Activity (`Activities` > `Settings`)
- **Enable Activities:** เปิดเป็น **ON** (อนุญาตให้ผู้ใช้เปิดใช้งาน Activity ได้)
- **Age Gate:** ปิด **OFF** (เปิดเฉพาะเมื่อมีเนื้อหา 18+)
- **Proxy Authentication:** ปิด **OFF**
- **Maximum Participants:** กำหนดจำนวนผู้ร่วมรับชม เช่น `5` คน
- **Orientation Lock:** ตั้งค่าทั้ง Phone และ Tablet เป็น **Unlocked**
- **Supported Platforms:** ติ๊กเลือก ✅ **Web**, ✅ **iOS**, และ ✅ **Android**

<p align="center">
  <img src="assets/imgs/media_1792852638891.png" alt="Discord Activity Settings" width="850"/>
</p>

### 3. ตั้งค่า URL Mappings (`Activities` > `URL Mappings`)
เชื่อมต่อ Discord Proxy เข้ากับโดเมน Cloudflare Tunnel ของคุณ:
- **Root Mapping:**
  - **Prefix:** `/`
  - **Target:** `stream.yourdomain.com` *(ใส่เฉพาะชื่อโฮสต์ Cloudflare Tunnel โดยไม่ต้องมี `https://`)*
- *หลักการทำงาน:* Discord จะเชื่อมต่อไปยัง iframe ผ่าน `https://<client_id>.discordsays.com/` และ Proxy ส่งคำขอมายังโดเมน Tunnel ของคุณอย่างปลอดภัย

<p align="center">
  <img src="assets/imgs/media_1792852738042.png" alt="Discord Activity URL Mappings" width="850"/>
</p>

### 4. สิทธิ์ของบอท (Bot & OAuth2)
1. ไปที่เมนู **Bot** > คลิก **Reset Token** แล้วคัดลอกโทเคน
2. นำโทเคนไปใส่ในไฟล์ `.env`:
   ```env
   Discord_token=your_bot_token_here
   ```
3. ไปที่ **OAuth2** > **URL Generator**:
   - **Scopes:** เลือก `bot`, `applications.commands`
   - **Bot Permissions:** เลือก `Create Instant Invite`, `Send Messages`, `View Channels`
4. ใช้ลิงก์ที่สร้างขึ้นเพื่อเชิญบอทเข้าสู่ Discord Server ของคุณ

## ⚙️ การเริ่มระบบและการจัดการโปรเซส

- **เริ่มระบบ:** รัน `start.bat` เพื่อเริ่มเซิร์ฟเวอร์และบอทแบบรันเบื้องหลัง (Background/Hidden) ตรวจสอบบันทึกการทำงานได้ที่ `server.log`, `server.error.log` และ `bot.error.log`
- **หยุดระบบ:** รัน `stop.bat` เพื่อหยุดเฉพาะโปรเซสที่ launcher ของโปรเจกต์นี้บันทึกไว้ใน `.processes.json` โดยไม่ปิด Node.js หรือโปรเซสภายนอกอื่น ๆ
- **Cloudflare Tunnel:** ตั้งค่า `TUNNEL_TOKEN` ใน environment ก่อนเปิด `start.bat` เพื่อเริ่ม Tunnel หรือใช้งาน Tunnel ที่ตั้งค่าไว้ภายนอก
- **สร้างภาพขนาดย่อ (Thumbnails):** รัน `npm run thumbnails` เพื่อสร้างภาพปกจากไฟล์หนังทั้งคลัง (ต้องมี `ffmpeg` และ `ffprobe` ใน PATH หรือกำหนด `FFMPEG_PATH` / `FFPROBE_PATH`) ข้ามภาพที่มีอยู่แล้วโดยไม่แก้ไฟล์หนัง
- **รัน Regression Tests:** รัน `npm test` เพื่อตรวจสอบความถูกต้องของระบบโดยใช้โฟลเดอร์ชั่วคราวแยกจากคลังจริง

---

## 🛡️ สถาปัตยกรรมความปลอดภัยและการประมวลผลไฟล์

- **ระบบอัปโหลดและภาพปก:**
  - วิดีโอที่อัปโหลดใหม่จะสร้างภาพปกอัตโนมัติบนเซิร์ฟเวอร์ก่อนแจ้งคลังอัปเดต (หาก decoder ล้มเหลวจะเก็บวิดีโอไว้และใช้การจับภาพจากเบราว์เซอร์แทน)
  - โฟลเดอร์ใหม่จะดึงภาพจากวิดีโอภายในมาเป็นภาพหน้าปกอัตโนมัติ เมื่อย้ายวิดีโอ ภาพปกและระยะเวลาจะถูกคัดลอกไปตามตำแหน่งใหม่
- **การป้องกันคำขอและการเข้าถึง (Security):**
  - ไม่ต้องใช้รหัสผ่านผู้ดูแลระบบ หน้าเว็บส่ง Playback Session ให้อัตโนมัติเมื่ออัปโหลดหรือจัดการคลัง
  - เซิร์ฟเวอร์ตรวจสอบ Origin, Fetch Metadata และ Session ก่อนรับคำขอที่แก้ไขข้อมูล พร้อมทั้งบล็อกการเชื่อมต่อ Socket.IO จากเว็บไซต์ภายนอก (Cross-site WebSockets)
  - ไฟล์ใน `uploads/` และ `temp_chunks/` ถูกป้องกันไม่ให้เปิดผ่าน static web server โดยตรง รวมถึง URL ที่ encode หรือใช้ตัวพิมพ์ใหญ่ การสตรีมวิดีโอต้องผ่าน `/api/stream` พร้อม session เท่านั้น

## การใช้งานเมนูการ์ด

ปุ่มสามจุดอยู่มุมขวาล่างของการ์ดหนังและโฟลเดอร์ เปิดได้ด้วยการคลิกหรือ Tab แล้ว Enter เมนูรองรับ Tab เพื่อเลือกคำสั่ง และ Esc เพื่อปิดพร้อมคืนโฟกัสที่ปุ่มเดิม การพรีวิวไม่ขวางปุ่ม และหน้าที่ซ่อนอยู่ไม่รับคลิกหรือโฟกัส แถบเมนูและช่องค้นหาจัดเรียงใหม่บนหน้าจอเล็ก

ไอคอนในหน้าเว็บใช้ SVG แทนอีโมจิ รวมถึง Auto-Next อัปโหลด โฟลเดอร์ และสถานะคลังว่าง รายการเลือกแบบ native แสดงชื่อเป็นข้อความตามข้อจำกัดของเบราว์เซอร์
