# Early Gem Intelligence V2.0: รายงานตรวจระบบเดิมและแผนพัฒนา

วันที่: 25 พ.ย. 2026 (18:30 UTC)
สถานะ: **Stage 1, 2 และ 4 (ตรวจระบบ, ทำแผนผัง, ตรวจแหล่งข้อมูล) เสร็จแล้ว ยังไม่ได้แก้ระบบหลักแม้แต่ไฟล์เดียว** ตามกฎ "ตรวจก่อนแก้"
ตัวเลขทุกตัวในรายงานนี้มาจากการเรียกใช้จริงหรือจากฐานข้อมูลจริงของระบบ

---

## 0. สรุปสั้นสำหรับตัดสินใจ

1. **ช่วง market cap 5,000–15,000 บาทใช้กับ Pump.fun ไม่ได้:** Pump.fun บังคับให้ทุกเหรียญเริ่มที่ 28 SOL ≈ **66,353 บาท** (944 เหรียญที่ระบบเคยเห็น ไม่มีตัวไหนต่ำกว่านี้) ส่วนบน EVM เหรียญที่มีมูลค่า 150–440 ดอลลาร์แทบทั้งหมดเป็นเหรียญที่ตายแล้วหรือเป็น dust ต้องยืนยันว่าตั้งใจใช้ช่วงไหน
2. **นับ Unique Buyers แยกตามช่วงเวลา (1/5/15/60 นาที):**
   - บน EVM ทำได้ฟรี โดยดึง swap log ราย pair ซึ่ง endpoint ฟรียอมให้ดึงได้ถ้าระบุ address
   - บน Solana ต้องใช้ Helius key (ฟรี) เพราะ public RPC บล็อก `getTransaction`
   - DexScreener ให้แค่จำนวนครั้งที่ซื้อขาย ไม่บอกว่ามีกี่ wallet และมีแค่ช่วง 5 นาที, 1 ชม., 6 ชม., 24 ชม.
3. **จัดกลุ่ม wallet จากแหล่งเงินทุน (funding source) ทำได้จำกัด:** Etherscan V2 แบบฟรีตอบว่า "Free API access is not supported for this chain" สำหรับ BSC จะทำได้เฉพาะสัญญาณที่ดูได้จาก chain โดยตรง เช่น จังหวะเวลาที่ซื้อ, คู่ธุรกรรมที่ใช้ร่วมกัน และ wallet ที่ส่งเงินมาภายใน block ที่ระบบเห็น
4. **ยังไม่มี Dashboard:** ใน spec เขียนว่า "เพิ่มลงใน Dashboard เดิม" แต่ระบบยังไม่เคยมี Dashboard (เป็นงานใน Phase 5 ของแผนเดิมที่ยังไม่ได้ทำ) ต้องสร้างใหม่ในโปรเจกต์เดิม
5. **ตรวจ honeypot ด้วยการจำลองซื้อขายจริงทำได้ฟรี (EVM):** honeypot.is ตอบภายใน 240 ms และให้ผลจำลองการซื้อขายจริง น่าสนใจว่าเหรียญตัวอย่าง (USELESS) **honeypot.is บอกว่าเป็น honeypot แต่ GoPlus บอกว่าไม่ใช่** ซึ่งยืนยันว่า spec ถูกที่ห้ามเชื่อ API ตัวเดียว
6. **ยังไม่มี git commit เลย:** ต้องสร้าง baseline commit ไว้เป็นจุด rollback ก่อนเริ่มแก้ (Stage 3) และต้องได้รับอนุญาตก่อน

---

## 1. ตรวจระบบเดิม (Stage 1)

### 1.1 เทคโนโลยี
| ส่วน | สิ่งที่ใช้จริง |
|---|---|
| ภาษา | TypeScript รันตรงบน Node.js 26 (type stripping ไม่มี build step) |
| Library | viem 2.x (EVM), fast-xml-parser 5.x (RSS) |
| Database | SQLite (`node:sqlite`) ไฟล์ `data/radar.db` ตาราง `events` และ `wallets` |
| Event bus | in-process (`src/core/bus.ts`) ยังไม่มี Redis |
| Test | `node:test` 145 tests ผ่านทั้งหมด (ณ รอบล่าสุด) |
| โค้ด | `src` ~4,900 บรรทัดใน 47 ไฟล์ ไม่มีไฟล์ไหนเกิน 222 บรรทัด |
| Git | init แล้วแต่ **ยังไม่มี commit** |

