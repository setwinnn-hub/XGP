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

### Stage 6: Unique Buyers (EVM) ✅
| ไฟล์ | การเปลี่ยนแปลง |
|---|---|
| `src/gem/swap-store.ts` (ใหม่) | ตาราง `gem_watch` (เหรียญที่กำลังเฝ้า, อยู่ต่อแม้รีสตาร์ท), `gem_swaps` (ซื้อ/ขายรายธุรกรรม, กันซ้ำด้วย PK), `gem_cursor` (block ล่าสุดที่อ่านแล้ว และเวลาที่ข้อมูลเริ่มครบ) |
| `src/gem/swap-netting.ts` (ใหม่) | รวมยอดเข้า/ออก pool ต่อธุรกรรม นับเฉพาะธุรกรรมที่มี Swap event (ตัดการเติม/ถอน LP) ตัด arbitrage ที่ยอดสุทธิ < 10% ของยอดรวม |
| `src/gem/swap-collector.ts` (ใหม่) | อ่าน log ของเหรียญที่เฝ้าทุก ~5 วินาทีจาก block head เดียวกับระบบเดิม ผู้ซื้อ = **ผู้เซ็นธุรกรรม (tx.from)** ไม่ใช่ผู้รับ Transfer (เพราะ router รวมยอด) รองรับ V2/V3 pair และ Uniswap V4 (ผ่าน PoolManager + pool id) ถ้า RPC ล้มเหลวจะพักแบบ back-off 15 วินาที–5 นาที และอ่านช่วงเดิมซ้ำ ไม่ทำข้อมูลหาย |
| `src/gem/buyer-stats.ts` (ใหม่) | หน้าต่าง 1/5/15/60 นาที: buys, sells, unique buyers/sellers, ผู้ซื้อใหม่, ผู้ซื้อซ้ำ, กระเป๋าที่ซื้อ ≥2 ครั้ง, อัตราซื้อ/ขาย, การเติบโตเทียบหน้าต่างก่อนหน้า และธง `complete` (ถ้าข้อมูลไม่ครอบคลุมทั้งหน้าต่างจะบอกว่าไม่ครบ ไม่เดา) |
| `src/gem/watch-policy.ts` (ใหม่) | เหรียญ EVM ที่ถูกวิเคราะห์และมี pool จะถูกเฝ้า 6 ชั่วโมง (ต่ออายุเมื่อวิเคราะห์ใหม่) สูงสุด 40 เหรียญต่อ chain ไม่เฝ้าเหรียญที่ market cap (หรือ FDV) เกิน $1M เช่น WBTC/DAI |
| `src/chains/evm/evm-adapter.ts` | เพิ่ม hook `swapCollector` (แบบเดียวกับ `walletScanner`) ไม่แตะการตรวจ pair เดิม |
| `src/analysis/analysis-engine.ts` | เพิ่ม hook `onAnalysed` (ถ้า hook error จะ log เท่านั้น ไม่กระทบการวิเคราะห์) |
| `src/main.ts` | สร้าง swap store / collector (ใช้ HTTP client แยก ไม่ใช้ WebSocket ร่วมกับการตรวจ pair) และลงทะเบียนเหรียญที่จะเฝ้า |
| `src/config.ts`, `.env.example` | เพิ่ม `GEM_SWAP_CHAINS` (ค่าเริ่มต้น `ethereum,bsc`) |
| `scripts/buyers.ts` (ใหม่) | `npm run buyers -- <chain> <token> [นาที]` อ่านย้อนหลังจาก chain (ไม่เขียน DB) หรือ `--stored` ดูข้อมูลที่บอทเก็บ |
| `test/gem-buyers.test.ts` (ใหม่) | 15 tests (รวม collector กับ RPC จำลองที่คืน log รูปแบบจริง) |

**ผลทดสอบจริง (25 พ.ย. 18:30–19:40 UTC):**

