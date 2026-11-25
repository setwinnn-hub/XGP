# MEME COIN RADAR AI — Feasibility, Architecture, Plan, Cost

สถานะเอกสาร: ร่างเพื่อขออนุมัติ (2026-11-24) — ยังไม่มีโค้ด ยังไม่มีการทดสอบใด ๆ
ตัวเลขราคาและ rate limit ทั้งหมดมาจากเอกสารผู้ให้บริการ/แหล่งข้อมูลที่ค้นได้ ณ วันที่เขียน
ต้องยืนยันอีกครั้งใน console ของแต่ละเจ้าก่อนสมัคร เพราะเปลี่ยนบ่อย

ตัวเลข latency ทุกตัวในเอกสารนี้เป็น **ประมาณการ** ยังไม่ได้วัดจริง จะวัดจริงในแต่ละ Phase

---

## 1. สรุปความเป็นไปได้ (Feasibility)

| ส่วน | ทำได้จริงไหม | ความยาก | หมายเหตุสำคัญ |
|---|---|---|---|
| Solana: เหรียญใหม่ Pump.fun | ได้ | ต่ำ | PumpPortal WebSocket ฟรี (third-party, unofficial) + สำรองด้วย RPC `logsSubscribe` โปรแกรม Pump.fun |
| Solana: Raydium / PumpSwap / Meteora pool ใหม่ | ได้ | กลาง | ดัก log ของโปรแกรม AMM ผ่าน RPC WebSocket |
| Solana: ติดตาม Wallet BUY/SELL | ได้ | กลาง | RPC WebSocket ต่อ wallet แล้ว parse swap เอง (Pump.fun, PumpSwap, Raydium, Jupiter, Meteora) |
| EVM 7 เครือข่าย (ETH, Base, BNB, Arbitrum, Polygon, Optimism, Avalanche) | ได้ | กลาง | ใช้ adapter เดียวกัน ต่างกันแค่ config (RPC, factory address, explorer) |
| EVM: pair ใหม่ Uniswap / PancakeSwap / Aerodrome | ได้ | กลาง | subscribe event `PairCreated` / `PoolCreated` / Uniswap v4 `Initialize` |
| EVM: ติดตาม Wallet | ได้ | กลาง | subscribe ERC-20 `Transfer` ที่ from/to = wallet แล้วอ่าน receipt เพื่อจับคู่ว่าจ่ายอะไร ได้อะไร |
| Tron | ได้ แต่ช้ากว่า | กลาง | TronGrid ไม่มี WebSocket สาธารณะที่ใช้ได้ดี ต้อง poll block (block ทุก ~3 วิ) |
| TON | ได้บางส่วน | สูง | ติดตาม wallet ทำได้ผ่าน streaming API ของ TON indexer; จับ jetton/pool ใหม่ยากกว่า |
| Sui | ได้บางส่วน | สูง | JSON-RPC WebSocket subscription ถูก deprecate แล้ว และ Sui Foundation ปิด JSON-RPC บน full node ตั้งแต่ ก.ค. 2026 เหลือ gRPC `SubscribeCheckpoints` ต้องกรองเองทั้ง checkpoint |
| DexScreener / GeckoTerminal | ได้ | ต่ำ | ไม่มี WebSocket ทางการ ใช้เป็นตัวเติมข้อมูล (ราคา, liquidity, volume) ไม่ใช่ตัวตรวจจับหลัก |
| Birdeye | ได้ถ้าจ่าย | ต่ำ | Free tier มีแค่ 30,000 CU ใช้จริงไม่พอ |
| X / Twitter | ได้ แต่เสียเงินตามการใช้ | กลาง | Pay-per-use: อ่านโพสต์ $0.005 ต่อโพสต์ ไม่ทำ scraping |
| Crypto news RSS | ได้ | ต่ำ | ฟรี |
| Reddit | ได้ | ต่ำ | ใช้ API ทางการ (OAuth) ต้องยืนยันเงื่อนไขการใช้ฟรีก่อน |
| Telegram public channels | ได้แบบมีเงื่อนไข | กลาง | Bot อ่าน channel ที่ตัวเองไม่ได้เป็น admin ไม่ได้ ต้องใช้ user API (api_id ของคุณเอง) — มีความเสี่ยงบัญชีโดนจำกัด |
| FOMO official API | **ไม่พบ** | — | ค้นแล้วไม่พบ API หรือโปรแกรม developer สาธารณะ จะใช้วิธีเพิ่ม public wallet address เอง ไม่แตะ API ส่วนตัวของ FOMO |
| Smart Money ranking | ได้ | สูง | คำนวณจากธุรกรรมที่ระบบเก็บเอง ต้องสะสมข้อมูลหลายสัปดาห์ก่อนแม่นยำ หรือจ่ายค่า backfill ประวัติ |
| AI วิเคราะห์ | ได้ | กลาง | คะแนนคำนวณด้วยกฎที่ตรวจสอบได้ AI ใช้อธิบายเหตุผลและสรุปข่าว |
| Risk detection | ได้บางส่วน | กลาง | Honeypot/mint/freeze/holder concentration ตรวจได้จริง; "fake volume" และ "bot engagement" เป็นการประมาณจาก heuristic ไม่ใช่การพิสูจน์ |
| Discord real-time | ได้ | ต่ำ | Webhook แยกตามหมวด 8 ช่อง |
| Dashboard | ได้ | กลาง | Web app รันในเครื่อง/VPS |

