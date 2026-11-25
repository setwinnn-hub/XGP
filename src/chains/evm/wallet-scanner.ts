import type { Address, Hash, PublicClient, Transaction } from 'viem';
import { errorMessage, type Logger } from '../../core/logger.ts';
import { sleep } from '../../core/util.ts';
import { isStable } from '../../enrich/prices.ts';
import { classifySwap, type ClassifiedTrade, type QuoteDelta, type TokenDelta } from '../../trades/classify.ts';
import type { TradeContext } from '../../trades/trade-sink.ts';
import type { WalletRegistry } from '../../wallets/wallet-registry.ts';
import type { TrackedWallet } from '../../wallets/wallet-repo.ts';
import { ERC20_METADATA_ABI } from './abis.ts';
import { nextBlockRange } from './block-range.ts';
import type { EvmChainConfig } from './chains.ts';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NATIVE = '0x0000000000000000000000000000000000000000';
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** Full blocks are heavy; after an outage only the most recent ones are re-read. */
const MAX_WALLET_BLOCKS = 30n;
const DECODER = 'evm-block';
const MAX_BLOCK_ATTEMPTS = 4;
const TOKEN_INFO_LIMIT = 5_000;

export interface TokenInfo {
  readonly decimals: number;
  readonly symbol: string | null;
  readonly name: string | null;
}

interface ReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

function topicAddress(topic: string | undefined): string | null {
  return topic && topic.length === 66 ? `0x${topic.slice(26)}`.toLowerCase() : null;
}

/** Net raw ERC-20 change per token contract for the wallet, from Transfer logs. */
export function transferDeltas(logs: readonly ReceiptLog[], wallet: string): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  for (const log of logs) {
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3 || log.data.length < 3) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    const value = BigInt(log.data.slice(0, 66));
    const token = log.address.toLowerCase();
    if (from === wallet) deltas.set(token, (deltas.get(token) ?? 0n) - value);
    if (to === wallet) deltas.set(token, (deltas.get(token) ?? 0n) + value);
  }
  return deltas;
}

/**
 * Splits the wallet's changes into quote legs (native coin merged with its wrapped
 * token, stablecoins) and other tokens. nativeWei already excludes gas.
 */
export function evmBalanceDeltas(
  chain: EvmChainConfig,
  nativeWei: bigint,
  rawDeltas: ReadonlyMap<string, bigint>,
  info: ReadonlyMap<string, TokenInfo>,
): { quotes: QuoteDelta[]; tokens: TokenDelta[] } {
  const nativeSymbol = chain.quoteTokens[NATIVE] ?? 'ETH';
  let native = Number(nativeWei) / 1e18;
  const quotes: QuoteDelta[] = [];
  const tokens: TokenDelta[] = [];
  for (const [token, raw] of rawDeltas) {
    if (raw === 0n) continue;
    const decimals = info.get(token)?.decimals ?? 18;
    const amount = Number(raw) / 10 ** decimals;
    const quoteSymbol = chain.quoteTokens[token];
    if (quoteSymbol && isStable(quoteSymbol)) quotes.push({ symbol: quoteSymbol, amount, stable: true });
    else if (quoteSymbol) native += amount; // WETH / WBNB count as the native coin
    else tokens.push({ token, amount });
  }
  return { quotes: [{ symbol: nativeSymbol, amount: native, stable: false }, ...quotes], tokens };
}

export interface EvmWalletScannerDeps {
  readonly chain: EvmChainConfig;
  readonly logger: Logger;
  readonly registry: WalletRegistry;
  readonly sink: (trade: ClassifiedTrade, context: TradeContext) => Promise<void>;
}

export interface EvmWalletScanner {
  /** Called for every new head; scans new blocks for transactions sent by followed wallets. */
  onHead(client: PublicClient, head: bigint): void;
}

/**
 * Follows EVM wallets by reading each new block and picking transactions the wallet sent.
 * Free public endpoints refuse address-less log queries, so this is the portable method.
 * It sees trades the wallet signs itself, which is how normal and bot-assisted trading works.
 */