1) อ่านย้อนหลังจาก chain เทียบกับ DexScreener (pool เดียวกัน):
| เหรียญ | ช่วง | ระบบเรา (buys / sells / unique buyers) | DexScreener (buys / sells) |
|---|---|---|---|
| IGNIS (BSC, PancakeSwap V2) | 60 นาที | 223 / 136 / 190 | h1: 229 / 171 |
| IGNIS | 5 นาที | 18 / 20 / 18 | m5: 20 / 19 |
| E2E (Base, Uniswap V4) | 30 นาที | 13 / 2 / **3 กระเป๋า** | h1: 50 / 2 |
| SCION (ETH) | 15 นาที | 22 / 24 / 22 | h1: 23 / 23 |

- จำนวน buys ใกล้เคียง DexScreener ส่วน sells ของเราต่ำกว่าเพราะตัด arbitrage ออก
- E2E แสดงว่าทำไมต้องนับเป็นกระเป๋า: DexScreener เห็น 50 buys แต่จริงๆ มาจากแค่ 3 กระเป๋า

2) ข้อมูลที่บอทเก็บเองระหว่างรัน (`--stored`) เทียบกับการอ่าน chain ใหม่ทั้งหมด (เหรียญ `0xc36C…7777` บน BSC, 15 นาที):
- บอท: 675 / 536 / 307 กระเป๋า
- อ่านใหม่: 678 / 537 / 309

ต่างกันไม่ถึง 1% เพราะสคริปต์รันช้ากว่าราว 40 วินาที หน้าต่างจึงเลื่อนไป

3) เมื่อเริ่มเฝ้าเหรียญกลางหน้าต่าง หน้าต่างนั้นจะแสดง `complete = NO` อย่างถูกต้อง (SCION 15m)

**ปัญหาที่เจอและแก้แล้ว:**
- **RPC ฟรีรับ address ได้ไม่เกิน 10 ตัวต่อ `eth_getLogs`:** ผ่าน WebSocket ขึ้นว่า "Request exceeds defined limit" ส่วน HTTP บอกตรงๆ ว่า "A maximum of 10 addresses is allowed" แก้โดยแบ่ง query เป็นชุดละ 10 เหรียญ (มี test)
- **เดิมยิง 4 query พร้อมกันบน WebSocket เดียวกับการตรวจ pair:** แก้เป็น HTTP client แยก และยิงทีละ query
- **เหรียญใหญ่ (WBTC, DAI) ถูกเฝ้าเพราะกระเป๋าที่ติดตามซื้อ:** เพิ่มเพดาน $1M
- **เวลา block:** เดิมเรียก `getBlock` ทุก block ที่มี swap เปลี่ยนเป็นอ่านแค่ต้นและท้ายช่วงแล้วประมาณค่าระหว่างกลาง (คลาดเคลื่อนระดับวินาที)

**Base ปิดไว้ก่อน (`GEM_SWAP_CHAINS=ethereum,bsc`):**
- ขณะเปิดบน Base, RPC ฟรีของ Base ถูกจำกัด (429) จนเก็บข้อมูลขาดเป็นช่วงๆ (coverage ถูกรีเซ็ต 8 ครั้งใน 15 นาที)
- จำนวน pair ใหม่ที่ตรวจพบบน Base ลดลงชัดเจน: 26 ใน 18 นาที เทียบกับรอบก่อนหน้าที่ได้ 113 ใน 30 นาที
- ระบบเดิมต้องไม่เสีย จึงปิด Base ไว้
- จะเปิดได้เมื่อใส่ RPC ส่วนตัวที่ `EVM_BASE_HTTP_URL` (เช่น Alchemy หรือ QuickNode แบบฟรีที่มี key)

**Regression:**
- test ผ่าน 171/171 และ typecheck ผ่าน
- **`check:evm` รันไม่ได้รอบนี้:** RPC ฟรีของ Base ตอบ 429 (rate limit ทั้ง IP) หลังจากที่เราทดสอบอ่านย้อนหลังหลายรอบ ต้องรันซ้ำเมื่อ limit คลาย
- **จำนวน pair ที่ตรวจพบต่อ 15 นาที:** Base 29 / 84 / 26 / 13 / 26 / 23, ETH 7–24, BSC 5–23
  - ช่วงที่ Base ได้ 84 เป็นช่วงที่มีเหรียญเปิดตัวถี่ผิดปกติ
  - หลังปิด collector บน Base แล้ว Base ได้ 23 ใน 13 นาที ซึ่งพอๆ กับตอนที่เปิด
  - **ยังสรุปไม่ได้ว่า collector ทำให้ Base ตรวจ pair ได้น้อยลงหรือเปล่า** จึงปิด Base ไว้ก่อนเพื่อความปลอดภัย