### สิ่งที่ทำไม่ได้หรือไม่ควรสัญญา
- **ไม่มีทางเร็วกว่า sniper bot มืออาชีพ** ที่จ่ายเงินหลักพันดอลลาร์ต่อเดือนให้ Geyser/gRPC และวาง server ข้าง validator เป้าหมายจริงคือ "เร็วกว่าคนทั่วไปและเร็วกว่าแอปแจ้งเตือน" ไม่ใช่เร็วที่สุดในตลาด
- **คะแนน 0–100 ไม่ใช่การทำนายราคา** เหรียญส่วนใหญ่ที่เปิดบน launchpad ราคาไปถึงศูนย์ ระบบจะแสดงความเสี่ยงแยกจากโอกาสเสมอ
- **Fake volume / bot engagement** ตรวจได้แค่ระดับ "น่าสงสัย" จาก pattern (wash trade ระหว่าง wallet กลุ่มเดียวกัน, wallet อายุน้อย, บัญชี X ที่สร้างใหม่) ไม่มีวิธีพิสูจน์ 100%
- **Block timestamp ของ chain ส่วนใหญ่ละเอียดแค่ระดับวินาที** ดังนั้น latency "จากเวลาเกิดธุรกรรม" จะคลาดเคลื่อนได้ ±1 วินาที

---

## 2. Architecture

ภาษา: **TypeScript (Node.js 22)** — library ของ Solana และ EVM (viem) ครบที่สุด และใช้ภาษาเดียวทั้ง backend และ dashboard