export function createEvmWalletScanner(deps: EvmWalletScannerDeps): EvmWalletScanner {
  const { chain } = deps;
  const logger = deps.logger.child({ source: `evm:${chain.id}:wallets` });
  let wallets: ReadonlyMap<string, TrackedWallet> = new Map();
  let lastProcessed: bigint | null = null;
  let latestHead: bigint | null = null;
  let scanning = false;
  const tokenInfo = new Map<string, TokenInfo>();
  const blockFailures = new Map<bigint, number>();

  deps.registry.onChange(chain.id, (next) => {
    wallets = next;
    if (next.size === 0) lastProcessed = null;
  });

  const loadTokenInfo = async (client: PublicClient, tokens: readonly string[]): Promise<void> => {
    const missing = tokens.filter((t) => !tokenInfo.has(t));
    if (missing.length === 0) return;
    const calls = missing.flatMap((t) => (['decimals', 'symbol', 'name'] as const).map((functionName) => ({ address: t as Address, abi: ERC20_METADATA_ABI, functionName })));
    const results = await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: calls });
    missing.forEach((token, i) => {
      const [d, s, n] = [results[i * 3], results[i * 3 + 1], results[i * 3 + 2]];
      // Never cache a guessed decimals value: a wrong one would mis-size every later trade.
      if (d?.status !== 'success') return;
      tokenInfo.set(token, {
        decimals: Number(d.result),
        symbol: s?.status === 'success' && typeof s.result === 'string' ? s.result.slice(0, 40) : null,
        name: n?.status === 'success' && typeof n.result === 'string' ? n.result.slice(0, 80) : null,
      });
      if (tokenInfo.size > TOKEN_INFO_LIMIT) tokenInfo.delete(tokenInfo.keys().next().value ?? token);
    });
    const unknown = tokens.filter((t) => !tokenInfo.has(t));
    if (unknown.length > 0) throw new Error(`decimals() unavailable for ${unknown.join(', ')}`);
  };

  const nativeDelta = async (client: PublicClient, wallet: Address, block: bigint, gasWei: bigint): Promise<bigint> => {
    const [after, before] = await Promise.all([
      client.getBalance({ address: wallet, blockNumber: block }),
      client.getBalance({ address: wallet, blockNumber: block - 1n }),
    ]);
    return after - before + gasWei;
  };

  const processTx = async (
    client: PublicClient, tx: Transaction, wallet: TrackedWallet,
    block: { readonly timeMs: number; readonly seenAt: number }, sameBlockTxs: number,
  ): Promise<void> => {
    const receipt = await client.getTransactionReceipt({ hash: tx.hash as Hash });
    if (receipt.status !== 'success') return;
    const l1Fee = (receipt as { l1Fee?: bigint | null }).l1Fee ?? 0n;
    const gasWei = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee;
    // With several txs from one wallet in a block, balance diffs mix them: fall back to tx.value.
    // That misses native coin paid back by a router, so such sells may be skipped (logged).
    if (sameBlockTxs > 1) logger.warn('several txs from one wallet in a block; native amount from tx.value only', { tx: tx.hash });
    const native = sameBlockTxs > 1 ? -tx.value : await nativeDelta(client, wallet.address as Address, receipt.blockNumber, gasWei);
    const raw = transferDeltas(receipt.logs, wallet.address);
    await loadTokenInfo(client, [...raw.keys()]);
    const deltas = evmBalanceDeltas(chain, native, raw, tokenInfo);
    const result = classifySwap(deltas.quotes, deltas.tokens);
    if (!result.ok) return logger.debug('not a swap', { tx: tx.hash, reason: result.reason });
    const info = tokenInfo.get(result.trade.token);
    await deps.sink(result.trade, {
      chain: chain.id, wallet, txHash: tx.hash, detectedAt: block.seenAt, decoder: DECODER, venue: null,
      tokenName: info?.name ?? null, tokenSymbol: info?.symbol ?? null, chainTimeMs: block.timeMs,
    });
  };

  const scanBlock = async (client: PublicClient, number: bigint): Promise<void> => {
    // A load-balanced RPC may announce a head before every node has the block: retry once.
    const block = await client.getBlock({ blockNumber: number, includeTransactions: true })
      .catch(async () => { await sleep(1_500); return client.getBlock({ blockNumber: number, includeTransactions: true }); });
    const timing = { timeMs: Number(block.timestamp) * 1000, seenAt: Date.now() };
    const mine = block.transactions.filter((tx) => wallets.has(tx.from.toLowerCase()));
    const perWallet = new Map<string, number>();
    for (const tx of mine) perWallet.set(tx.from.toLowerCase(), (perWallet.get(tx.from.toLowerCase()) ?? 0) + 1);
    // Any failure rejects, so the block is retried (the trade key makes repeats harmless).
    await Promise.all(mine.map((tx) => {
      const wallet = wallets.get(tx.from.toLowerCase());
      return wallet ? processTx(client, tx, wallet, timing, perWallet.get(wallet.address) ?? 1) : Promise.resolve();
    }));
  };

  /** Retries a failing block a few times, then gives up on it so one bad block cannot stall the cursor. */
  const scanBlockWithRetry = async (client: PublicClient, number: bigint): Promise<void> => {
    try {
      await scanBlock(client, number);
      blockFailures.delete(number);
    } catch (error: unknown) {
      const failures = (blockFailures.get(number) ?? 0) + 1;
      if (failures < MAX_BLOCK_ATTEMPTS) {
        blockFailures.set(number, failures);
        throw error;
      }
      blockFailures.delete(number);
      logger.error('giving up on block after retries; wallet trades in it may be missing', { block: number.toString(), error: errorMessage(error) });
    }
  };

  const scan = async (client: PublicClient): Promise<void> => {
    if (scanning) return;
    scanning = true;
    try {
      while (latestHead !== null && wallets.size > 0) {
        const range = nextBlockRange(lastProcessed, latestHead, MAX_WALLET_BLOCKS);
        if (!range) break;
        if (range.skipped > 0n) logger.warn('wallet scan skipped blocks after outage', { skipped: Number(range.skipped) });
        for (let n = range.from; n <= range.to; n += 1n) {
          await scanBlockWithRetry(client, n);
          lastProcessed = n;
        }
      }
    } catch (error: unknown) {
      logger.warn('wallet block scan failed, will retry', { error: errorMessage(error) });
    } finally {
      scanning = false;
    }
  };

  return {
    onHead(client, head) {
      if (wallets.size === 0) return;
      if (latestHead === null || head > latestHead) latestHead = head;
      void scan(client);
    },
  };
}