- warning ของระบบเดิม ("Invalid parameters" ที่เกิดจาก index ของ ETH ตามไม่ทัน และ socket ของ Base หลุด) เกิดในอัตราเดียวกับก่อนอัปเกรด

**ข้อจำกัดที่ยังเหลือ:**
- ผู้ซื้อ = ผู้เซ็นธุรกรรม ถ้าซื้อผ่าน smart wallet, bot หรือ relayer (เช่น Telegram bot บางตัว) จะนับตามกระเป๋าที่เซ็น
- ไม่มีข้อมูลย้อนหลังก่อนเริ่มเฝ้า ช่วง 60 นาทีแรกจึงแสดง `complete = NO` จนกว่าจะเก็บครบ (`npm run buyers -- <chain> <token> 60` อ่านย้อนหลังเองได้)
- Solana ยังไม่รองรับ (ต้องใช้ Helius key)
- ช่วงเวลาที่ DexScreener ใช้ (m5/h1) ไม่ตรงกับหน้าต่างของเราเป๊ะ จึงเทียบได้แค่ระดับใกล้เคียง

### Stage 7: Early Buying + Accumulation / Pre-Pump ✅
| ไฟล์ | การเปลี่ยนแปลง |
|---|---|
| `src/gem/clustering.ts` (ใหม่) | จัดกลุ่มกระเป๋าที่น่าจะประสานงานกัน จากหลักฐานที่มีอยู่แล้ว: ซื้อ block เดียวกัน, priority fee เท่ากันแบบค่าที่ไม่ใช่ค่าเริ่มต้น, เป็นกระเป๋าใหม่ (nonce ≤ 1) ทั้งคู่, ขนาดซื้อเท่ากัน (น้ำหนักต่ำ) และซื้อพร้อมกันซ้ำหลายครั้ง **จะจับคู่ต่อเมื่อน้ำหนักหลักฐานรวมได้ ≥ 2** การซื้อร่วม block เดียวครั้งเดียวจะไม่ถูกจับคู่ตามที่ spec กำหนด |
| `src/gem/accumulation.ts` (ใหม่) | สถานะ `INSUFFICIENT_DATA` / `QUIET` / `ACCUMULATING` / `PRE_PUMP` / `ALREADY_PUMPED` / `SUSPICIOUS` พร้อม confidence และเหตุผลภาษาไทย ดูจาก**อัตราเร่ง**ของผู้ซื้ออิสระ (5 นาทีล่าสุดเทียบกับค่าเฉลี่ยต่อ 5 นาทีของ 10 นาทีก่อนหน้า) ไม่ใช่ volume ผู้ซื้อที่อยู่กลุ่มเดียวกันนับเป็น 1 ราย มีกระเป๋าที่ซื้อแล้วยังไม่ขาย, แรงซื้อ, smart money ที่ติดตามอยู่ และราคา 1 ชม. ประกอบ (ถ้าราคาขึ้นไปแล้ว = `ALREADY_PUMPED`) |
| `src/gem/signal-store.ts` (ใหม่) | ตาราง `gem_signals` เก็บประวัติผลการประเมิน (บันทึกเมื่อสถานะเปลี่ยน หรือทุก 15 นาที) สำหรับ watchlist และ backtest |
| `src/gem/gem-monitor.ts` (ใหม่) | ประเมินทุกเหรียญที่เฝ้าอยู่ทุก 1 นาที ดึงราคาจาก DexScreener ครั้งละ 30 เหรียญ ประเมิน "ณ เวลาที่ collector สแกนล่าสุด" เพื่อไม่ให้ช่วงที่ collector หยุดดูเหมือน "ไม่มีคนซื้อ" ถ้าไม่มีราคาก็ยังประเมินต่อและบอกว่าขาดข้อมูลราคา |
| `src/gem/swap-store.ts`, `swap-collector.ts` | เพิ่มคอลัมน์ `nonce`, `fee_gwei` (migrate ตารางเดิมอัตโนมัติ) ค่าเหล่านี้ได้มาจาก `getTransaction` ที่เรียกอยู่แล้ว จึงไม่เพิ่ม request |
| `src/analysis/market.ts` | เพิ่ม `fetchMarkets` ดึงหลายเหรียญในครั้งเดียว ส่วน `fetchMarket` เดิมไม่เปลี่ยน |
| `src/main.ts` | เปิด gem monitor (ใช้ chain ตาม `GEM_SWAP_CHAINS`) |
| `scripts/buyers.ts` | แสดงผล accumulation, metrics และ cluster ต่อจากตาราง window |
| `test/gem-accumulation.test.ts` (ใหม่) | 11 tests รวมตัวอย่างจาก spec: 8 → 22 ผู้ซื้อ = PRE_PUMP แต่ 500 ผู้ซื้อหลังราคาขึ้น 240% = ALREADY_PUMPED |