```
                    ┌──────────────────────── Chain Adapters (1 ตัวต่อ chain family) ────────────────────────┐
                    │ SolanaAdapter   EvmAdapter(x7 config)   TronAdapter   TonAdapter   SuiAdapter          │
                    │  - PumpPortal WS  - eth_subscribe logs   - block poll  - streaming  - gRPC checkpoints │
                    │  - RPC logsSub    - receipt decode                                                       │
                    └──────────────┬──────────────────────────────────────────────────────────────────────────┘
                                   │ normalized events (TokenLaunched, PoolCreated, WalletTrade)
   ┌───────────── News Sources ────┤
   │ X API, RSS, Reddit, Telegram  │ NewsItem
   └───────────────────────────────┤
                                   ▼
                     ┌──────────────────────────────┐
                     │ Event Bus (Redis Streams)    │  dedupe: Redis SET NX + DB unique key
                     └──┬───────────┬───────────┬───┘
                        │           │           │
        FAST PATH       ▼           ▼           ▼        SLOW PATH (เบื้องหลัง)
  ┌────────────────────────┐  ┌──────────┐  ┌───────────────────────────────────┐
  │ Notifier               │  │ Storage  │  │ Enricher → Risk Engine → Scorer → │
  │ WalletTrade ส่ง Discord │  │ Postgres │  │ AI Explainer → Notifier (update)  │
  │ ทันที ไม่รอ AI          │  └──────────┘  │ DexScreener / GeckoTerminal /     │
  └────────────────────────┘                │ GoPlus / RPC holder data          │
                                            └───────────────────────────────────┘
                        ▲
  ┌─────────────────────┴──────────┐     ┌──────────────────────────┐
  │ Dashboard (React) + API        │     │ Health Monitor           │
  │ wallets, keywords, alerts,     │     │ heartbeat ทุก source     │
  │ feeds, ranking, settings       │     │ แจ้ง Discord เมื่อหลุด     │
  └────────────────────────────────┘     └──────────────────────────┘
```

### โมดูล (ตรงกับข้อ 11 ใน spec)
| โมดูล | หน้าที่ |
|---|---|
| Blockchain Data Engine | `ChainAdapter` interface: `connect()`, `onNewToken()`, `watchWallets(addresses)`, `decodeTrade(tx)`, `health()` เพิ่ม chain ใหม่ = เขียน adapter ใหม่ 1 ไฟล์ + config ไม่ต้องแก้ส่วนอื่น |
| Token Detection Engine | รับ TokenLaunched/PoolCreated, กรองซ้ำ, ติดตาม volume/holder ช่วงแรก, ตรวจ bonding curve ใกล้จบ / migration |
| News Intelligence Engine | ดึงข่าว, แยก ticker/contract address จากข้อความ, นับ mention ต่อช่วงเวลา, ตรวจการพุ่งผิดปกติ |
| Wallet Tracking Engine | รายการ wallet จาก DB, subscribe ต่อ chain, decode BUY/SELL, ตรวจซื้อซ้ำ/ขายซ้ำ |
| Smart Money Engine | FIFO realized PnL, win rate, holding time, จัดอันดับ, ค้นหา wallet ใหม่จาก early buyer ของเหรียญที่ขึ้นแรง |
| Risk Detection Engine | honeypot, mint/freeze authority, LP lock/burn, holder concentration, dev wallet ขาย, wash-trade pattern |
| AI Analysis Engine | รวมสัญญาณ → คะแนนจากกฎ (ตรวจสอบได้) → Claude เขียนเหตุผลและแยก opportunity/risk |
| Discord Notification Engine | คิวต่อ webhook, เคารพ rate limit, retry, ส่ง `?wait=true` เพื่อได้เวลาที่ Discord รับข้อความ |
| Database Engine | PostgreSQL (ข้อมูลถาวร) + Redis (bus, dedupe, cache) |
| Dashboard | React + Fastify API, bind `127.0.0.1` เท่านั้น, มีรหัสผ่านเข้า |

### Latency measurement (ทุก event)
เก็บ 4 timestamp ต่อ event: `t_chain` (block time), `t_detected`, `t_processed`, `t_discord` (จาก message ID ของ Discord ที่ตอบกลับ)
Dashboard แสดง latency รวม, average, P50, P95 แยกตาม source และ chain

### ความน่าเชื่อถือ
- ทุก WebSocket มี auto-reconnect แบบ exponential backoff + jitter และ re-subscribe อัตโนมัติ
- ต่อ chain มี RPC สำรองอย่างน้อย 1 ตัว ถ้าตัวหลักเงียบเกิน N วินาทีให้สลับ
- Dedupe 2 ชั้น: Redis `SET NX` (TTL 24 ชม.) + unique constraint ใน Postgres
- Log แบบ JSON (pino) หมุนไฟล์รายวัน, error ส่งเข้า Discord ช่อง system
- รันด้วย Docker Compose `restart: unless-stopped`