### 1.2 สถานะแต่ละโมดูล (จากการทดสอบจริงที่ผ่านมา)
| โมดูล | ไฟล์หลัก | สถานะ | ผลทดสอบจริง |
|---|---|---|---|
| Multi-chain scanner (EVM) | `src/chains/evm/evm-adapter.ts`, `chains.ts`, `block-range.ts` | ✅ ใช้งาน | เก็บครบ Base 67/67, BSC 11/11, ETH 13/13 |
| Pump.fun scanner | `src/chains/solana/pumpportal-*.ts` | ✅ ใช้งาน | ไม่มี error ใน 944 launch และ 95 migration |
| Wallet tracking (EVM) | `src/chains/evm/wallet-scanner.ts` | ✅ ใช้งาน | ตรงกับวิธีตรวจแยก 40/40 |
| Wallet tracking (Solana) | `src/chains/solana/wallet-watcher.ts` | ⏸️ ปิดไว้ | ต้องใช้ Helius key |
| Smart money | `src/analysis/smart-money.ts` | ✅ คำนวณได้ | ยังจัดอันดับไม่ได้ เพราะประวัติยังไม่พอ |
| News radar | `src/news/*.ts` | ✅ ใช้งาน | 8 แหล่ง ไม่มี error ใน 20 นาที |
| Token analysis | `src/analysis/*.ts` | ✅ ใช้งาน | วิเคราะห์ 57 เหรียญ / 16 นาที |
| Discord | `src/notify/*.ts` | ✅ ใช้งาน | ส่งหลายร้อยข้อความ ไม่มีล้มเหลว |
| Dashboard | — | ❌ ยังไม่มี | — |
| Scheduler / cache | `analysis-engine.ts` (คิวในหน่วยความจำ), cache ราคา/ชื่อ/security | ⚠️ | คิวหายเมื่อรีสตาร์ท |
| 24/7 | ไฟล์บน Desktop | ⚠️ | **บอทหยุด 17 ชม. (00:58–18:12 UTC)** เพราะรันใต้ session ของผม และ session ถูกปิด ไม่ใช่บั๊กของบอท (log ไม่มี error) ต้องรันเองจาก Desktop หรือใช้ pm2 |

### 1.3 ข้อจำกัดและบั๊กที่รู้แล้ว
- คิวของ analysis engine และ trend tracker อยู่ในหน่วยความจำ จึงหายเมื่อรีสตาร์ท
- Base: factory Uniswap V3, Aerodrome, Aerodrome CL และ PancakeSwap V3 ไม่เห็น event ใน ~22 ชม. (ยังไม่ได้พิสูจน์ว่า event signature ถูก)
- EVM wallet: wallet ที่ส่งหลาย tx ใน block เดียวกัน ยอด native อาจไม่ครบ
- Solana: วัด chain time ได้น้อยเพราะ public RPC ถูกจำกัดอัตรา
- ข้อมูลในฐานข้อมูลยังมีแค่ ~1 วัน: launch 947, pair ใหม่ 398, migration 95, wallet trade 248, ข่าว 326, analysis 63

---

## 2. แผนผังระบบ (Stage 2)

