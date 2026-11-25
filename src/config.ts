import { EVM_CHAINS, type EvmChainConfig, type EvmChainId } from './chains/evm/chains.ts';

export const ALERT_CATEGORIES = [
  'NEW_TOKEN',
  'SMART_MONEY_BUY',
  'SMART_MONEY_SELL',
  'WHALE',
  'BREAKING_NEWS',
  'TRENDING',
  'HIGH_OPPORTUNITY',
  'HIGH_RISK',
  'SYSTEM',
  'VIRAL',
] as const;

export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export type PumpNewTokenMode = 'all' | 'filtered' | 'off';

export interface PumpfunConfig {
  readonly newTokenMode: PumpNewTokenMode;
  /** In 'filtered' mode a launch alerts when the creator's first buy is at least this many SOL... */
  readonly minDevBuySol: number;
  /** ...or when its name/symbol contains one of these keywords (lower-case). */
  readonly keywords: readonly string[];
  readonly alertMigrations: boolean;
}

export interface AppConfig {
  readonly dbPath: string;
  readonly logDir: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly webhooks: Readonly<Partial<Record<AlertCategory, string>>>;
  /** Used by every category that has no webhook of its own. */
  readonly defaultWebhook: string | null;
  /** Trades at or above this USD value are flagged as whale trades. */
  readonly whaleUsd: number;
  /** Trades below this USD value are stored but not alerted (0 = alert everything). */
  readonly minTradeUsd: number;
  readonly solanaWsUrl: string;
  readonly news: {
    readonly enabled: boolean;
    /** Headlines older than this when first seen are stored but never alerted. */
    readonly maxAgeMin: number;
    /** CoinGecko trending: skip coins with a market-cap rank this high or better. */
    readonly trendingMinRank: number;
  };
  readonly analysis: {
    readonly enabled: boolean;
    readonly delaysMin: readonly number[];
    readonly minOpportunity: number;
  };
  /** Follow Solana wallets via RPC. Needs a non-public RPC (e.g. Helius) to keep up. */
  readonly solanaWalletTracking: boolean;
  /** Optional funded PumpPortal key; enables the Pump.fun account-trade fast path. */
  readonly pumpPortalApiKey: string | null;
  readonly pumpfun: PumpfunConfig;
  readonly evmChains: readonly EvmChainConfig[];
  /** Alert only on new EVM pairs where one side is a known quote token (WETH, WBNB, USDC...). */
  readonly evmQuotePairsOnly: boolean;
  readonly solanaRpcUrl: string;
  /** Share of events whose on-chain time is looked up to measure latency (0..1). */
  readonly latencySampleRate: number;
  readonly maxQueuePerWebhook: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const WEBHOOK_PATTERN = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

function readNumber(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`${key} must be true or false, got "${raw}"`);
}

function readEnum<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  const match = allowed.find((value) => value === raw);
  if (!match) throw new Error(`${key} must be one of ${allowed.join(', ')}, got "${raw}"`);
  return match;
}

function readList(env: Env, key: string, fallback: readonly string[]): readonly string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.split(',').map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
}

function readWebhooks(env: Env): Partial<Record<AlertCategory, string>> {
  const entries = ALERT_CATEGORIES.flatMap((category) => {
    const url = env[`DISCORD_WEBHOOK_${category}`]?.trim();
    if (!url) return [];
    if (!WEBHOOK_PATTERN.test(url)) {
      throw new Error(`DISCORD_WEBHOOK_${category} is not a Discord webhook URL`);
    }
    return [[category, url] as const];
  });
  return Object.fromEntries(entries);
}

function readDefaultWebhook(env: Env): string | null {
  const url = env.DISCORD_WEBHOOK_DEFAULT?.trim();
  if (!url) return null;
  if (!WEBHOOK_PATTERN.test(url)) throw new Error('DISCORD_WEBHOOK_DEFAULT is not a Discord webhook URL');
  return url;
}

