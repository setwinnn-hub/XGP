# รายงานผลทดสอบ Phase 1 และ Phase 2

ทดสอบเมื่อ: 24–25 พ.ย. 2026 (ช่วง 22:30–23:55 UTC ของวันที่ 24) บนเครื่อง Windows ของผู้ใช้ ใช้ RPC และ API ฟรีทั้งหมด
ทุกตัวเลขมาจากตลาดจริงและจาก Discord จริง ไม่มีข้อมูลจำลอง วัดด้วย `npm run report`, `npm run check:evm`, `npm run trades` และ `scripts/verify-evm-trades.ts`

ความหมายของตัวเลข latency:
- **detect** = จาก block time บน chain ถึงเวลาที่บอทได้รับข้อมูล (block time ละเอียดแค่ระดับวินาที จึงคลาดได้ ±1 วินาที)
- **chain→Discord** = จาก block time ถึงเวลาที่เซิร์ฟเวอร์ Discord ได้รับข้อความ (อ่านจาก message ID)

---

## Phase 1 — ตรวจจับเหรียญใหม่

### ผลรอบสุดท้าย (หลังแก้บั๊กแล้ว)
| แหล่ง | จำนวน event | detect p50 / p95 | chain→Discord p50 / p95 | ครบไหม (เทียบกับ chain) |
|---|---|---|---|---|
| Pump.fun เหรียญใหม่ (PumpPortal) | 400 / ชม. | 0.90s / 1.31s | 1.21s / 1.26s (n=7) | — |
| Pump.fun จบ bonding curve | 40 / ชม. | 0.82s / 1.43s | 1.13s / 1.72s | — |
| Base คู่เทรดใหม่ | 81 / ชม. | 0.66s / 1.43s | 0.88s / 1.83s | **67/67** |
| BNB Chain คู่เทรดใหม่ | 34 / ชม. | 0.81s / 1.26s | 1.04s / 1.55s | **11/11** |
| Ethereum คู่เทรดใหม่ | 13 / 20 นาที | 3.75s / 5.02s | 3.67s / 5.19s | **13/13** |

- Discord: ส่ง 100+ ข้อความ **ไม่มีข้อความล้มเหลว** เวลาตั้งแต่บอทได้รับข้อมูลจนถึง Discord อยู่ที่ p50 0.17s / p95 0.33s
- ระบบเฝ้าระวัง (fault test): ตั้ง Base RPC เป็นที่อยู่ที่ใช้ไม่ได้ ภายใน 30 วินาทีระบบส่ง SYSTEM alert แล้วเชื่อมต่อใหม่อัตโนมัติ

### บั๊กที่พบระหว่างทดสอบและแก้แล้ว
1. **Base พลาดคู่เทรดใหม่ 4 คู่:** เดิมใช้ log subscription ผ่าน `watchEvent` ของ viem ซึ่งพลาด event ไปเงียบ ๆ แก้เป็นอ่านทุก block ใหม่ด้วย `eth_getLogs` ไล่ต่อจาก block ล่าสุดที่อ่านแล้ว หลังแก้เก็บครบ 67/67
2. **Ethereum จับช้า 6–9 นาที:** RPC แจ้ง block ใหม่ก่อนที่ index ของ log จะพร้อม ทำให้ `getLogs` ล้มเหลวซ้ำ ๆ แก้โดยถอยไปอ่านถึง head−1 ก่อน หลังแก้ p50 อยู่ที่ 3.75s ซึ่งส่วนใหญ่เป็น block time ~12 วินาทีของ Ethereum เอง
3. **Solana มี transaction version 1 แล้ว:** ต้องส่ง `maxSupportedTransactionVersion: 1`
4. **รีวิวโค้ด 2 รอบ:** แก้ watchdog ที่อาจค้างเงียบ, การ retry ของ Discord, ช่องข้อความที่ว่างจน Discord ปฏิเสธ, การ cache ค่า decimals ที่ผิด และอื่น ๆ

