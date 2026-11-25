import type { RadarEvent } from '../src/core/types.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';

/** Real PumpPortal messages captured from the live stream on 2026-11-25. */
export const LIVE_CREATE_MESSAGE = JSON.stringify({
  signature: '2FkreAUPuDUhjRFPE8C6um3d1HjbALpUosaY4JuHiA1TzTUPruHtheuYYPqrHXjj1eRVYhNxxTJtT1CM7D4JYr2g',
  mint: 'GwytBanGx9eS55TpbG3w6veLtT8PKRcs3SXiS7nFpump',
  traderPublicKey: 'v5QivFWoCjBY3VQJ7SLsHJbBqEw2jT1WepjmwHu6cMZ',
  txType: 'create',
  initialBuy: 3520918.746848,
  solAmount: 0.098765431,
  bondingCurveKey: 'HriiJnAAw7xdqBpau8Hr9iVUNNPDKBfQeLTSdotYkef1',
  vTokensInBondingCurve: 1069479081.253152,
  vSolInBondingCurve: 30.09876543099999,
  marketCapSol: 28.14338864462131,
  name: 'Doomed Rocket',
  symbol: 'DOOROC',
  uri: 'https://ipfs.io/ipfs/QmNxmVJ9pke8guDzc8M18mTzSpM5drnUx52ct5i6q7Fxsx',
  is_mayhem_mode: true,
  pool: 'pump',
});

export const LIVE_MIGRATE_MESSAGE = JSON.stringify({
  signature: '4dHbgR7kNeYy2JeRiVTMQH7M9E8LAmgCZGbJLbKCBpCBDKgxSp7XwJr9VYpW9U66NMB9QbYZtMNXjmByeNnudq7s',
  mint: 'Ch6GryQYtGUSqcNwRY6eqMgxbkSLb2pozaNjSw31pump',
  txType: 'migrate',
  pool: 'pump-amm',
});

export const WEBHOOK_URL = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_123-xyz';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ DB_PATH: ':memory:', ...overrides });
}

export function makeEvent(overrides: Partial<RadarEvent> = {}): RadarEvent {
  return {
    key: 'solana:create:Mint111',
    kind: 'token_launched',
    chain: 'solana',
    source: 'pumpportal',
    tokenAddress: 'GwytBanGx9eS55TpbG3w6veLtT8PKRcs3SXiS7nFpump',
    tokenName: 'Doomed Rocket',
    tokenSymbol: 'DOOROC',
    txHash: 'sig111',
    detectedAt: 1_795_559_033_844,
    details: { platform: 'Pump.fun', devBuySol: 3, marketCapSol: 30 },
    links: [{ label: 'Pump.fun', url: 'https://pump.fun/coin/x' }],
    ...overrides,
  };
}

/** Builds a fetch stub that replays the given responses in order and records requests. */
export function fetchStub(responses: ReadonlyArray<() => Response>): { fn: typeof fetch; calls: Array<{ url: string; body: string | null }> } {
  const calls: Array<{ url: string; body: string | null }> = [];
  let index = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : null });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error('no stub response');
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