### ความปลอดภัย
- ระบบนี้ **อ่านอย่างเดียว** ไม่ต้องใช้ private key หรือ seed phrase เลย และจะไม่มีโค้ดที่รับค่าเหล่านี้
- API key อยู่ใน `.env` (อยู่ใน `.gitignore`) ไม่ส่งไปที่ browser; หน้า API Settings แสดงสถานะและค่าแบบ mask เท่านั้น
- ไม่มี Auto Buy / Auto Sell

---

## 3. ผู้ให้บริการข้อมูล: ฟรี vs เสียเงิน

| ผู้ให้บริการ | ใช้ทำอะไร | ฟรี | เสียเงิน | Rate limit / ข้อจำกัด |
|---|---|---|---|---|
| PumpPortal Data API | Pump.fun token ใหม่, trade, migration | ✅ | — | Unofficial; มี rate limit; ต้องเช็คเงื่อนไขล่าสุดที่ pumpportal.fun |
| Helius (Solana RPC) | WebSocket, ดึง tx, holder | Free: 1M credits/เดือน, 10 RPS | Developer $49, Business $499 | WebSocket ถูกนับ credit (2 credits/0.1 MB) ตั้งแต่ พ.ค. 2026; Enhanced WebSocket ต้องใช้แผนเสียเงิน (เอกสารขัดกันว่าเริ่มที่ Developer หรือ Business) |
| Alchemy (EVM RPC) | WebSocket หลาย chain | Free: 30M CU/เดือน, ~300 CU/วิ | Pay-as-you-go | ต้องยืนยันว่ารองรับ BNB/Avalanche บน free tier; ถ้าไม่ ใช้ provider อื่นที่มี WSS ฟรี |
| TronGrid | Tron | Free: ~15 QPS, ~100K req/วัน | ติดต่อขยาย quota | ใช้ header `TRON-PRO-API-KEY` |
| TON Center | TON | Free (มี key): 10 RPS | Plus 25 RPS, Advanced 100 RPS | ไม่มี key = 1 RPS |
| Sui gRPC (fullnode) | Sui | ฟรีผ่าน public node (ถ้ายังเปิด) | provider เสียเงิน | มีแค่ `SubscribeCheckpoints` ต้องกรองเอง |
| DexScreener API | ราคา, liquidity, volume, boosts | ✅ | — | token profiles/boosts 60 req/นาที, pairs ~300 req/นาที |
| GeckoTerminal API | pool ใหม่, ข้อมูลสำรอง | ✅ | CoinGecko แผนเสียเงินเพื่อ limit สูงขึ้น | 30 req/นาที |
| Birdeye API | วิเคราะห์ Solana ละเอียด | 30K CU (แทบใช้ไม่ได้) | Starter $99 (3M CU), Premium $199 (10M CU) | ไม่จำเป็นใน MVP |
| GoPlus Security | honeypot, contract risk | Free ~150K CU/เดือน | แผนเสียเงิน | ต้องยืนยัน limit ของ endpoint real-time |
| X API | โพสต์, KOL, mention | ❌ | Pay-per-use: อ่าน $0.005/โพสต์, อ่าน user $0.010 | เพดานต่อเดือนยังไม่ชัด (แหล่งข้อมูลขัดกัน 2M–3M โพสต์) |
| RSS (CoinDesk, Cointelegraph, Decrypt, The Block ฯลฯ) | ข่าว | ✅ | — | poll ทุก 30–60 วิ |
| Reddit API | ชุมชน | ต้องยืนยัน | — | OAuth |
| Discord Webhook | แจ้งเตือน | ✅ | — | ประมาณ 5 ข้อความ/2 วิ ต่อ webhook → ใช้ webhook แยกต่อหมวด |
| Claude API | อธิบายคะแนน, สรุปข่าว | ❌ | ตาม token | ดูหัวข้อ 4 |

---

## 4. ประมาณค่าใช้จ่ายต่อเดือน