**เกณฑ์ (อยู่ใน `ACCUMULATION_RULES` ให้ Dashboard ปรับได้ภายหลัง):**
- **PRE_PUMP:** ผู้ซื้ออิสระเร่งขึ้น ≥ 2 เท่า, ≥ 5 รายใน 5 นาที, แรงซื้อ ≥ 55% และราคา 1 ชม. < 50%
- **ACCUMULATING:** ผู้ซื้ออิสระ ≥ 8 รายใน 15 นาที, ≥ 5 รายซื้อแล้วยังไม่ขาย, แรงซื้อ ≥ 55% และราคา 1 ชม. < 50%
- **ALREADY_PUMPED:** ราคา 1 ชม. ≥ 100% หรือ 5 นาที ≥ 30%
- **SUSPICIOUS:** ผู้ซื้อ ≥ 50% (และ ≥ 4 กระเป๋า) อยู่ในกลุ่มที่ประสานงานกัน
- **INSUFFICIENT_DATA:** ข้อมูลยังไม่ครบ 15 นาที หรือซื้อน้อยกว่า 5 ครั้ง

**ผลทดสอบจริง (25 พ.ย. 19:40–19:55 UTC):**
- **`npm run buyers -- bsc 0xc36C…7777 30`:** ได้ `ACCUMULATING` (confidence MEDIUM)
  - ผู้ซื้ออิสระ 154 รายใน 15 นาที, 99 รายยังถือ, แรงซื้อ 63%, ราคา 1 ชม. +43%
  - พบ 4 กลุ่ม (กลุ่มละ 2–3 กระเป๋าที่ซื้อพร้อมกันซ้ำหลายครั้ง) คิดเป็น 4% ของผู้ซื้อ
- **Monitor ในบอท (รอบแรก 23 เหรียญ):**
  - INSUFFICIENT_DATA 20 เหรียญ (ซื้อขายน้อย)
  - ACCUMULATING 2 เหรียญ (BSC "1": 144 ราย, ราคา +48%; BSC 莫达: 63 ราย, ราคา −6.5%)
  - QUIET 1 เหรียญ (ETH JIMMY)
- **Migration:** swap ที่บันทึกหลังรีสตาร์ททุกรายการมี nonce และ fee ส่วนรายการเก่าเป็น null ตามที่ควรเป็น
- **Regression:** test ผ่าน 182/182, typecheck ผ่าน, ไม่มี warning หรือ error จาก `gem:*` หลังรีสตาร์ท

**ข้อจำกัด:**
- **ไม่ได้ตรวจแหล่งเงินทุนของกระเป๋า (funding source):** Etherscan รุ่นฟรีไม่รองรับ chain เหล่านี้ กลุ่มที่พบจึงหมายถึง "น่าจะประสานงานกัน" ไม่ได้พิสูจน์ว่าเป็นเจ้าของเดียวกัน
- ยังไม่ได้ดูการเติบโตของ Liquidity (Stage 8) และจำนวน Holder (ไม่มีแหล่งข้อมูลฟรี)
- เกณฑ์ทั้งหมดยังไม่ได้ปรับด้วย backtest (Stage 12) **อย่าใช้ PRE_PUMP เป็นสัญญาณซื้อ**
- ยังไม่ส่งแจ้งเตือนเข้า Discord (Stage 10) ตอนนี้มีแค่ log `gem signal` และประวัติในฐานข้อมูล