```
 แหล่งข้อมูล                     Adapters (src/chains, src/news)          แกนกลาง (src/core)
 ─────────────                   ───────────────────────────────          ──────────────────
 PumpPortal WS  ───────────────▶ pumpportal-adapter ─────┐
 PublicNode WS (ETH/Base/BSC) ─▶ evm-adapter ─────────────┤
                                   └─ wallet-scanner ──────┤  (trade-sink: ชื่อ + USD)
 Solana RPC WS (ปิดไว้) ───────▶ wallet-watcher ──────────┤
 RSS ×7 + Google News ─────────▶ news-adapter ────────────┼──▶ ingest (dedupe) ─▶ SQLite events
 CoinGecko trending ───────────▶ coingecko-trending ──────┘          │
                                                                     ▼
                                                                 EventBus
                                     ┌───────────────────────────────┼─────────────────┐
                                     ▼                               ▼                 ▼
                              notifier (filters → format)    analysis-engine    chain-time sampler
                              └▶ WebhookQueue → Discord      (DexScreener +
                                                              GoPlus → score)
                                                                     └▶ ingest (analysis/alert)
 สคริปต์ (scripts/): report, trades, smartmoney, analyse, news:preview, check:evm, viral:post
 Desktop launchers (launchers/*.ps1) → npm scripts
```

---

## 3. ตรวจแหล่งข้อมูลสำหรับ V2 (Stage 4, ทดสอบจริง 25 พ.ย. 18:20 UTC)

| ความต้องการใน spec | แหล่งที่ทดสอบ | ผล | ใช้ได้แค่ไหน |
|---|---|---|---|
| THB แบบ real-time | CoinGecko `vs_currencies=thb` | ✅ USDT=34.03 THB, SOL=2,373 THB | ฟรี เก็บเวลาและแหล่งที่มาได้ |
| Market cap / FDV แยกกัน | DexScreener `marketCap`, `fdv` | ✅ ได้ทั้งสองค่า | แต่ DexScreener **ประมาณ** circulating ให้เอง ต้องตรวจ supply บน chain ซ้ำ |
| Supply / decimals บน chain | EVM `totalSupply()`, `decimals()` ผ่าน eth_call; Solana `getTokenSupply` | ✅ (ใช้ eth_call อยู่แล้วในระบบ) | circulating ที่แท้จริงต้องหักส่วนที่ burn/lock ออก จึงต้องติดป้าย ESTIMATED เว้นแต่ตรวจได้ |
| Unique buyers 1/5/15/60 นาที (EVM) | `eth_getLogs` แบบระบุ address ของ pair | ✅ endpoint ฟรียอมรับ | ทำได้กับ**เหรียญที่อยู่ใน watchlist** (ไม่ใช่ทุกเหรียญบน chain) |
| Unique buyers (Solana) | public RPC | ⚠️ `getSignaturesForAddress` ได้ แต่ `getTransaction` ถูกจำกัดหนัก | **ต้องใช้ Helius free key** |
| Unique buyers ผ่าน DexScreener | `txns` | ❌ มีแค่จำนวนครั้ง ไม่บอกจำนวน wallet และมีแค่ช่วง m5/h1/h6/h24 | ใช้เป็นข้อมูลสำรองได้เท่านั้น |
| Holder growth | GoPlus `holder_count` (EVM) | ✅ ดึงซ้ำเป็นระยะแล้วเทียบ | Solana: ไม่มีข้อมูลนี้ใน GoPlus |
| Slippage / price impact | V2 `getReserves()` + สูตร constant product | ✅ สูตรใช้ได้ (pair ที่ทดสอบเป็น V3 จึง revert) | V3/V4 ต้องเรียก Quoter contract ซึ่ง**ยังไม่ได้ทดสอบ** ส่วน Pump.fun ต้องใช้ reserve ของ bonding curve |
| จำลองซื้อขาย / honeypot | honeypot.is v2 (ฟรี) | ✅ 240 ms, `simulationSuccess=true` | เฉพาะ EVM (ETH/BSC/Base) |
| LP lock / burn | GoPlus `lp_holders[].is_locked` | ✅ | เฉพาะ EVM |
| Blacklist / proxy / owner | GoPlus | ✅ มี `is_blacklisted`, `is_proxy` | |
| แหล่งเงินทุนของ wallet (clustering) | Etherscan V2 แบบไม่มี key | ❌ "Free API access is not supported for this chain" | ใช้ได้แค่สัญญาณจาก chain (จังหวะเวลา, ผู้ส่งเงินที่เห็นใน block) **ความแม่นยำต่ำกว่าที่ spec ต้องการ** |
| X/Twitter, Telegram | — | ❌ X เสียเงิน (ผู้ใช้เลือกไม่ใช้), Telegram ต้องใช้ user API | ใช้ RSS/Google News/CoinGecko ที่มีอยู่ |
| แก้ข้อความ Discord เดิม | Discord webhook `PATCH /messages/{id}` | 📄 มีในเอกสาร Discord และระบบเก็บ message id อยู่แล้ว | ยังไม่ได้ทดสอบจริง |
| Backtest ย้อนหลัง | ข้อมูลในฐานข้อมูล (~1 วัน) + `eth_getLogs` ย้อนหลังบน EVM | ⚠️ | Solana ย้อนหลังต้องใช้ Helius ส่วน paper trading แบบ live ทำได้ทันที |

