import type { ClassifiedTrade } from './classify.ts';
import type { PriceBook } from '../enrich/prices.ts';
import type { NameLookup } from '../enrich/token-names.ts';
import type { ChainId } from '../core/types.ts';
import type { TrackedWallet } from '../wallets/wallet-repo.ts';
import type { WalletTrade } from './trade-event.ts';

export interface TradeContext {
  readonly chain: ChainId;
  readonly wallet: TrackedWallet;
  readonly txHash: string;
  readonly detectedAt: number;
  readonly decoder: string;
  readonly venue: string | null;
  /** Known name/symbol (e.g. from on-chain metadata); looked up when absent. */
  readonly tokenName?: string | null;
  readonly tokenSymbol?: string | null;
  /** On-chain time in ms when the decoder already knows it. */
  readonly chainTimeMs?: number | null;
}

export interface TradeSinkDeps {
  readonly prices: PriceBook;
  readonly nameLookup: NameLookup;
  /** Hands the finished trade to the pipeline (ingest + alert). */
  readonly emit: (trade: WalletTrade, chainTimeMs: number | null) => void;
}

/** Longest a trade alert waits for a token name; after that it goes out without one. */
const NAME_WAIT_MS = 400;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Shared last step of every wallet decoder: add name and USD value, then emit. */
export function createTradeSink(deps: TradeSinkDeps): (trade: ClassifiedTrade, context: TradeContext) => Promise<void> {
  return async (trade, context) => {
    const known = context.tokenName || context.tokenSymbol;
    // Speed first: the lookup keeps running and caches its result for the next alert.
    const looked = known ? null : await withDeadline(deps.nameLookup(context.chain, trade.token), NAME_WAIT_MS);
    deps.emit(
      {
        chain: context.chain,
        wallet: context.wallet.address,
        walletLabel: context.wallet.label,
        side: trade.side,
        token: trade.token,
        tokenName: context.tokenName ?? looked?.name ?? null,
        tokenSymbol: context.tokenSymbol ?? looked?.symbol ?? null,
        tokenAmount: trade.tokenAmount,
        quoteSymbol: trade.quoteSymbol,
        quoteAmount: trade.quoteAmount,
        usdValue: deps.prices.usdValue(trade.quoteSymbol, trade.quoteAmount),
        txHash: context.txHash,
        detectedAt: context.detectedAt,
        decoder: context.decoder,
        venue: context.venue,
      },
      context.chainTimeMs ?? null,
    );
  };
}