### Stage 8: Liquidity + Security Engine ✅
| ไฟล์ | การเปลี่ยนแปลง |
|---|---|
| `src/gem/slippage.ts` (ใหม่) | คำนวณ x·y=k ซึ่งให้ค่าตรงเป๊ะสำหรับ pair แบบ V2 ส่วน V3/V4 ให้เป็น "ค่าประมาณ" slippage ที่ได้ = price impact + ค่าธรรมเนียม pool ไม่รวมภาษีของ token (ภาษีแยกไว้ใน security) |
| `src/gem/pool-reserves.ts` (ใหม่) | อ่าน `getReserves`/`token0`/`token1`/`decimals` ของ pair V2 ทั้งหมดด้วย multicall ครั้งเดียว ถ้าเป็น V3 จะ revert และถูกข้ามไป |
| `src/gem/liquidity.ts` (ใหม่) | แยก 3 คำตอบออกจากกัน ไม่รวมเป็นสถานะเดียว: activity (`NO_REAL_ACTIVITY`/`LOW_ACTIVITY`/`ACTIVE`), liquidity (`INSUFFICIENT_LIQUIDITY`/`OK`/`UNKNOWN`) และ slippage ฝั่งซื้อ/ขาย ตามขนาดเงินที่ตั้งไว้ มี **exit liquidity** (2 เท่าของฝั่งเงิน) และ flag `ONE_SIDED`, `LIQUIDITY_DROP` (ลด ≥30% จากจุดสูงสุดใน 1 ชม.), `LIQUIDITY_GROWING`, `RESERVES_MISMATCH` |
| `src/gem/honeypot.ts` (ใหม่) | honeypot.is: จำลองซื้อ/ขายจริงแล้วรายงานภาษี ถ้าตอบ 404 = `NOT_COVERED` ซึ่งไม่ได้แปลว่าปลอดภัย |
| `src/analysis/security.ts` | เพิ่มข้อมูลจาก GoPlus ใน `extra` (optional โค้ดวิเคราะห์เดิมไม่ได้รับผลกระทบ): proxy, blacklist/whitelist, แก้ภาษีได้, cooldown, external call, selfdestruct, ผู้สร้างเคยทำ honeypot, owner renounced, **LP burn/lock %**, ค่าธรรมเนียมของแต่ละ pool |
| `src/gem/security-engine.ts` (ใหม่) | 25 checks สำหรับ EVM และ 6 checks สำหรับ Solana แต่ละ check มี PASS/WARN/FAIL/UNKNOWN พร้อมแหล่งที่มา ระดับรวม: `CRITICAL` / `HIGH_RISK` / `UNKNOWN` / `CAUTION` / `NO_ISSUES_FOUND` **ไม่มีระดับ "SAFE"** ถ้าแหล่งข้อมูลขัดกันจะใช้คำตอบที่แย่กว่าและบันทึกไว้ ถ้าเป็น `CRITICAL` จะตั้ง `suppressGemAlert` |
| `src/gem/security-cache.ts` (ใหม่) | เก็บผล GoPlus + honeypot.is ไว้ 30 นาที ค้นได้ไม่เกิน 3 เหรียญต่อรอบ ถ้าค้นไม่สำเร็จจะใช้คำตอบเดิมต่อ ถ้าโดน rate limit จะพัก 2 นาที |
| `src/gem/quality-store.ts`, `quality-evaluator.ts` (ใหม่) | ตาราง `gem_liquidity` และ `gem_security` (บันทึกเมื่อเปลี่ยน หรือทุก 10/30 นาที) และ log `gem liquidity drop` / `gem security critical` |
| `src/gem/gem-monitor.ts`, `src/main.ts` | ทุก 1 นาทีประเมิน liquidity + security ต่อจาก accumulation ใช้ HTTP client เดียวกันต่อ chain |
| `src/gem/settings.ts` | เพิ่มค่าที่ปรับได้: สภาพคล่องขั้นต่ำ ฿100,000, ขนาดเงินทดสอบ ฿5,000, slippage สูงสุด 10%, ซื้อขั้นต่ำ 10 ครั้ง, ผู้ซื้อขั้นต่ำ 8 ราย, กระเป๋าอิสระขั้นต่ำ 6 ราย |
| `src/analysis/market.ts` | เพิ่ม `priceNative`, `liquidityBase/Quote`, `quoteTokenAddress` (optional) |
| `scripts/token-check.ts` (ใหม่) | `npm run tokencheck -- <chain> <token> [ขนาดเงินบาท]` |
| `test/gem-quality.test.ts` (ใหม่) | 16 tests ใช้รูปแบบข้อมูลจริงของ honeypot.is, GoPlus และ DexScreener V4 |

