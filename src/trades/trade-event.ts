import type { ChainId, EventLink, RadarEvent } from '../core/types.ts';
import type { TradeSide } from './classify.ts';

export interface WalletTrade {
  readonly chain: ChainId;
  readonly wallet: string;
  readonly walletLabel: string | null;
  readonly side: TradeSide;
  readonly token: string;
  readonly tokenName: string | null;
  readonly tokenSymbol: string | null;
  readonly tokenAmount: number;
  readonly quoteSymbol: string;
  readonly quoteAmount: number;
  /** Null when no reliable price was available. Never estimated from nothing. */
  readonly usdValue: number | null;
  readonly txHash: string;
  readonly detectedAt: number;
  /** Which decoder produced the trade, e.g. "pumpportal", "solana-rpc", "evm-block". */
  readonly decoder: string;
  readonly venue: string | null;
}

export interface ExplorerUrls {
  readonly tx: string;
  readonly address: string;
  readonly dexscreener: string;
}

export function explorerUrls(chain: ChainId, explorerTxUrl: string | null): ExplorerUrls {
  if (chain === 'solana') {
    return { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/', dexscreener: 'https://dexscreener.com/solana/' };
  }
  const tx = explorerTxUrl ?? 'https://etherscan.io/tx/';
  const slug = chain === 'bsc' ? 'bsc' : chain;
  return { tx, address: tx.replace('/tx/', '/address/'), dexscreener: `https://dexscreener.com/${slug}/` };
}

/** Same trade seen by two decoders (e.g. PumpPortal and RPC) gets the same key. */
export function tradeKey(chain: ChainId, txHash: string, wallet: string): string {
  return `${chain}:trade:${txHash}:${wallet}`;
}

export function toTradeEvent(trade: WalletTrade, urls: ExplorerUrls): RadarEvent {
  const links: EventLink[] = [
    { label: 'DexScreener', url: `${urls.dexscreener}${trade.token}` },
    { label: 'Transaction', url: `${urls.tx}${trade.txHash}` },
    { label: 'Wallet', url: `${urls.address}${trade.wallet}` },
  ];
  return {
    key: tradeKey(trade.chain, trade.txHash, trade.wallet),
    kind: 'wallet_trade',
    chain: trade.chain,
    source: trade.decoder,
    tokenAddress: trade.token,
    tokenName: trade.tokenName,
    tokenSymbol: trade.tokenSymbol,
    txHash: trade.txHash,
    detectedAt: trade.detectedAt,
    details: {
      wallet: trade.wallet,
      walletLabel: trade.walletLabel,
      side: trade.side,
      tokenAmount: trade.tokenAmount,
      quoteSymbol: trade.quoteSymbol,
      quoteAmount: trade.quoteAmount,
      usdValue: trade.usdValue,
      venue: trade.venue,
    },
    links,
  };
}
