import type { EvmChainId } from '../chains/evm/chains.ts';

/** 'offchain' is for events that belong to no chain: news and trend signals. */
export type ChainId = 'solana' | EvmChainId | 'offchain';

export type EventKind = 'token_launched' | 'token_migrated' | 'pair_created' | 'wallet_trade' | 'news' | 'trending' | 'analysis';

export type DetailValue = string | number | boolean | null;

export interface EventLink {
  readonly label: string;
  readonly url: string;
}

/**
 * One normalized market event. Every chain adapter turns its raw data into this shape,
 * so storage, filtering and alerts never depend on a specific chain or provider.
 */
export interface RadarEvent {
  /** Stable unique key used for de-duplication (e.g. "solana:create:<mint>"). */
  readonly key: string;
  readonly kind: EventKind;
  readonly chain: ChainId;
  /** Where the event came from, e.g. "pumpportal" or "base:Uniswap V4". */
  readonly source: string;
  readonly tokenAddress: string;
  readonly tokenName: string | null;
  readonly tokenSymbol: string | null;
  readonly txHash: string;
  /** Local clock (ms since epoch) when the adapter received the event. */
  readonly detectedAt: number;
  /** Chain-specific facts shown in alerts and stored as JSON. Never invented. */
  readonly details: Readonly<Record<string, DetailValue>>;
  readonly links: readonly EventLink[];
}

export type DeliveryStatus = 'sent' | 'dry_run' | 'filtered' | 'failed' | 'dropped';