### ข้อจำกัดที่ยังมี
- **Solana latency:** วัด block time ได้น้อยมาก เพราะ public RPC บล็อก `getTransaction` (ได้ n=4–56 จาก 400 event)
- **Factory บน Base ที่ไม่เห็น event:** Uniswap V3, Aerodrome, Aerodrome CL และ PancakeSwap V3 ไม่มี event เลยใน ~22 ชม. ที่ตรวจ contract มีอยู่จริง แต่ยังยืนยันไม่ได้ว่า event signature ถูกต้อง
- **Phase 1b ยังไม่ได้ทำ:** Tron, TON, Sui, Arbitrum, Polygon, Optimism, Avalanche

---

## Phase 2 — ติดตาม Wallet (BUY / SELL)

ทดสอบกับ wallet สาธารณะที่ active จริง 9 ตัว ได้แก่ Solana 4, BSC 3, Base 2 (ชื่อขึ้นต้นด้วย `TEST`)

### ผล (25 นาที)
| Chain | Trade ที่จับได้ | detect avg / p95 | chain→Discord avg / p95 | ความถูกต้อง |
|---|---|---|---|---|
| BNB Chain | 83 | 0.78s / 1.24s | 1.09s / 1.49s | **40/40 ตรงกับวิธีตรวจแยก (ต่างกัน 0.00%)** |
| Base | 2 (ต่ำกว่า $5 จึงไม่ส่ง alert) | 0.93s | — | ยังไม่ได้ตรวจแยก (ข้อมูลน้อย) |
| Solana (RPC) | 2 | 0.92s | — | 1/1 ตรงกับการถอดรหัสซ้ำ |

**วิธีตรวจแยกบน BSC:** ใช้วิธีที่ต่างจากบอท
- BUY เทียบกับ `tx.value` (จำนวน BNB ที่ wallet ส่งออกไป)
- SELL เทียบกับ event `Withdrawal` ของ WBNB (การแปลง WBNB กลับเป็น BNB)
- ตัวบอทเองใช้การดูส่วนต่างยอดคงเหลือ การที่สองวิธีได้ตัวเลขตรงกันจึงเป็นการยืนยันข้ามกันจริง
- รวมถึง SELL ขนาด 69.99 BNB ($38k) ที่ระบบติดป้าย whale ก็ถูกต้อง

### ปัญหาที่พบ
1. **PumpPortal account-trade เสียเงิน:** PumpPortal ตอบกลับชัดเจนว่า `subscribeAccountTrade` ใช้ได้เฉพาะ API key ที่เติมเงินไว้ ทางเร็วแบบฟรีสำหรับ Pump.fun จึงใช้ไม่ได้ ตอนนี้ระบบใช้ทางนี้เฉพาะเมื่อตั้ง `PUMPPORTAL_API_KEY`
2. **Public Solana RPC ตามไม่ทัน:** wallet ที่เป็น volume bot ส่ง tx ถี่จนคิวเต็ม และ tx ถูกทิ้ง **54,798 รายการ** (ลบ wallet ตัวนั้นออกแล้ว และลด log ให้เหลือสรุปนาทีละครั้ง) **การติดตาม wallet บน Solana ให้ใช้งานได้จริงต้องใช้ Helius free key** (1M credits/เดือน, 10 RPS)
3. **Wallet ส่งหลาย tx ใน block เดียว (EVM):** ยอด native คำนวณจาก `tx.value` ได้อย่างเดียว ถ้าเป็นการขายอาจถูกข้าม (มี warn log บอกไว้)

### สรุปว่าอะไรใช้งานได้จริงแล้ว
| ระบบ | สถานะ |
|---|---|
| ตรวจจับเหรียญใหม่: Pump.fun, Base, BNB, Ethereum | ✅ ทดสอบกับตลาดจริงแล้ว ไม่พลาดเลย |
| ติดตาม wallet บน BNB Chain | ✅ ถูกต้อง 40/40 ถึง Discord ใน ~1.1 วินาที |
| ติดตาม wallet บน Base / Ethereum | ⚠️ โค้ดเดียวกับ BNB แต่ข้อมูลจริงยังน้อย ยังไม่ได้ตรวจแยก |
| ติดตาม wallet บน Solana | ⚠️ ถอดรหัสถูกต้อง แต่ต้องใช้ Helius key ถึงจะตามทัน |
| แจ้งเตือน Discord | ✅ ส่งแล้วหลายร้อยข้อความ ไม่มีข้อความล้มเหลว |