function readDelays(env: Env): readonly number[] {
  const delays = readList(env, 'ANALYSIS_DELAYS_MIN', ['2', '15']).map(Number);
  if (delays.length === 0 || delays.some((d) => !Number.isFinite(d) || d < 0 || d > 24 * 60)) {
    throw new Error('ANALYSIS_DELAYS_MIN must be comma-separated minutes, e.g. 2,15');
  }
  return delays;
}

function readSolanaWsUrl(env: Env, rpcUrl: string): string {
  const explicit = env.SOLANA_WS_URL?.trim();
  if (explicit) return explicit;
  return rpcUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

function readEvmChains(env: Env): readonly EvmChainConfig[] {
  const ids = readList(env, 'EVM_CHAINS', EVM_CHAINS.map((chain) => chain.id));
  return ids.map((id) => {
    const chain = EVM_CHAINS.find((candidate) => candidate.id === id);
    if (!chain) throw new Error(`EVM_CHAINS contains unknown chain "${id}"`);
    return chain;
  });
}

function envKey(id: EvmChainId, kind: 'WS' | 'HTTP'): string {
  return `EVM_${id.toUpperCase()}_${kind}_URL`;
}

export function wsUrlFor(chain: EvmChainConfig, env: Env = process.env): string {
  return env[envKey(chain.id, 'WS')]?.trim() || chain.defaultWsUrl;
}

export function httpUrlFor(chain: EvmChainConfig, env: Env = process.env): string {
  return env[envKey(chain.id, 'HTTP')]?.trim() || chain.defaultHttpUrl;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const solanaRpcUrl = env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
  return {
    dbPath: env.DB_PATH?.trim() || 'data/radar.db',
    logDir: env.LOG_DIR?.trim() || 'logs',
    logLevel: readEnum(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info'),
    webhooks: readWebhooks(env),
    defaultWebhook: readDefaultWebhook(env),
    whaleUsd: readNumber(env, 'WHALE_USD', 10_000, 0, 1e12),
    minTradeUsd: readNumber(env, 'MIN_TRADE_USD', 0, 0, 1e12),
    solanaWsUrl: readSolanaWsUrl(env, solanaRpcUrl),
    news: {
      enabled: readBool(env, 'NEWS_ENABLED', true),
      maxAgeMin: readNumber(env, 'NEWS_MAX_AGE_MIN', 120, 5, 7 * 24 * 60),
      trendingMinRank: readNumber(env, 'TRENDING_MIN_RANK', 100, 0, 100_000),
    },
    analysis: {
      enabled: readBool(env, 'ANALYSIS_ENABLED', true),
      delaysMin: readDelays(env),
      minOpportunity: readNumber(env, 'MIN_OPPORTUNITY_SCORE', 70, 0, 100),
    },
    solanaWalletTracking: readBool(env, 'SOLANA_WALLET_TRACKING', false),
    pumpPortalApiKey: env.PUMPPORTAL_API_KEY?.trim() || null,
    pumpfun: {
      newTokenMode: readEnum(env, 'PUMPFUN_NEW_TOKEN_ALERTS', ['all', 'filtered', 'off'], 'filtered'),
      minDevBuySol: readNumber(env, 'PUMPFUN_MIN_DEV_BUY_SOL', 2, 0, 10_000),
      keywords: readList(env, 'PUMPFUN_KEYWORDS', []),
      alertMigrations: readBool(env, 'PUMPFUN_MIGRATION_ALERTS', true),
    },
    evmChains: readEvmChains(env),
    evmQuotePairsOnly: readBool(env, 'EVM_QUOTE_PAIRS_ONLY', true),
    solanaRpcUrl,
    latencySampleRate: readNumber(env, 'LATENCY_SAMPLE_RATE', 0.25, 0, 1),
    maxQueuePerWebhook: readNumber(env, 'MAX_QUEUE_PER_WEBHOOK', 200, 10, 10_000),
  };
}