---

## 4. แผนแก้ไฟล์ (เฉพาะไฟล์เดิมที่ต้องแตะ)

| ไฟล์ | หน้าที่ปัจจุบัน | สิ่งที่จะแก้ | Dependencies | ความเสี่ยงต่อระบบเดิม | วิธีทดสอบ |
|---|---|---|---|---|---|
| `src/enrich/prices.ts` | ราคา SOL/ETH/BNB เป็น USD | เพิ่ม THB และ USDT/THB, เก็บเวลาและแหล่งข้อมูล | CoinGecko | ต่ำ: เพิ่มเท่านั้น ไม่เปลี่ยน API เดิม | unit test + เทียบกับ CoinGecko จริง |
| `src/analysis/market.ts` | DexScreener best pair | แยก marketCap/FDV/supply, เพิ่ม pairAddress, txns m5/h1/h6 | DexScreener | ต่ำ | unit test จาก response จริงที่บันทึกไว้ |
| `src/analysis/security.ts` | GoPlus | เพิ่ม lp lock, blacklist, proxy, สถานะ UNKNOWN แยกจาก SAFE, รวมผล honeypot.is | GoPlus, honeypot.is | กลาง: เปลี่ยนเกณฑ์ risk | test + เทียบกับเหรียญจริงที่ทั้งสองแหล่งให้ผลต่างกัน |
| `src/analysis/score.ts` | คะแนนแบบกฎ (เดิม) | **ไม่แก้** สร้าง `gem-score.ts` ใหม่คู่กัน เพื่อไม่ให้ alert เดิมเปลี่ยน | — | ไม่มี | regression test เดิมต้องผ่าน |
| `src/analysis/analysis-engine.ts` | คิววิเคราะห์ +2/+15 นาที | เพิ่มจังหวะติดตามผล (1m–7d), บันทึกคิวลง DB เพื่อไม่ให้หายเมื่อรีสตาร์ท, เรียก gem engine | DB, market, security | กลาง | test + รีสตาร์ทกลางคิวแล้วดูว่างานกลับมาครบ |
| `src/chains/evm/evm-adapter.ts` | ส่ง block head ให้ scanner | ส่ง head ให้ตัวเก็บ swap ของ watchlist ด้วย (แบบเดียวกับที่ทำกับ wallet-scanner) | viem | กลาง: อยู่ใน hot path | `check:evm` ต้องได้ 100% เหมือนเดิม |
| `src/storage/db.ts`, `event-repo.ts` | schema และ queries | เพิ่มตาราง `swaps`, `watchlist`, `token_snapshots`, `outcomes`, `settings` (ไม่แก้ตาราง events เดิม) | SQLite | ต่ำ: ใช้ `CREATE TABLE IF NOT EXISTS` | test + เปิด DB จริงที่มีอยู่ได้ |
| `src/config.ts` | อ่าน `.env` | อ่านค่าตั้งของ gem จากตาราง `settings` (Dashboard แก้ได้) และใช้ `.env` เป็นค่าเริ่มต้น | — | ต่ำ | test |
| `src/notify/notifier.ts`, `filters.ts` | ส่ง alert | เพิ่มหมวด `EARLY_GEM`, การแก้ข้อความเดิม (PATCH) และ cooldown | Discord | กลาง | test + ส่งจริง 1 ข้อความแล้วแก้ |
| `src/main.ts` | wiring | เชื่อมโมดูลใหม่ | ทุกตัว | กลาง | เริ่มบอทแล้วต้องเห็น source ครบเหมือนเดิม |
| ไฟล์ใหม่ | — | `src/gem/` (swap-collector, buyer-stats, clustering, liquidity, gem-score, watchlist), `src/dashboard/` (เว็บ), `scripts/backtest.ts` | — | — | test ของแต่ละไฟล์ |

