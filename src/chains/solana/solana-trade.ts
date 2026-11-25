import { classifySwap, type ClassifyResult, type QuoteDelta, type TokenDelta } from '../../trades/classify.ts';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS: Readonly<Record<string, string>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};
const LAMPORTS_PER_SOL = 1_000_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface TokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

/** The parts of a jsonParsed getTransaction result this module reads. */
export interface ParsedSolanaTx {
  readonly blockTime: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly fee: number;
    readonly preBalances: readonly number[];
    readonly postBalances: readonly number[];
    readonly preTokenBalances?: readonly TokenBalance[];
    readonly postTokenBalances?: readonly TokenBalance[];
  } | null;
  readonly transaction: {
    readonly signatures: readonly string[];
    readonly message: { readonly accountKeys: ReadonlyArray<{ readonly pubkey: string; readonly signer?: boolean }> };
  };
}

function uiAmount(raw: string, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

/** Net token change per mint for accounts owned by the wallet. */
function tokenChanges(tx: ParsedSolanaTx, wallet: string): Map<string, number> {
  const changes = new Map<string, number>();
  const apply = (balances: readonly TokenBalance[] | undefined, sign: 1 | -1): void => {
    for (const b of balances ?? []) {
      // Decimals 0 means an NFT-style asset, not a fungible meme token.
      if (b.owner !== wallet || b.uiTokenAmount.decimals === 0) continue;
      changes.set(b.mint, (changes.get(b.mint) ?? 0) + sign * uiAmount(b.uiTokenAmount.amount, b.uiTokenAmount.decimals));
    }
  };
  apply(tx.meta?.postTokenBalances, 1);
  apply(tx.meta?.preTokenBalances, -1);
  return changes;
}

/**
 * The wallet's balance changes in one transaction, split into quote assets (SOL incl. WSOL,
 * USDC, USDT) and other tokens. Network fees paid by the wallet are excluded from SOL.
 */
export function solanaBalanceDeltas(tx: ParsedSolanaTx, wallet: string): { quotes: QuoteDelta[]; tokens: TokenDelta[] } | null {
  const meta = tx.meta;
  if (!meta || meta.err !== null) return null;
  const keys = tx.transaction.message.accountKeys;
  const index = keys.findIndex((k) => k.pubkey === wallet);
  if (index < 0) return null;

  const feeBack = index === 0 ? meta.fee : 0;
  const lamports = (meta.postBalances[index] ?? 0) - (meta.preBalances[index] ?? 0) + feeBack;
  const changes = tokenChanges(tx, wallet);
  const sol = lamports / LAMPORTS_PER_SOL + (changes.get(WSOL_MINT) ?? 0);

  const quotes: QuoteDelta[] = [{ symbol: 'SOL', amount: sol, stable: false }];
  const tokens: TokenDelta[] = [];
  for (const [mint, amount] of changes) {
    if (mint === WSOL_MINT) continue;
    const stable = STABLE_MINTS[mint];
    if (stable) quotes.push({ symbol: stable, amount, stable: true });
    else tokens.push({ token: mint, amount });
  }
  return { quotes, tokens };
}

/** Rent deposit of one SPL token account (165 bytes): 2,039,280 lamports. */
const TOKEN_ACCOUNT_RENT_SOL = 0.00203928;

export function classifySolanaTx(tx: ParsedSolanaTx, wallet: string): ClassifyResult {
  const deltas = solanaBalanceDeltas(tx, wallet);
  if (!deltas) return { ok: false, reason: 'failed tx or wallet not in tx' };
  const result = classifySwap(deltas.quotes, deltas.tokens);
  // Closing an emptied token account refunds exactly its rent; opening one costs it. Neither is a trade.
  if (result.ok && result.trade.quoteSymbol === 'SOL' && Math.abs(result.trade.quoteAmount - TOKEN_ACCOUNT_RENT_SOL) < 0.000001) {
    return { ok: false, reason: 'token account rent only (open/close), not a trade' };
  }
  return result;
}

/** Signatures of the wallet newer than `until` (newest first), for backfilling after a gap. */
export async function fetchSignaturesSince(rpcUrl: string, wallet: string, until: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const response = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [wallet, { until, limit: 100, commitment: 'confirmed' }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = (await response.json()) as { result?: Array<{ signature: string; err: unknown }>; error?: { message?: string } };
  if (body.error) throw new Error(`RPC error: ${body.error.message ?? 'unknown'}`);
  return (body.result ?? []).filter((s) => s.err === null).map((s) => s.signature);
}

export class RpcRateLimitError extends Error {}

/** getTransaction (jsonParsed). Returns null while the transaction is not yet available. */
export async function fetchParsedTransaction(rpcUrl: string, signature: string, fetchFn: typeof fetch = fetch): Promise<ParsedSolanaTx | null> {
  const response = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1, encoding: 'jsonParsed' }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429) throw new RpcRateLimitError('RPC HTTP 429');
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = (await response.json()) as { result?: ParsedSolanaTx | null; error?: { message?: string } };
  if (body.error) {
    const message = body.error.message ?? 'unknown';
    if (/too many requests|rate limit/i.test(message)) throw new RpcRateLimitError(message);
    throw new Error(`RPC error: ${message}`);
  }
  return body.result ?? null;
}
