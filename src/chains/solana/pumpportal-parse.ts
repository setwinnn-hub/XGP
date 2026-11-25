import type { RadarEvent } from '../../core/types.ts';

export const PUMPPORTAL_SOURCE = 'pumpportal';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

type Raw = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(raw: Raw, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(raw: Raw, key: string): number | null {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function solanaLinks(mint: string, signature: string): RadarEvent['links'] {
  return [
    { label: 'Pump.fun', url: `https://pump.fun/coin/${mint}` },
    { label: 'DexScreener', url: `https://dexscreener.com/solana/${mint}` },
    { label: 'Solscan TX', url: `https://solscan.io/tx/${signature}` },
  ];
}

function toCreate(raw: Raw, mint: string, signature: string, receivedAt: number): RadarEvent {
  return {
    key: `solana:create:${mint}`,
    kind: 'token_launched',
    chain: 'solana',
    source: PUMPPORTAL_SOURCE,
    tokenAddress: mint,
    tokenName: str(raw, 'name'),
    tokenSymbol: str(raw, 'symbol'),
    txHash: signature,
    detectedAt: receivedAt,
    details: {
      platform: 'Pump.fun',
      creator: str(raw, 'traderPublicKey'),
      devBuySol: num(raw, 'solAmount'),
      devBuyTokens: num(raw, 'initialBuy'),
      marketCapSol: num(raw, 'marketCapSol'),
      metadataUri: str(raw, 'uri'),
      mayhemMode: typeof raw.is_mayhem_mode === 'boolean' ? raw.is_mayhem_mode : null,
    },
    links: solanaLinks(mint, signature),
  };
}

function toMigration(raw: Raw, mint: string, signature: string, receivedAt: number): RadarEvent {
  return {
    key: `solana:migrate:${mint}`,
    kind: 'token_migrated',
    chain: 'solana',
    source: PUMPPORTAL_SOURCE,
    tokenAddress: mint,
    tokenName: null,
    tokenSymbol: null,
    txHash: signature,
    detectedAt: receivedAt,
    details: { platform: 'Pump.fun', migratedTo: str(raw, 'pool') },
    links: solanaLinks(mint, signature),
  };
}

/** A buy/sell by a followed wallet, from subscribeAccountTrade. */
export interface PumpAccountTrade {
  readonly signature: string;
  readonly mint: string;
  readonly trader: string;
  readonly side: 'BUY' | 'SELL';
  readonly tokenAmount: number;
  readonly solAmount: number;
  readonly marketCapSol: number | null;
  readonly pool: string | null;
}

function toAccountTrade(raw: Raw, mint: string, signature: string): PumpParseResult {
  const trader = str(raw, 'traderPublicKey');
  const tokenAmount = num(raw, 'tokenAmount');
  const solAmount = num(raw, 'solAmount');
  if (!trader || tokenAmount === null || solAmount === null) return { type: 'ignored', reason: 'trade without trader/amounts' };
  return {
    type: 'trade',
    trade: {
      signature, mint, trader,
      side: raw.txType === 'buy' ? 'BUY' : 'SELL',
      tokenAmount, solAmount,
      marketCapSol: num(raw, 'marketCapSol'),
      pool: str(raw, 'pool'),
    },
  };
}

export type PumpParseResult =
  | { readonly type: 'event'; readonly event: RadarEvent }
  | { readonly type: 'trade'; readonly trade: PumpAccountTrade }
  | { readonly type: 'control'; readonly message: string }
  | { readonly type: 'ignored'; readonly reason: string };

/** Turns one PumpPortal data-stream message into a normalized event. Never throws. */
export function parsePumpPortalMessage(data: string, receivedAt: number): PumpParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { type: 'ignored', reason: 'invalid JSON' };
  }
  if (!isRecord(raw)) return { type: 'ignored', reason: 'not an object' };
  const control = str(raw, 'message');
  if (control && !raw.txType) return { type: 'control', message: control };

  const mint = str(raw, 'mint');
  const signature = str(raw, 'signature');
  if (!mint || !BASE58.test(mint) || !signature || !BASE58.test(signature)) {
    return { type: 'ignored', reason: 'missing or invalid mint/signature' };
  }
  if (raw.txType === 'create') return { type: 'event', event: toCreate(raw, mint, signature, receivedAt) };
  if (raw.txType === 'migrate') return { type: 'event', event: toMigration(raw, mint, signature, receivedAt) };
  if (raw.txType === 'buy' || raw.txType === 'sell') return toAccountTrade(raw, mint, signature);
  return { type: 'ignored', reason: `unhandled txType ${String(raw.txType)}` };
}