**ผลทดสอบจริง (25 พ.ย.):**
- **JIMMY (ETH, Uniswap V2):**
  - reserve บน chain 1.8619 ETH ตรงกับ DexScreener 1.8618
  - ซื้อ/ขาย ฿5,000 เสียราคา 4.75%
  - GoPlus และ honeypot.is ตรงกันว่าภาษี 0% และไม่ใช่ honeypot, LP burn 100%
  - แต่ **เจ้าของแก้ภาษีได้และมีเจ้าของแฝง** จึงเป็น `HIGH_RISK`
- **`0xc36C…7777` (BSC, PancakeSwap V2):**
  - pool ฿1.05M, ซื้อ/ขาย ฿5,000 เสียราคา 1.19% (fee 0.25% จาก GoPlus), ฿50,000 เสียราคา 8.47%
  - honeypot.is ไม่มี pair นี้ (`NOT_COVERED`) GoPlus ตอบครบ
  - ผล `NO_ISSUES_FOUND` พร้อมหมายเหตุว่า "ไม่ได้แปลว่าปลอดภัย"
- **`0xC21C…` (Base, Uniswap V4):**
  - DexScreener บอกสภาพคล่อง $4,011 แต่**ฝั่ง ETH มีแค่ $0.10** (liquidity เป็นตัว token เกือบทั้งหมด)
  - ระบบแสดง exit liquidity ฿7 และ `INSUFFICIENT_LIQUIDITY`
  - ไม่เดา slippage ฝั่งซื้อ (ประเมินไม่ได้)
  - เดิมระบบเชื่อตัวเลข $4,011 ได้แก้แล้ว
- **Monitor ในบอท (23 เหรียญ, 5 นาที):**
  - Security: HIGH_RISK 11, UNKNOWN 6, CAUTION 4, NO_ISSUES_FOUND 2
  - Liquidity: OK 11, INSUFFICIENT 14, UNKNOWN 2
  - ไม่มี warning หรือ error จาก `gem:*`
- **Regression:** test ผ่าน 199/199, typecheck ผ่าน

**ข้อจำกัด:**
- slippage ของ V3/V4 เป็นค่าประมาณแบบ full-range (Uniswap Quoter แบบ on-chain ยังไม่ได้ทำ)
- **LP lock ของ V3/V4 ตรวจไม่ได้** (LP เป็น NFT) จึงขึ้นเป็น `UNKNOWN` เสมอ
- honeypot.is ไม่มีข้อมูลหลาย pair บน BSC และไม่รองรับ Solana, Solana ยังไม่มีการจำลองการขาย
- ไม่ได้ตรวจ: Related Deployer Wallets, Known Malicious Wallet Exposure, Insider Wallet Concentration (ไม่มีแหล่งข้อมูลฟรี)
- Liquidity Concentration ข้ามหลาย pool ยังไม่ได้คิด (GoPlus มีรายชื่อ pool อยู่แล้ว ทำต่อได้)

## 6. การตัดสินใจ (ยืนยันแล้ว 25 พ.ย. 2026)
1. **ช่วง market cap เริ่มต้น: 66,000–500,000 บาท** (≈ $2k–$15k) ปรับได้ใน Dashboard ภายหลัง
2. **ทำ EVM (ETH/Base/BNB) ก่อน** ส่วน Solana จะเพิ่มเมื่อมี Helius key ระหว่างนี้ Solana ใช้ข้อมูลจาก DexScreener ได้อย่างเดียว และติดป้าย LOW CONFIDENCE
3. **สร้าง baseline git commit** เป็นจุด rollback (เฉพาะในเครื่อง ไม่ push)