---

## 5. ลำดับการทำงาน (ทำทีละ stage และรายงานผลทุกครั้ง)

| Stage | งาน | เงื่อนไขก่อนเริ่ม |
|---|---|---|
| 3 | Baseline: git commit, รัน test ทั้งหมด, บันทึกผล `check:evm` | **ต้องได้รับอนุญาตให้ commit** |
| 5 | THB + market cap/FDV/supply แบบ verified/estimated/unverified | ยืนยันช่วง market cap |
| 6 | เก็บ swap ราย pair (EVM) → unique buyers 1/5/15/60 นาที, wallet ใหม่/ซื้อซ้ำ | — (Solana ต้องมี Helius key) |
| 7 | ตรวจ accumulation / pre-pump จาก acceleration | Stage 6 |
| 8 | Liquidity (reserves, slippage V2 และ bonding curve) + security (GoPlus + honeypot.is + UNKNOWN) | — |
| 9 | Early Gem Score + confidence + hard-gate ความเสี่ยง | Stage 5–8 |
| 10 | Watchlist (เลื่อน/ลดสถานะ, เก็บประวัติ) + alert EARLY GEM (แก้ข้อความเดิม, cooldown) | Stage 9 |
| 11 | Dashboard (สร้างใหม่ เพราะยังไม่มี) พร้อมหน้าตั้งค่าทั้งหมด | Stage 10 |
| 12 | ติดตามผลหลังตรวจพบ (1m–7d) + paper trading แบบ live (รวมเหรียญที่ถูกปฏิเสธด้วย) | เริ่มเก็บข้อมูลตั้งแต่ Stage 10 |
| 13 | Regression test ทุกโมดูลเดิม | — |
| 14 | เอกสาร + แผน deploy (pm2/VPS) | — |

**ข้อจำกัดที่ต้องยอมรับ:** ระบบจะทำงานกับเหรียญที่เข้า watchlist (เหรียญที่ระบบเจอ, wallet ที่ติดตามซื้อ หรือติด trending) ไม่ใช่ทุก swap บนทุก chain เพราะ endpoint ฟรีไม่ยอมให้ดึง log แบบไม่ระบุ address

---

## 7. รายงานผลแต่ละ Stage

### Stage 3: Baseline ✅
- commit `7e3e29f` (เฉพาะในเครื่อง) ถ้าต้องการย้อนกลับ ใช้ `git reset --hard 7e3e29f`
- ก่อน commit: typecheck ผ่าน, test ผ่าน 145/145, `check:evm` ครบ 100%, ไม่มี secret, ฐานข้อมูล หรือ log ติดเข้า commit