### ค่า AI (Claude API)
สมมติ 1 การวิเคราะห์ ≈ input 2,000 tokens + output 500 tokens และวิเคราะห์เฉพาะเหรียญที่ผ่านตัวกรองกฎ (ไม่ใช่ทุกเหรียญ)

| โมเดล | ราคา (input/output ต่อ 1M tokens) | ต่อครั้ง | 100 ครั้ง/วัน | 500 ครั้ง/วัน |
|---|---|---|---|---|
| Claude Opus 5.5 (ค่าเริ่มต้นที่ผมจะใช้) | $4 / $20 | ~$0.018 | ~$54/เดือน | ~$270/เดือน |
| Claude Haiku 5.5 (ถ้าคุณต้องการประหยัด) | $0.10 / $0.50 | ~$0.00045 | ~$1.4/เดือน | ~$7/เดือน |

### ค่า X API (pay-per-use, $0.005 ต่อโพสต์ที่อ่าน)
| รูปแบบ | โพสต์/วัน | ค่าใช้จ่าย/เดือน |
|---|---|---|
| ติดตาม KOL 50 บัญชี | ~1,000 | ~$150 |
| KOL 20 บัญชี | ~400 | ~$60 |
| Search keyword กว้าง ๆ | 5,000+ | $750+ |

### แพ็กเกจรวม
| ระดับ | ประกอบด้วย | ประมาณ/เดือน |
|---|---|---|
| **A: ฟรี** | PumpPortal, Helius Free, Alchemy Free, TronGrid/TON Center free, DexScreener, GeckoTerminal, GoPlus free, RSS, Discord, AI Haiku | **~$0–5** (+ค่าไฟ ถ้ารันเครื่องตัวเอง) — ไม่มี X, RPC ฟรีหลุดบ่อยกว่าและช้ากว่า |
| **B: แนะนำเริ่มต้น** | A + Helius Developer $49 + VPS ~$10–20 + X KOL 20 บัญชี ~$60 + AI (Haiku ~$2 หรือ Opus ~$54) | **~$120–185** |
| **C: จริงจัง** | Helius Business $499 + Birdeye Premium $199 + X KOL 50+ ~$150+ + RPC EVM เสียเงิน ~$50–200 + AI Opus + VPS แรงขึ้น | **~$1,000+** |

หมายเหตุ: ถ้ารันบนเครื่องที่บ้านในไทย latency ไปถึง RPC (ส่วนใหญ่อยู่ US/EU) จะสูงกว่า VPS ที่อยู่ใกล้ RPC ประมาณ 150–300 ms ต่อ round trip

---

## 5. Latency ที่คาดว่าจะได้ (ประมาณการ ยังไม่วัด)

| เหตุการณ์ | ประมาณการ (ตั้งแต่เกิดบน chain ถึง Discord) | ตัวจำกัดหลัก |
|---|---|---|
| Pump.fun เหรียญใหม่ | 1–3 วิ | PumpPortal / RPC |
| Solana wallet trade | 1–3 วิ | RPC WebSocket + การ parse |
| Base / Arbitrum / Optimism / Polygon / BNB | 2–5 วิ | block time + receipt fetch |
| Ethereum | 12–15 วิ | block time ~12 วิ |
| Tron | 3–8 วิ | ต้อง poll block |
| TON / Sui | 3–10 วิ | ยังไม่แน่นอนจนกว่าจะทดสอบ |
| ข่าว X | 15–60 วิ | ความถี่ poll (ขึ้นกับงบ) |
| ข่าว RSS | 30–120 วิ | ความเร็วของเว็บข่าวเอง |
| ส่ง Discord | 0.2–0.6 วิ | network |

---

## 6. แผนพัฒนา (แต่ละ Phase ต้องทดสอบด้วยข้อมูลจริงก่อนไปต่อ)

