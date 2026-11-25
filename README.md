# Meme Coin Radar

Real-time, read-only detection of new meme coins with Discord alerts.
Plan, architecture and costs: [docs/PLAN.md](docs/PLAN.md).

**Phase 1 (this version):** new tokens and new pairs.

| Source | Chain | What it detects | Cost |
|---|---|---|---|
| PumpPortal data WebSocket | Solana | Pump.fun launches, Pump.fun migrations (bonding curve finished) | Free |
| `eth_subscribe` logs (PublicNode by default) | Ethereum | Uniswap V2 / V3 / V4 new pairs | Free |
| same | Base | Uniswap V2 / V3 / V4, Aerodrome, Aerodrome CL, PancakeSwap V3 | Free |
| same | BNB Chain | PancakeSwap V2 / V3, Uniswap V2 / V3 / V4 | Free |

**Phase 2:** follow public wallets and alert their BUY / SELL.

| Chain | How trades are found | Cost |
|---|---|---|
| Solana | PumpPortal `subscribeAccountTrade` (fast path, Pump.fun/PumpSwap) + RPC `logsSubscribe` per wallet → `getTransaction` → balance changes (any DEX/aggregator) | Free; public RPC is heavily rate-limited, a Helius free key is recommended |
| Ethereum / Base / BNB | Each new block is read in full; transactions sent by a followed wallet → receipt Transfer logs + native balance change | Free; BNB Chain full blocks are ~260 KB/s of bandwidth |

A trade is "one token in, a quote asset out" (BUY) or the reverse (SELL), read from the wallet's own balance
changes, so it works for every router and aggregator. USD values use CoinGecko native prices (stablecoins = $1);
when no fresh price exists the alert says so instead of guessing.

No trading. No private keys. Alerts are information only, not investment advice.

## Follow wallets
```powershell
npm run wallet -- add solana <address> "label"
npm run wallet -- add base 0x... "label"
npm run wallet -- list
npm run wallet -- remove solana <address>
```
The running bot picks up changes within 15 seconds.

## Requirements
- Node.js 24+ (runs TypeScript directly, no build step)

## Setup
```powershell
npm install
Copy-Item .env.example .env
```
Then open `.env` and paste your Discord webhook URLs (at least `DISCORD_WEBHOOK_NEW_TOKEN` and `DISCORD_WEBHOOK_SYSTEM`).
Without webhooks the bot runs in **dry-run** mode: everything is detected, logged and stored, nothing is sent.

## Run
```powershell
npm start
```

Desktop launchers: the folder `Desktop\Meme Coin Radar` holds double-click `.bat` files
(start, stop, status, add/remove/list wallets, wallet trades, post viral report). Each one is a
one-line ASCII `.bat` that runs a script in `launchers/` (UTF-8 with BOM, so Thai text displays
correctly in Windows PowerShell 5.1). The start launcher refuses to open a second copy of the bot.

24/7 on this machine (restarts on crash):
```powershell
npm install -g pm2
pm2 start npm --name radar -- start
pm2 save
```

## Check
```powershell
npm test
npm run typecheck
npm run report        # latency per source: avg, P50, P95 (last 24h)
npm run report 1      # last hour
npm run verify:evm    # confirm configured DEX factories emit events on the live chain
npm run check:evm     # completeness: re-read factory events from the chain and compare with what was stored
npm run trades        # wallet trades of the last hour with latency
npm run trades -- 1 --verify   # also re-decode Solana trades from raw transactions and compare
```

## Latency fields (stored per event in `data/radar.db`)
| Field | Meaning |
|---|---|
| `t_chain` | Block time from the chain. Whole seconds, so latencies carry ±1 s. Solana: sampled (`LATENCY_SAMPLE_RATE`). |
| `t_detected` | Our process received the event |
| `t_processed` | Alert payload ready to send |
| `t_discord` | Discord's own receipt time, decoded from the message ID |

The PC clock must be synced (Windows: Settings → Time → Sync now), or chain-to-detect numbers are off by the clock error.

## Layout
```
src/
  main.ts                  wiring, health alerts, shutdown
  config.ts                .env parsing and validation
  core/                    event types, bus, ingest+dedupe, health, logger, reconnecting socket
  chains/solana/           PumpPortal adapter, parser, block-time lookups
  chains/evm/              chain + factory config, ABIs, adapter, log normalization
  enrich/dexscreener.ts    token name lookup for migrations
  notify/                  filters, Discord embed format, webhook queue, notifier
  storage/                 SQLite schema and event repository
scripts/                   latency report, factory verification
test/                      node:test unit and integration tests
```

Adding a chain: add an `EvmChainConfig` in `src/chains/evm/chains.ts`, run `npm run verify:evm`, enable it in `EVM_CHAINS`.
Non-EVM chains get their own adapter implementing `Adapter` from `src/core/adapter.ts`.