### Stage 5: แปลงเป็นบาท + ตรวจสอบ Market Cap ✅
| ไฟล์ | การเปลี่ยนแปลง |
|---|---|
| `src/enrich/prices.ts` | เพิ่มอัตรา THB/USD จาก CoinGecko (USDT) และ**แหล่งสำรอง** exchangerate-api.com (อัปเดตรายวัน) เก็บแหล่งที่มา เวลา และอายุการใช้งานของอัตรา ส่วน API เดิม `usdValue` ไม่เปลี่ยน |
| `src/analysis/market.ts` | แยก `marketCapUsd` ออกจาก `fdvUsd` **(เดิมเมื่อไม่มี market cap จะใช้ FDV แทน ซึ่ง V2 ห้าม)**, เพิ่ม `pairAddress` |
| `src/analysis/score.ts` | ตอนตรวจการปั่นราคา ถ้าไม่มี market cap จะใช้ FDV แทนและติดป้ายว่า "FDV" ชัดเจน |
| `src/analysis/analysis-engine.ts` | บันทึก `fdvUsd` ลงผลวิเคราะห์ด้วย |
| `src/gem/market-cap.ts` (ใหม่) | สถานะ VERIFIED / ESTIMATED / UNVERIFIED, แยก circulating, FDV, total และ burned, แสดง THB, บันทึกแหล่งที่มา วิธีคำนวณ และเวลา |
| `src/gem/supply.ts` (ใหม่) | อ่าน supply จาก chain: EVM ใช้ multicall `totalSupply`/`decimals`/ยอดใน burn address, Solana ใช้ `getTokenSupply` |
| `src/gem/settings.ts` (ใหม่) | ตาราง `settings` เก็บช่วง market cap (ค่าเริ่มต้น 66,000–500,000 บาท) ไว้ให้ Dashboard แก้ได้ |
| `scripts/mcap.ts` (ใหม่) | คำสั่ง `npm run mcap -- <chain> <token>` |
| `test/gem-mcap.test.ts` (ใหม่) | 11 tests |

**กฎการให้สถานะ:**
- **VERIFIED:** อ่าน supply บน chain ได้ และ FDV ที่คำนวณได้ตรงกับที่ DexScreener คำนวณแยกเองภายใน 5%
- **ESTIMATED:** ต่างกันไม่เกิน 20% หรือไม่มีค่าให้เทียบ
- **UNVERIFIED:** ไม่มีราคา หรือต่างกันเกิน 20%
- ระบบจะไม่นำ FDV มาแสดงแทน market cap
- ถ้าไม่มีอัตราแลกเปลี่ยน ค่าบาทจะว่างไว้ ไม่เดา

**ผลทดสอบจริง (25 พ.ย. 18:18–18:20 UTC):**
| เหรียญ | ผล |
|---|---|
| USELESS (BSC) | VERIFIED ต่าง 0.0%, ฿30.4M → ABOVE |
| Pump.fun (Solana) | VERIFIED ต่าง 0.3–0.8%, ฿1.59M → ABOVE |
| เหรียญใหม่บน Base / ETH | ยังไม่มีราคาบน DEX → UNVERIFIED (ถูกต้องตามกฎ) |
| TRUMP ปลอม (BSC) | ราคาเหลือ 1.98×10⁻¹⁹ USD (ถูก rug แล้ว) → ฿0 → BELOW |

**ปัญหาที่เจอและแก้แล้ว:**
- CoinGecko แบบไม่มี key จำกัดจำนวนครั้งเมื่อเรียกติดกัน ทำให้รอบหนึ่งได้ "FX unavailable"
- แก้โดยเพิ่มแหล่งสำรอง ซึ่งต่างจาก CoinGecko แค่ 0.3% (33.94 กับ 34.04)

**Regression:** test ผ่าน 156/156, `check:evm` ครบ 100% (ETH 4/4, Base 17/17, BSC 5/5)

**ข้อจำกัดที่ยังเหลือ:**
- circulating supply ยังไม่หักส่วนที่ lock ไว้ (GoPlus มีข้อมูล lock ของ LP แต่ไม่มีของ token) จะทำใน Stage 8
- ระหว่างที่เหรียญ Pump.fun ยังอยู่บน bonding curve supply ส่วนใหญ่อยู่ใน curve แต่นับเป็น circulating ตามวิธีเดียวกับ DexScreener

## 6. การตัดสินใจ (ยืนยันแล้ว 25 พ.ย. 2026)
1. **ช่วง market cap เริ่มต้น: 66,000–500,000 บาท** (≈ $2k–$15k) ปรับได้ใน Dashboard ภายหลัง
2. **ทำ EVM (ETH/Base/BNB) ก่อน** ส่วน Solana จะเพิ่มเมื่อมี Helius key ระหว่างนี้ Solana ใช้ข้อมูลจาก DexScreener ได้อย่างเดียว และติดป้าย LOW CONFIDENCE
3. **สร้าง baseline git commit** เป็นจุด rollback (เฉพาะในเครื่อง ไม่ push)