### Phase 1 — Core + Multi-Chain Data + Token ใหม่
- โครงโปรเจกต์, Docker Compose (Postgres, Redis), config, logging, health monitor
- `ChainAdapter` interface + Event Bus + dedupe + latency tracking
- **SolanaAdapter**: Pump.fun token ใหม่, migration, PumpSwap/Raydium pool ใหม่
- **EvmAdapter**: เริ่ม Base, BNB, Ethereum (factory Uniswap v2/v3/v4, PancakeSwap, Aerodrome) แล้วเปิด Arbitrum/Polygon/Optimism/Avalanche ผ่าน config
- Discord: NEW TOKEN ALERT + ช่อง system
- **ทดสอบ**: รันกับตลาดจริง ≥ 1 ชม. ต่อ chain, เทียบกับ DexScreener/explorer ว่าไม่พลาด, วัด latency P50/P95
- Tron / TON / Sui: แยกเป็น **Phase 1b** หลังจาก Phase 2 ผ่าน เพราะแต่ละตัวต้องใช้วิธีเฉพาะ

### Phase 2 — Wallet Tracking + BUY/SELL Alerts
- เพิ่ม/ลบ wallet ผ่าน CLI และ API (dashboard มาใน Phase 5 แต่ API พร้อมตั้งแต่ตอนนี้)
- Solana: decode swap ของ Pump.fun, PumpSwap, Raydium, Jupiter, Meteora
- EVM: decode จาก Transfer + receipt, ราคา USD จาก DexScreener
- Fast path: ส่ง SMART MONEY BUY/SELL ทันที, ตรวจซื้อซ้ำ/ขายซ้ำ, WHALE ALERT ตาม threshold
- **ทดสอบ**: ใช้ wallet สาธารณะที่ active จริง (คุณเลือก หรือ wallet ที่เห็นบน explorer) เทียบทุก alert กับ explorer ว่า BUY/SELL, จำนวน, เหรียญ ถูกต้อง

### Phase 3 — X/Twitter + News Scanner
- RSS ก่อน (ฟรี) → X API (ถ้าอนุมัติงบ) → Reddit → Telegram (ถ้าต้องการ)
- แยก ticker / contract address จากข้อความ, mention velocity, KOL list
- BREAKING NEWS + TRENDING MEME COIN
- **ทดสอบ**: เทียบเวลาที่ตรวจพบกับเวลาโพสต์จริง, วัดอัตรา false positive ของการจับ ticker

### Phase 4 — Smart Money Ranking + AI Analysis
- FIFO realized PnL, win rate, avg holding time, จำนวนครั้งที่ซื้อก่อนราคาพุ่ง
- จัดอันดับด้วยเกณฑ์ขั้นต่ำ (จำนวนเทรด ≥ N) เพื่อตัดกำไรครั้งเดียวออก
- ค้นหา wallet ใหม่จาก early buyers ของเหรียญที่ขึ้นแรง
- คะแนน 0–100 จากกฎ + Claude อธิบายเหตุผล แยก opportunity / risk
- HIGH OPPORTUNITY alert
- **ทดสอบ**: backtest กับข้อมูลที่ระบบเก็บไว้เองใน Phase 1–3 (ไม่ใช่ข้อมูลจำลอง)

### Phase 5 — Risk Detection + Dashboard
- Honeypot (GoPlus), mint/freeze authority, LP status, holder concentration, dev wallet ขาย, wash trade pattern
- HIGH RISK ALERT
- Dashboard ครบ 11 หน้าตาม spec
- **ทดสอบ**: E2E ของ flow หลัก (เพิ่ม wallet → เกิด trade → alert → แสดงใน dashboard)

### Phase 6 — ทดสอบรวม + ปรับความเร็ว
- รัน 24–72 ชม. ต่อเนื่อง, จำลองการหลุดของ RPC, วัด P95 ทุก source
- รายงาน: source ไหนใช้ได้, latency จริง, ข้อจำกัด

---

## 7. การตัดสินใจ (ยืนยันแล้ว 2026-11-25)

1. **ระดับงบ**: A — ฟรีทั้งหมด
2. **X API**: ไม่ใช้ (เสียเงิน) ข่าวใน Phase 3 ใช้ RSS + Reddit ก่อน; เปิด X ภายหลังได้ถ้าเพิ่มงบ
3. **ที่รัน**: เครื่อง Windows นี้ก่อน ย้ายไป VPS ภายหลัง
4. **AI**: แบบฟรี — ไม่เรียก Claude API แบบเสียเงิน คะแนน 0–100 และเหตุผลสร้างจากกฎที่ตรวจสอบได้ (rule-based)
   ทางเลือกภายหลัง: LLM ที่รันในเครื่อง (เช่น Ollama) ถ้าเครื่องมี GPU/RAM พอ หรือเปิด Claude API เมื่อมีงบ
5. **Chain ใน Phase 1**: Solana + Base + BNB + Ethereum; Arbitrum/Polygon/Optimism/Avalanche เปิดผ่าน config; Tron/TON/Sui เป็น Phase 1b

### ผลของการเลือกแบบฟรี
- ใช้ Helius Free (1M credits/เดือน, 10 RPS) — ต้องคุมจำนวน wallet ที่ติดตามและปริมาณ WebSocket ไม่ให้ credit หมดกลางเดือน
- EVM ใช้ Alchemy Free + RPC สาธารณะเป็นสำรอง — หลุดบ่อยกว่า ต้องพึ่ง auto-reconnect
- ไม่มีข่าวจาก X ใน MVP
- คำอธิบายเหตุผลของคะแนนจะเป็นข้อความจากกฎ (เช่น "Top 10 holder ถือ 62% → ความเสี่ยงสูง") ไม่ใช่ข้อความที่ AI เขียน

### สภาพเครื่อง (ตรวจ 2026-11-25)
- Node.js v26.13.0, npm 11.20.0, Git 2.56 — พร้อม
- **ไม่มี Docker** → MVP ใช้ SQLite (`node:sqlite` ในตัว Node) แทน PostgreSQL และใช้ event bus ในโปรเซสแทน Redis
  ทั้งสองอยู่หลัง interface (repository / bus) จึงสลับไป Postgres + Redis ได้ตอนย้ายขึ้น VPS โดยไม่แก้ส่วนอื่น
- รัน 24/7 บนเครื่องนี้ด้วย process manager (เช่น pm2) ให้ restart อัตโนมัติเมื่อโปรเซสล่ม

### สิ่งที่คุณต้องทำเอง (ผมจะไม่กรอก key แทน)
- สร้าง Discord webhook 9 อัน (8 หมวด + system) แล้วใส่ใน `.env`
- สมัคร Helius และ Alchemy (free tier ก่อนได้) แล้วใส่ key ใน `.env`
- ถ้าใช้ X: สมัคร developer account และเติมเครดิตเอง
- ถ้าใช้ AI: ตั้ง `ANTHROPIC_API_KEY` หรือ login ผ่าน `ant auth login`

---

## แหล่งอ้างอิงที่ใช้ประเมิน
- X API pricing: https://docs.x.com/x-api/getting-started/pricing
- Helius plans: https://www.helius.dev/docs/billing/plans
- Birdeye API pricing: https://docs.birdeye.so/docs/pricing
- PumpPortal (mirror README): https://uithub.com/thetateman/Pump-Fun-API
- DexScreener API reference: https://docs.dexscreener.com/api/reference
- GeckoTerminal API: https://apiguide.geckoterminal.com/faq
- Alchemy free tier: https://www.alchemy.com/support/free-tier-details
- TronGrid rate limits: https://developers.tron.network/reference/rate-limits
- Sui JSON-RPC migration: https://docs.sui.io/develop/accessing-data/json-rpc-migration.md
- TON Center rate limit: https://docs.ton.org/ecosystem/api/toncenter/rate-limit
- GoPlus Security API: https://gopluslabs.io/security-api
- FOMO app (ไม่พบ developer API): https://www.quicknode.com/builders-guide/tools/fomo-by-fomo-labs
